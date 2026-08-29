/*
 * mDEV_agent - byte transport implementation.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <netdb.h>
#include <poll.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <sys/socket.h>

#ifdef MDEV_WITH_TLS
#include <mbedtls/ctr_drbg.h>
#include <mbedtls/entropy.h>
#include <mbedtls/error.h>
#include <mbedtls/net_sockets.h>
#include <mbedtls/ssl.h>
#include <mbedtls/x509_crt.h>
#endif

#include "net.h"

struct mdev_conn {
	int  fd;
	bool tls;
#ifdef MDEV_WITH_TLS
	mbedtls_ssl_context      ssl;
	mbedtls_ssl_config       conf;
	mbedtls_entropy_context  entropy;
	mbedtls_ctr_drbg_context drbg;
	mbedtls_x509_crt         ca;
	bool                     ssl_ready;
#endif
};

bool mdev_tls_supported(void)
{
#ifdef MDEV_WITH_TLS
	return true;
#else
	return false;
#endif
}

int mdev_conn_fd(const struct mdev_conn *c)
{
	return c ? c->fd : -1;
}

/* Wait for readability/writability; returns 1 ready, 0 timeout, -1 error. */
static int wait_io(int fd, short events, int timeout_ms)
{
	struct pollfd pfd = { .fd = fd, .events = events };

	for (;;) {
		int r = poll(&pfd, 1, timeout_ms);

		if (r < 0 && errno == EINTR)
			continue;
		if (r <= 0)
			return r;
		if (pfd.revents & (POLLERR | POLLNVAL))
			return -1;
		return 1;
	}
}

/* Non-blocking connect() with a timeout, over all resolved addresses. */
static int tcp_connect(const char *host, const char *port, int timeout_ms)
{
	struct addrinfo hints = {
		.ai_family   = AF_UNSPEC,
		.ai_socktype = SOCK_STREAM,
	};
	struct addrinfo *res = NULL, *ai;
	int fd = -1, rc;

	rc = getaddrinfo(host, port, &hints, &res);
	if (rc != 0) {
		log_err("dns: %s:%s: %s", host, port, gai_strerror(rc));
		return -1;
	}

	for (ai = res; ai; ai = ai->ai_next) {
		int flags, err = 0;
		socklen_t elen = sizeof(err);
		int one = 1;

		fd = socket(ai->ai_family, ai->ai_socktype | SOCK_CLOEXEC, ai->ai_protocol);
		if (fd < 0)
			continue;

		flags = fcntl(fd, F_GETFL, 0);
		fcntl(fd, F_SETFL, flags | O_NONBLOCK);

		if (connect(fd, ai->ai_addr, ai->ai_addrlen) == 0)
			goto connected;
		if (errno != EINPROGRESS)
			goto next;
		if (wait_io(fd, POLLOUT, timeout_ms) != 1)
			goto next;
		if (getsockopt(fd, SOL_SOCKET, SO_ERROR, &err, &elen) != 0 || err != 0)
			goto next;

connected:
		/* Back to blocking; every call site supplies its own timeout. */
		fcntl(fd, F_SETFL, flags & ~O_NONBLOCK);
		setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));
		setsockopt(fd, SOL_SOCKET, SO_KEEPALIVE, &one, sizeof(one));
		freeaddrinfo(res);
		return fd;
next:
		close(fd);
		fd = -1;
	}

	freeaddrinfo(res);
	log_err("connect %s:%s failed: %s", host, port,
	        strerror(errno ? errno : ETIMEDOUT));
	return -1;
}

#ifdef MDEV_WITH_TLS
static void tls_free(struct mdev_conn *c)
{
	if (!c->ssl_ready)
		return;
	mbedtls_ssl_free(&c->ssl);
	mbedtls_ssl_config_free(&c->conf);
	mbedtls_x509_crt_free(&c->ca);
	mbedtls_ctr_drbg_free(&c->drbg);
	mbedtls_entropy_free(&c->entropy);
	c->ssl_ready = false;
}

static void tls_log_err(const char *what, int ret)
{
	char buf[128];

	mbedtls_strerror(ret, buf, sizeof(buf));
	log_err("tls: %s: -0x%04x (%s)", what, (unsigned)-ret, buf);
}

static int tls_setup(struct mdev_conn *c, const struct mdev_url *u,
                     const struct mdev_config *cfg)
{
	static const char *pers = AGENT_NAME "/" AGENT_VERSION;
	int ret;

	mbedtls_ssl_init(&c->ssl);
	mbedtls_ssl_config_init(&c->conf);
	mbedtls_x509_crt_init(&c->ca);
	mbedtls_ctr_drbg_init(&c->drbg);
	mbedtls_entropy_init(&c->entropy);
	c->ssl_ready = true;

	ret = mbedtls_ctr_drbg_seed(&c->drbg, mbedtls_entropy_func, &c->entropy,
	                            (const unsigned char *)pers, strlen(pers));
	if (ret != 0) {
		tls_log_err("ctr_drbg_seed", ret);
		return -1;
	}

	ret = mbedtls_ssl_config_defaults(&c->conf, MBEDTLS_SSL_IS_CLIENT,
	                                  MBEDTLS_SSL_TRANSPORT_STREAM,
	                                  MBEDTLS_SSL_PRESET_DEFAULT);
	if (ret != 0) {
		tls_log_err("config_defaults", ret);
		return -1;
	}

	mbedtls_ssl_conf_rng(&c->conf, mbedtls_ctr_drbg_random, &c->drbg);

	if (cfg->tls_verify) {
		if (mbedtls_x509_crt_parse_file(&c->ca, cfg->ca_file) < 0) {
			/* A CA bundle is mandatory when verification is on. */
			log_err("tls: cannot load CA bundle %s "
			        "(install ca-bundle, or set tls_verify 0 to disable)",
			        cfg->ca_file);
			return -1;
		}
		mbedtls_ssl_conf_ca_chain(&c->conf, &c->ca, NULL);
		mbedtls_ssl_conf_authmode(&c->conf, MBEDTLS_SSL_VERIFY_REQUIRED);
	} else {
		log_wrn("tls: certificate verification DISABLED (tls_verify 0)");
		mbedtls_ssl_conf_authmode(&c->conf, MBEDTLS_SSL_VERIFY_NONE);
	}

	ret = mbedtls_ssl_setup(&c->ssl, &c->conf);
	if (ret != 0) {
		tls_log_err("ssl_setup", ret);
		return -1;
	}

	/* SNI + hostname verification. */
	ret = mbedtls_ssl_set_hostname(&c->ssl, u->host);
	if (ret != 0) {
		tls_log_err("set_hostname", ret);
		return -1;
	}

	mbedtls_ssl_set_bio(&c->ssl, &c->fd, mbedtls_net_send, mbedtls_net_recv, NULL);

	while ((ret = mbedtls_ssl_handshake(&c->ssl)) != 0) {
		if (ret == MBEDTLS_ERR_SSL_WANT_READ) {
			if (wait_io(c->fd, POLLIN, cfg->connect_timeout_ms) != 1)
				goto hs_timeout;
			continue;
		}
		if (ret == MBEDTLS_ERR_SSL_WANT_WRITE) {
			if (wait_io(c->fd, POLLOUT, cfg->connect_timeout_ms) != 1)
				goto hs_timeout;
			continue;
		}
		tls_log_err("handshake", ret);
		return -1;
	}

	if (cfg->tls_verify) {
		uint32_t flags = mbedtls_ssl_get_verify_result(&c->ssl);

		if (flags != 0) {
			char vbuf[256];

			mbedtls_x509_crt_verify_info(vbuf, sizeof(vbuf), "  ", flags);
			log_err("tls: certificate verification failed:\n%s", vbuf);
			return -1;
		}
	}

	log_dbg("tls: handshake ok (%s, %s)",
	        mbedtls_ssl_get_version(&c->ssl), mbedtls_ssl_get_ciphersuite(&c->ssl));
	return 0;

hs_timeout:
	log_err("tls: handshake timed out");
	return -1;
}
#endif /* MDEV_WITH_TLS */

struct mdev_conn *mdev_conn_open(const struct mdev_url *u, const struct mdev_config *cfg)
{
	struct mdev_conn *c;

	if (u->tls && !mdev_tls_supported()) {
		log_err("wss:// requested but this build has no TLS support "
		        "(rebuild with MDEV_WITH_TLS=1)");
		return NULL;
	}

	c = calloc(1, sizeof(*c));
	if (!c)
		return NULL;

	c->fd  = tcp_connect(u->host, u->port, cfg->connect_timeout_ms);
	c->tls = u->tls;
	if (c->fd < 0) {
		free(c);
		return NULL;
	}

#ifdef MDEV_WITH_TLS
	if (c->tls && tls_setup(c, u, cfg) != 0) {
		mdev_conn_close(c);
		return NULL;
	}
#endif

	log_dbg("connected to %s://%s:%s", u->tls ? "wss" : "ws", u->host, u->port);
	return c;
}

void mdev_conn_close(struct mdev_conn *c)
{
	if (!c)
		return;
#ifdef MDEV_WITH_TLS
	if (c->tls && c->ssl_ready) {
		mbedtls_ssl_close_notify(&c->ssl);
		tls_free(c);
	}
#endif
	if (c->fd >= 0)
		close(c->fd);
	free(c);
}

bool mdev_conn_pending(const struct mdev_conn *c)
{
#ifdef MDEV_WITH_TLS
	if (c && c->tls && c->ssl_ready)
		return mbedtls_ssl_get_bytes_avail((mbedtls_ssl_context *)&c->ssl) > 0;
#else
	(void)c;
#endif
	return false;
}

int mdev_conn_read(struct mdev_conn *c, void *buf, size_t len, int timeout_ms)
{
	if (!c || c->fd < 0)
		return -1;

#ifdef MDEV_WITH_TLS
	if (c->tls) {
		for (;;) {
			int ret = mbedtls_ssl_read(&c->ssl, buf, len);

			if (ret > 0)
				return ret;
			if (ret == 0 || ret == MBEDTLS_ERR_SSL_PEER_CLOSE_NOTIFY)
				return 0;
			if (ret == MBEDTLS_ERR_SSL_WANT_READ) {
				int w = wait_io(c->fd, POLLIN, timeout_ms);

				if (w == 0) {
					errno = ETIMEDOUT;
					return -1;
				}
				if (w < 0)
					return -1;
				continue;
			}
			if (ret == MBEDTLS_ERR_SSL_WANT_WRITE) {
				if (wait_io(c->fd, POLLOUT, timeout_ms) != 1)
					return -1;
				continue;
			}
			tls_log_err("read", ret);
			return -1;
		}
	}
#endif

	for (;;) {
		ssize_t n;
		int w = wait_io(c->fd, POLLIN, timeout_ms);

		if (w == 0) {
			errno = ETIMEDOUT;
			return -1;
		}
		if (w < 0)
			return -1;

		n = read(c->fd, buf, len);
		if (n >= 0)
			return (int)n;
		if (errno == EINTR || errno == EAGAIN)
			continue;
		return -1;
	}
}

int mdev_conn_write(struct mdev_conn *c, const void *buf, size_t len, int timeout_ms)
{
	const unsigned char *p = buf;
	size_t sent = 0;

	if (!c || c->fd < 0)
		return -1;

	while (sent < len) {
#ifdef MDEV_WITH_TLS
		if (c->tls) {
			int ret = mbedtls_ssl_write(&c->ssl, p + sent, len - sent);

			if (ret > 0) {
				sent += (size_t)ret;
				continue;
			}
			if (ret == MBEDTLS_ERR_SSL_WANT_READ) {
				if (wait_io(c->fd, POLLIN, timeout_ms) != 1)
					return -1;
				continue;
			}
			if (ret == MBEDTLS_ERR_SSL_WANT_WRITE) {
				if (wait_io(c->fd, POLLOUT, timeout_ms) != 1)
					return -1;
				continue;
			}
			tls_log_err("write", ret);
			return -1;
		}
#endif
		{
			ssize_t n;
			int w = wait_io(c->fd, POLLOUT, timeout_ms);

			if (w == 0) {
				errno = ETIMEDOUT;
				return -1;
			}
			if (w < 0)
				return -1;

			n = write(c->fd, p + sent, len - sent);
			if (n > 0) {
				sent += (size_t)n;
				continue;
			}
			if (n < 0 && (errno == EINTR || errno == EAGAIN))
				continue;
			return -1;
		}
	}

	return (int)sent;
}


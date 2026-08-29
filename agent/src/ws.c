/*
 * mDEV_agent - minimal RFC 6455 WebSocket client implementation.
 */
#define _GNU_SOURCE
#include <ctype.h>
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>

#include "sha1.h"
#include "ws.h"

#define WS_GUID "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

#define OP_CONT  0x0
#define OP_TEXT  0x1
#define OP_BIN   0x2
#define OP_CLOSE 0x8
#define OP_PING  0x9
#define OP_PONG  0xa

/* Percent-encode everything outside the URL "unreserved" set. */
static void url_encode(char *dst, size_t dcap, const char *src)
{
	static const char hex[] = "0123456789ABCDEF";
	size_t o = 0;

	for (; *src && o + 4 < dcap; src++) {
		unsigned char ch = (unsigned char)*src;

		if (isalnum(ch) || ch == '-' || ch == '_' || ch == '.' || ch == '~') {
			dst[o++] = (char)ch;
		} else {
			dst[o++] = '%';
			dst[o++] = hex[ch >> 4];
			dst[o++] = hex[ch & 0xf];
		}
	}
	dst[o] = '\0';
}

/* Compute the expected Sec-WebSocket-Accept for a given client key. */
static void ws_accept_for(const char *key, char out[32])
{
	char concat[128];
	uint8_t digest[SHA1_DIGEST_LEN];

	snprintf(concat, sizeof(concat), "%s" WS_GUID, key);
	sha1(concat, strlen(concat), digest);
	base64_encode(digest, sizeof(digest), out, 32);
}

/* Read one CRLF-terminated header line (without the CRLF). */
static int read_line(struct mdev_conn *conn, char *buf, size_t cap, int timeout_ms)
{
	size_t n = 0;

	while (n + 1 < cap) {
		char ch;
		int r = mdev_conn_read(conn, &ch, 1, timeout_ms);

		if (r <= 0)
			return -1;
		if (ch == '\n') {
			if (n && buf[n - 1] == '\r')
				n--;
			buf[n] = '\0';
			return (int)n;
		}
		buf[n++] = ch;
	}
	return -1;
}

int ws_connect(struct ws_client *ws, const struct mdev_config *cfg,
               enum ws_auth_mode mode)
{
	unsigned char nonce[16];
	char key[32], expect[32];
	char path[512];
	char req[1400];
	char line[512];
	char accept_hdr[128] = "";
	int status = 0, len, hdr_count = 0;
	bool upgraded = false;

	memset(ws, 0, sizeof(*ws));
	ws->cfg = cfg;
	ws->msg_opcode = -1;

	if (mdev_url_parse(cfg->server_url, &ws->url) != 0) {
		log_err("invalid server_url: %s", cfg->server_url);
		return -1;
	}

	/*
	 * Install-token mode puts the credential in the query string, exactly
	 * like scripts/fake-agent.js --install-token. hub.js accepts it via
	 * extractToken() and defers verification to the `hello`.
	 */
	if (mode == WS_AUTH_INSTALL_TOKEN) {
		char enc[512];
		int n;

		url_encode(enc, sizeof(enc), cfg->token);
		n = snprintf(path, sizeof(path), "%s%ctoken=%s", ws->url.path,
		             strchr(ws->url.path, '?') ? '&' : '?', enc);
		if (n < 0 || (size_t)n >= sizeof(path)) {
			log_err("token makes path too long");
			return -1;
		}
	} else {
		snprintf(path, sizeof(path), "%s", ws->url.path);
	}

	ws->conn = mdev_conn_open(&ws->url, cfg);
	if (!ws->conn)
		return -1;

	mdev_random(nonce, sizeof(nonce));
	base64_encode(nonce, sizeof(nonce), key, sizeof(key));
	ws_accept_for(key, expect);

	len = snprintf(req, sizeof(req),
	               "GET %s HTTP/1.1\r\n"
	               "Host: %s:%s\r\n"
	               "Upgrade: websocket\r\n"
	               "Connection: Upgrade\r\n"
	               "Sec-WebSocket-Key: %s\r\n"
	               "Sec-WebSocket-Version: 13\r\n"
	               "User-Agent: " AGENT_NAME "/" AGENT_VERSION "\r\n",
	               path, ws->url.host, ws->url.port, key);

	if (mode == WS_AUTH_BEARER)
		len += snprintf(req + len, sizeof(req) - len,
		                "Sec-WebSocket-Protocol: bearer, %s\r\n", cfg->token);

	len += snprintf(req + len, sizeof(req) - len, "\r\n");

	if (len <= 0 || (size_t)len >= sizeof(req)) {
		log_err("handshake request too large (token too long?)");
		goto fail;
	}

	if (mdev_conn_write(ws->conn, req, (size_t)len, cfg->connect_timeout_ms) < 0) {
		log_err("handshake write failed: %s", strerror(errno));
		goto fail;
	}

	/* Status line. */
	if (read_line(ws->conn, line, sizeof(line), cfg->connect_timeout_ms) < 0) {
		log_err("handshake: no response from server");
		goto fail;
	}
	if (sscanf(line, "HTTP/1.%*d %d", &status) != 1) {
		log_err("handshake: malformed status line: %s", line);
		goto fail;
	}
	if (status != 101) {
		log_err("handshake rejected: HTTP %d (%s)", status, line);
		if (status == 401 || status == 403)
			log_err("check router_id/token - the portal refused the upgrade");
		goto fail;
	}

	/* Headers. */
	while (read_line(ws->conn, line, sizeof(line), cfg->connect_timeout_ms) > 0) {
		char *colon = strchr(line, ':');
		char *val;

		if (++hdr_count > 64) {
			log_err("handshake: too many headers");
			goto fail;
		}
		if (!colon)
			continue;
		*colon = '\0';
		val = colon + 1;
		while (*val == ' ' || *val == '\t')
			val++;

		if (!strcasecmp(line, "Upgrade") && !strcasecmp(val, "websocket"))
			upgraded = true;
		else if (!strcasecmp(line, "Sec-WebSocket-Accept"))
			snprintf(accept_hdr, sizeof(accept_hdr), "%s", val);
	}

	if (!upgraded) {
		log_err("handshake: server did not upgrade the connection");
		goto fail;
	}
	if (strcmp(accept_hdr, expect) != 0) {
		log_err("handshake: bad Sec-WebSocket-Accept (got %s, want %s)",
		        accept_hdr, expect);
		goto fail;
	}

	ws->last_rx = ws->last_ping = mdev_now();
	log_inf("websocket established: %s", cfg->server_url);
	return 0;

fail:
	mdev_conn_close(ws->conn);
	ws->conn = NULL;
	return -1;
}

void ws_disconnect(struct ws_client *ws)
{
	if (!ws->conn)
		return;

	if (!ws->closing) {
		/* Best-effort close frame: masked, status 1000. */
		unsigned char frame[8] = { 0x88, 0x82 };

		mdev_random(frame + 2, 4);
		frame[6] = frame[2] ^ 0x03;
		frame[7] = frame[3] ^ 0xe8;
		mdev_conn_write(ws->conn, frame, sizeof(frame), 1000);
		ws->closing = true;
	}

	mdev_conn_close(ws->conn);
	ws->conn = NULL;
}

/* Build and send a single masked client frame (FIN set, no fragmentation). */
static int ws_send_frame(struct ws_client *ws, int opcode, const void *data, size_t len)
{
	unsigned char hdr[14];
	unsigned char mask[4];
	unsigned char *buf;
	size_t hlen = 0, i;
	int rc;

	if (!ws->conn)
		return -1;
	if (len > WS_MAX_PAYLOAD) {
		log_err("outbound frame too large: %zu bytes", len);
		return -1;
	}

	hdr[hlen++] = (unsigned char)(0x80 | opcode);
	if (len < 126) {
		hdr[hlen++] = (unsigned char)(0x80 | len);
	} else {
		hdr[hlen++] = 0x80 | 126;
		hdr[hlen++] = (unsigned char)(len >> 8);
		hdr[hlen++] = (unsigned char)(len & 0xff);
	}

	/* RFC 6455 requires clients to mask with a fresh random key. */
	mdev_random(mask, sizeof(mask));
	memcpy(hdr + hlen, mask, sizeof(mask));
	hlen += sizeof(mask);

	buf = malloc(hlen + len);
	if (!buf)
		return -1;
	memcpy(buf, hdr, hlen);
	for (i = 0; i < len; i++)
		buf[hlen + i] = ((const unsigned char *)data)[i] ^ mask[i & 3];

	rc = mdev_conn_write(ws->conn, buf, hlen + len, 5000);
	free(buf);

	if (rc < 0) {
		log_err("frame write failed: %s", strerror(errno));
		return -1;
	}
	return 0;
}

int ws_send_text(struct ws_client *ws, const char *text)
{
	log_dbg("tx: %s", text);
	return ws_send_frame(ws, OP_TEXT, text, strlen(text));
}

/* Pull more bytes into ws->rx. Returns 1 progress, 0 timeout, -1 closed/error. */
static int rx_fill(struct ws_client *ws, int timeout_ms)
{
	int n;

	if (ws->rx_len >= sizeof(ws->rx)) {
		log_err("receive buffer full; dropping connection");
		return -1;
	}

	n = mdev_conn_read(ws->conn, ws->rx + ws->rx_len,
	                   sizeof(ws->rx) - ws->rx_len, timeout_ms);
	if (n > 0) {
		ws->rx_len += (size_t)n;
		ws->last_rx = mdev_now();
		return 1;
	}
	if (n == 0) {
		log_wrn("connection closed by peer");
		return -1;
	}
	if (errno == ETIMEDOUT)
		return 0;
	log_wrn("read error: %s", strerror(errno));
	return -1;
}

/* Drop `n` consumed bytes from the front of ws->rx. */
static void rx_consume(struct ws_client *ws, size_t n)
{
	if (n >= ws->rx_len) {
		ws->rx_len = 0;
		return;
	}
	memmove(ws->rx, ws->rx + n, ws->rx_len - n);
	ws->rx_len -= n;
}

/*
 * Try to decode one frame from ws->rx.
 * Returns 1 if a frame was consumed (event set), 0 if more bytes are needed,
 * -1 on protocol error.
 */
static int frame_step(struct ws_client *ws, enum ws_event *ev, const char **text)
{
	unsigned char *p = ws->rx;
	size_t avail = ws->rx_len, need = 2, plen;
	bool fin, masked;
	int opcode;

	if (avail < need)
		return 0;

	fin    = (p[0] & 0x80) != 0;
	opcode = p[0] & 0x0f;
	masked = (p[1] & 0x80) != 0;
	plen   = p[1] & 0x7f;

	if (p[0] & 0x70) {
		log_err("frame uses reserved bits (extension negotiated?)");
		return -1;
	}

	if (plen == 126) {
		need = 4;
		if (avail < need)
			return 0;
		plen = ((size_t)p[2] << 8) | p[3];
	} else if (plen == 127) {
		uint64_t big = 0;
		int i;

		need = 10;
		if (avail < need)
			return 0;
		for (i = 0; i < 8; i++)
			big = (big << 8) | p[2 + i];
		if (big > WS_MAX_PAYLOAD) {
			log_err("frame payload too large: %llu bytes",
			        (unsigned long long)big);
			return -1;
		}
		plen = (size_t)big;
	}

	/* Servers must not mask; if one does, honour it anyway. */
	if (masked)
		need += 4;
	if (avail < need + plen)
		return 0;

	{
		unsigned char *payload = p + need;
		unsigned char *mask = masked ? (p + need - 4) : NULL;
		size_t i;

		if (mask)
			for (i = 0; i < plen; i++)
				payload[i] ^= mask[i & 3];

		switch (opcode) {
		case OP_PING:
			log_dbg("rx ping (%zu bytes)", plen);
			ws_send_frame(ws, OP_PONG, payload, plen);
			break;

		case OP_PONG:
			log_dbg("rx pong");
			break;

		case OP_CLOSE: {
			int code = (plen >= 2) ? ((payload[0] << 8) | payload[1]) : 0;
			char reason[128] = "";

			if (plen > 2) {
				size_t rl = plen - 2;

				if (rl >= sizeof(reason))
					rl = sizeof(reason) - 1;
				memcpy(reason, payload + 2, rl);
				reason[rl] = '\0';
			}
			log_wrn("server closed: code=%d reason=%s", code, reason);
			ws->closing = true;
			*ev = WS_EV_CLOSED;
			break;
		}

		case OP_TEXT:
		case OP_BIN:
		case OP_CONT: {
			if (opcode != OP_CONT) {
				ws->msg_len = 0;
				ws->msg_opcode = opcode;
			} else if (ws->msg_opcode < 0) {
				log_err("continuation frame without a start frame");
				return -1;
			}

			if (ws->msg_len + plen > WS_MAX_PAYLOAD) {
				log_err("message exceeds %d bytes; dropping connection",
				        WS_MAX_PAYLOAD);
				return -1;
			}
			memcpy(ws->msg + ws->msg_len, payload, plen);
			ws->msg_len += plen;

			if (fin) {
				ws->msg[ws->msg_len] = '\0';
				if (ws->msg_opcode == OP_TEXT) {
					*text = ws->msg;
					*ev = WS_EV_TEXT;
				} else {
					log_dbg("ignoring binary message (%zu bytes)",
					        ws->msg_len);
				}
				ws->msg_opcode = -1;
			}
			break;
		}

		default:
			log_wrn("ignoring unknown opcode 0x%x", opcode);
			break;
		}
	}

	rx_consume(ws, need + plen);
	return 1;
}

enum ws_event ws_poll(struct ws_client *ws, int timeout_ms, const char **text)
{
	enum ws_event ev = WS_EV_NONE;
	long now;

	*text = NULL;
	if (!ws->conn)
		return WS_EV_CLOSED;

	/* Decode anything already buffered before touching the socket. */
	for (;;) {
		int r = frame_step(ws, &ev, text);

		if (r < 0)
			return WS_EV_ERROR;
		if (r == 0)
			break;
		if (ev != WS_EV_NONE)
			return ev;
	}

	/* TLS may hold decrypted bytes that poll() would never report. */
	if (mdev_conn_pending(ws->conn))
		timeout_ms = 0;

	switch (rx_fill(ws, timeout_ms)) {
	case -1:
		return WS_EV_CLOSED;
	case 1:
		for (;;) {
			int r = frame_step(ws, &ev, text);

			if (r < 0)
				return WS_EV_ERROR;
			if (r == 0)
				break;
			if (ev != WS_EV_NONE)
				return ev;
		}
		break;
	default:
		break;   /* timeout */
	}

	now = mdev_now();

	/* Nothing at all for idle_timeout_s means the path is dead. */
	if (ws->cfg->idle_timeout_s > 0 &&
	    now - ws->last_rx > ws->cfg->idle_timeout_s) {
		log_wrn("no traffic for %lds; reconnecting", now - ws->last_rx);
		return WS_EV_CLOSED;
	}

	/* Keepalive: our own ping proves the NAT path is still open. */
	if (ws->cfg->ping_interval_s > 0 &&
	    now - ws->last_ping >= ws->cfg->ping_interval_s) {
		ws->last_ping = now;
		if (ws_send_frame(ws, OP_PING, NULL, 0) != 0)
			return WS_EV_CLOSED;
		log_dbg("tx ping");
	}

	return WS_EV_NONE;
}


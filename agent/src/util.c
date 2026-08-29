/*
 * mDEV_agent - shared helpers implementation.
 */
#define _GNU_SOURCE
#include <ctype.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <sys/utsname.h>

#include "util.h"

bool mdev_verbose = false;

static bool log_stderr = true;

void mdev_log_init(const char *ident)
{
	openlog(ident, LOG_PID, LOG_DAEMON);
	/* procd redirects stderr into logd; a tty means we're run by hand. */
	log_stderr = isatty(STDERR_FILENO) || getenv("MDEV_AGENT_FOREGROUND") != NULL;
}

void mdev_log(int level, const char *fmt, ...)
{
	va_list ap;

	va_start(ap, fmt);
	vsyslog(level, fmt, ap);
	va_end(ap);

	if (!log_stderr)
		return;

	va_start(ap, fmt);
	fprintf(stderr, "[%s] ", AGENT_NAME);
	vfprintf(stderr, fmt, ap);
	fputc('\n', stderr);
	va_end(ap);
}

long mdev_now(void)
{
	struct timespec ts;

	if (clock_gettime(CLOCK_MONOTONIC, &ts) != 0)
		return (long)time(NULL);
	return (long)ts.tv_sec;
}

void mdev_config_defaults(struct mdev_config *c)
{
	memset(c, 0, sizeof(*c));
	snprintf(c->server_url, sizeof(c->server_url), "ws://127.0.0.1:4000/ws");
	snprintf(c->ca_file, sizeof(c->ca_file), "/etc/ssl/certs/ca-certificates.crt");
	c->tls_verify         = true;
	c->connect_timeout_ms = 10000;
	c->ping_interval_s    = 25;
	c->idle_timeout_s     = 90;
}

/* Strip leading/trailing whitespace in place; returns the new start. */
static char *trim(char *s)
{
	char *end;

	while (*s && isspace((unsigned char)*s))
		s++;
	end = s + strlen(s);
	while (end > s && isspace((unsigned char)end[-1]))
		end--;
	*end = '\0';
	return s;
}

/* Remove one layer of matching single/double quotes. */
static char *unquote(char *s)
{
	size_t n = strlen(s);

	if (n >= 2 && ((s[0] == '"' && s[n - 1] == '"') ||
	               (s[0] == '\'' && s[n - 1] == '\''))) {
		s[n - 1] = '\0';
		return s + 1;
	}
	return s;
}

static void copy_field(char *dst, size_t cap, const char *src)
{
	snprintf(dst, cap, "%s", src);
}


int mdev_config_load(struct mdev_config *c, const char *path)
{
	char line[512];
	FILE *f = fopen(path, "r");

	if (!f)
		return -1;

	while (fgets(line, sizeof(line), f)) {
		char *key, *val, *sep, *hash;

		/*
		 * Strip comments, but only when `#` starts the line or follows
		 * whitespace, so tokens containing '#' survive.
		 */
		hash = line;
		while ((hash = strchr(hash, '#')) != NULL) {
			if (hash == line || isspace((unsigned char)hash[-1])) {
				*hash = '\0';
				break;
			}
			hash++;
		}

		key = trim(line);
		if (!*key)
			continue;

		/* Accept `key=value`, `key value` and `key: value`. */
		sep = strpbrk(key, "=: \t");
		if (!sep)
			continue;
		val = sep + 1;
		*sep = '\0';
		if (*val == '=' || *val == ':')
			val++;
		key = trim(key);
		val = unquote(trim(val));
		if (!*val)
			continue;

		if (!strcmp(key, "server_url") || !strcmp(key, "server"))
			copy_field(c->server_url, sizeof(c->server_url), val);
		else if (!strcmp(key, "router_id") || !strcmp(key, "routerId"))
			copy_field(c->router_id, sizeof(c->router_id), val);
		else if (!strcmp(key, "mac_address") || !strcmp(key, "mac"))
			mdev_mac_normalize(val, c->mac);
		else if (!strcmp(key, "token") || !strcmp(key, "install_token"))
			copy_field(c->token, sizeof(c->token), val);
		else if (!strcmp(key, "ca_file"))
			copy_field(c->ca_file, sizeof(c->ca_file), val);
		else if (!strcmp(key, "tls_verify"))
			c->tls_verify = !(!strcmp(val, "0") || !strcasecmp(val, "false") ||
			                  !strcasecmp(val, "no"));
		else if (!strcmp(key, "ping_interval"))
			c->ping_interval_s = atoi(val);
		else if (!strcmp(key, "idle_timeout"))
			c->idle_timeout_s = atoi(val);
		else if (!strcmp(key, "connect_timeout"))
			c->connect_timeout_ms = atoi(val) * 1000;
	}

	fclose(f);
	return 0;
}

int mdev_url_parse(const char *url, struct mdev_url *u)
{
	const char *rest, *slash, *colon;
	char hostport[160];
	size_t hp_len;

	memset(u, 0, sizeof(*u));

	if (!strncmp(url, "wss://", 6)) {
		u->tls = true;
		rest = url + 6;
	} else if (!strncmp(url, "ws://", 5)) {
		u->tls = false;
		rest = url + 5;
	} else if (!strncmp(url, "https://", 8)) {
		u->tls = true;
		rest = url + 8;
	} else if (!strncmp(url, "http://", 7)) {
		u->tls = false;
		rest = url + 7;
	} else {
		return -1;
	}

	slash = strchr(rest, '/');
	hp_len = slash ? (size_t)(slash - rest) : strlen(rest);
	if (hp_len == 0 || hp_len >= sizeof(hostport))
		return -1;
	memcpy(hostport, rest, hp_len);
	hostport[hp_len] = '\0';

	snprintf(u->path, sizeof(u->path), "%s", slash ? slash : "/");

	/* IPv6 literal: [::1]:4000 */
	if (hostport[0] == '[') {
		char *end = strchr(hostport, ']');

		if (!end)
			return -1;
		*end = '\0';
		strncpy(u->host, hostport + 1, sizeof(u->host) - 1);
		u->host[sizeof(u->host) - 1] = '\0';
		colon = (end[1] == ':') ? end + 1 : NULL;
	} else {
		colon = strrchr(hostport, ':');
		if (colon) {
			size_t hl = (size_t)(colon - hostport);
			if (hl >= sizeof(u->host))
				return -1;
			memcpy(u->host, hostport, hl);
			u->host[hl] = '\0';
		} else {
			strncpy(u->host, hostport, sizeof(u->host) - 1);
			u->host[sizeof(u->host) - 1] = '\0';
		}
	}

	if (colon && colon[1])
		snprintf(u->port, sizeof(u->port), "%s", colon + 1);
	else
		snprintf(u->port, sizeof(u->port), "%s", u->tls ? "443" : "80");

	return *u->host ? 0 : -1;
}

bool mdev_mac_normalize(const char *in, char out[18])
{
	char hex[13];
	size_t n = 0;

	for (; *in; in++) {
		if (isxdigit((unsigned char)*in)) {
			if (n >= sizeof(hex) - 1)
				return false;
			hex[n++] = (char)tolower((unsigned char)*in);
		} else if (*in == ':' || *in == '-' || *in == '.' || *in == ' ') {
			continue;
		} else {
			return false;
		}
	}
	hex[n] = '\0';
	if (n != 12)
		return false;

	snprintf(out, 18, "%c%c:%c%c:%c%c:%c%c:%c%c:%c%c",
	         hex[0], hex[1], hex[2], hex[3], hex[4], hex[5],
	         hex[6], hex[7], hex[8], hex[9], hex[10], hex[11]);
	return true;
}

/* Read the first line of a small text file, trimmed. */
static bool read_trimmed(const char *path, char *buf, size_t cap)
{
	FILE *f = fopen(path, "r");
	char *p;

	if (!f)
		return false;
	if (!fgets(buf, (int)cap, f)) {
		fclose(f);
		return false;
	}
	fclose(f);
	p = trim(buf);
	if (p != buf)
		memmove(buf, p, strlen(p) + 1);
	return buf[0] != '\0';
}

bool mdev_mac_detect(char out[18])
{
	/* Same candidate order as backend/scripts/install.sh's detect_mac(). */
	static const char *ifaces[] = { "br-lan", "eth0", "lan0", "wlan0", NULL };
	char path[160], raw[64];
	DIR *d;
	struct dirent *e;

	for (int i = 0; ifaces[i]; i++) {
		snprintf(path, sizeof(path), "/sys/class/net/%s/address", ifaces[i]);
		if (read_trimmed(path, raw, sizeof(raw)) && mdev_mac_normalize(raw, out))
			return true;
	}

	d = opendir("/sys/class/net");
	if (!d)
		return false;
	while ((e = readdir(d)) != NULL) {
		if (e->d_name[0] == '.' || !strcmp(e->d_name, "lo"))
			continue;
		if (snprintf(path, sizeof(path), "/sys/class/net/%s/address",
		             e->d_name) >= (int)sizeof(path))
			continue;
		if (read_trimmed(path, raw, sizeof(raw)) && mdev_mac_normalize(raw, out) &&
		    strcmp(out, "00:00:00:00:00:00") != 0) {
			closedir(d);
			return true;
		}
	}
	closedir(d);
	return false;
}

void mdev_hostname(char *buf, size_t len)
{
	if (gethostname(buf, len) != 0 || !buf[0])
		snprintf(buf, len, "unknown");
	buf[len - 1] = '\0';
}

void mdev_model(char *buf, size_t len)
{
	/* OpenWrt exposes the board name here; fall back to the DT model. */
	if (read_trimmed("/tmp/sysinfo/model", buf, len))
		return;
	if (read_trimmed("/proc/device-tree/model", buf, len))
		return;
	snprintf(buf, len, "unknown");
}

void mdev_firmware(char *buf, size_t len)
{
	char line[256];
	struct utsname un;
	FILE *f = fopen("/etc/openwrt_release", "r");

	if (f) {
		char descr[160] = "";

		while (fgets(line, sizeof(line), f)) {
			if (strncmp(line, "DISTRIB_DESCRIPTION=", 20))
				continue;
			snprintf(descr, sizeof(descr), "%s", unquote(trim(line + 20)));
			break;
		}
		fclose(f);
		if (descr[0]) {
			snprintf(buf, len, "%s", descr);
			return;
		}
	}

	if (uname(&un) == 0)
		snprintf(buf, len, "%s %s", un.sysname, un.release);
	else
		snprintf(buf, len, "unknown");
}

int mdev_random(void *buf, size_t len)
{
	int fd = open("/dev/urandom", O_RDONLY | O_CLOEXEC);
	unsigned char *p = buf;
	size_t got = 0;

	if (fd >= 0) {
		while (got < len) {
			ssize_t n = read(fd, p + got, len - got);

			if (n > 0) {
				got += (size_t)n;
				continue;
			}
			if (n < 0 && errno == EINTR)
				continue;
			break;
		}
		close(fd);
	}
	if (got == len)
		return 0;

	/* Fallback PRNG - only ever used for WebSocket frame masking. */
	srandom((unsigned)(time(NULL) ^ (getpid() << 16)));
	for (; got < len; got++)
		p[got] = (unsigned char)(random() & 0xff);
	return 0;
}

size_t mdev_json_escape(char *dst, size_t dcap, const char *src)
{
	size_t o = 0;

	if (!dcap)
		return 0;

	for (; *src; src++) {
		unsigned char ch = (unsigned char)*src;
		char tmp[8];
		const char *rep = tmp;
		size_t rlen;

		switch (ch) {
		case '"':  rep = "\\\""; rlen = 2; break;
		case '\\': rep = "\\\\"; rlen = 2; break;
		case '\n': rep = "\\n";  rlen = 2; break;
		case '\r': rep = "\\r";  rlen = 2; break;
		case '\t': rep = "\\t";  rlen = 2; break;
		case '\b': rep = "\\b";  rlen = 2; break;
		case '\f': rep = "\\f";  rlen = 2; break;
		default:
			if (ch < 0x20) {
				rlen = (size_t)snprintf(tmp, sizeof(tmp), "\\u%04x", ch);
			} else {
				tmp[0] = (char)ch;
				rlen = 1;
			}
			break;
		}

		if (o + rlen >= dcap)
			break;
		memcpy(dst + o, rep, rlen);
		o += rlen;
	}

	dst[o] = '\0';
	return o;
}


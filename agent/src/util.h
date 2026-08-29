/*
 * mDEV_agent - shared helpers (config, URL, MAC, sysinfo, logging)
 *
 * The agent deliberately depends on nothing but libc (plus libmbedtls when
 * built with TLS support): OpenWrt images for 16 MB devices are tight, and
 * SHA-1/Base64/JSON needs here are small enough to carry locally.
 *
 * Logging goes to syslog (logd is always running on OpenWrt) and, when
 * stderr is a pipe/tty, to stderr as well - procd captures stderr, so
 * `logread` shows everything.
 */
#ifndef MDEV_UTIL_H
#define MDEV_UTIL_H

#include <stdbool.h>
#include <stddef.h>
#include <syslog.h>

#define AGENT_NAME    "mDEV_agent"
#define AGENT_VERSION "1.0.0"

extern bool mdev_verbose;

void mdev_log_init(const char *ident);
void mdev_log(int level, const char *fmt, ...) __attribute__((format(printf, 2, 3)));

/* NOTE: lowercase names on purpose - LOG_ERR/LOG_INFO/... are syslog macros. */
#define log_dbg(fmt, ...) do { if (mdev_verbose) mdev_log(LOG_DEBUG, fmt, ##__VA_ARGS__); } while (0)
#define log_inf(fmt, ...) mdev_log(LOG_INFO,    fmt, ##__VA_ARGS__)
#define log_wrn(fmt, ...) mdev_log(LOG_WARNING, fmt, ##__VA_ARGS__)
#define log_err(fmt, ...) mdev_log(LOG_ERR,     fmt, ##__VA_ARGS__)

struct mdev_url {
	bool tls;
	char host[128];
	char port[8];
	char path[192];
};

struct mdev_config {
	char server_url[256];   /* ws://host:4000/ws | wss://host/ws        */
	char router_id[65];     /* Router.routerId in the portal DB         */
	char mac[18];           /* normalized aa:bb:cc:dd:ee:ff             */
	char token[192];        /* per-router install token (portal secret) */
	char ca_file[160];      /* CA bundle for wss:// verification        */
	bool tls_verify;        /* verify the server certificate            */
	int  connect_timeout_ms;
	int  ping_interval_s;   /* client -> server ping cadence            */
	int  idle_timeout_s;    /* no traffic for this long -> reconnect    */
};

void mdev_config_defaults(struct mdev_config *c);

/*
 * Parse the config written by the portal's scripts/install.sh:
 *
 *   server_url  ws://host:4000/ws
 *   router_id   home-01
 *   mac_address aa:bb:cc:dd:ee:ff
 *   token       <install token>
 *
 * Both "key value" and "key=value" are accepted, with optional quotes and
 * `#` comments.  Returns 0 on success, -1 if the file cannot be read.
 */
int  mdev_config_load(struct mdev_config *c, const char *path);

/* ws://host:port/path -> struct mdev_url. Returns 0 on success. */
int  mdev_url_parse(const char *url, struct mdev_url *u);

/* Normalize any MAC spelling to lowercase colon form. */
bool mdev_mac_normalize(const char *in, char out[18]);

/* Detect the br-lan MAC (same order as the portal's install.sh). */
bool mdev_mac_detect(char out[18]);

void mdev_hostname(char *buf, size_t len);
void mdev_model(char *buf, size_t len);
void mdev_firmware(char *buf, size_t len);

/* Fill buf with cryptographically-random bytes. Returns 0 on success. */
int  mdev_random(void *buf, size_t len);

/* Minimal JSON string escaper. Returns bytes written (excluding NUL). */
size_t mdev_json_escape(char *dst, size_t dcap, const char *src);

/* Monotonic seconds, immune to wall-clock jumps (NTP on boot). */
long mdev_now(void);

#endif /* MDEV_UTIL_H */

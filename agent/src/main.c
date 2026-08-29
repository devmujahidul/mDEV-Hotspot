/*
 * mDEV_agent - OpenWrt agent for the mDEV Hotspot portal.
 *
 * Holds a persistent WebSocket to the portal hub, registers itself with a
 * `hello`, and executes portal-issued commands (currently `reboot`).
 *
 * Designed for 16 MB ramips devices: single process, no threads, no
 * dynamic dependencies beyond libc (plus libmbedtls for wss://).
 */
#define _GNU_SOURCE
#include <errno.h>
#include <getopt.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "cmd.h"
#include "util.h"
#include "ws.h"

#define DEFAULT_CONFIG "/etc/mdev_agent.conf"

/* Reconnect backoff: 5 s doubling to 5 min. */
#define BACKOFF_MIN_S     5
#define BACKOFF_MAX_S     300
#define BACKOFF_AUTH_S    60    /* starting point after an auth rejection */

static volatile sig_atomic_t g_stop;

static void on_signal(int sig)
{
	(void)sig;
	g_stop = 1;
}

static void usage(const char *argv0)
{
	printf(
	"%s %s - mDEV Hotspot OpenWrt agent\n"
	"\n"
	"Usage: %s [options]\n"
	"\n"
	"Options:\n"
	"  -c FILE   config file (default: %s)\n"
	"  -s URL    server URL, ws://host:4000/ws or wss://host/ws\n"
	"  -i ID     router id as registered in the portal\n"
	"  -m MAC    br-lan MAC to report (default: auto-detect)\n"
	"  -t TOKEN  install token issued by the portal\n"
	"  -j        send the token as a user JWT (Sec-WebSocket-Protocol)\n"
	"  -k        do not verify the server TLS certificate\n"
	"  -A FILE   CA bundle for wss:// (default: /etc/ssl/certs/ca-certificates.crt)\n"
	"  -n        dry run: acknowledge reboot but do not reboot\n"
	"  -f        stay in the foreground and log to stderr\n"
	"  -v        verbose logging\n"
	"  -h        this help\n"
	"\n"
	"Command line options override the config file:\n"
	"  %s -s ws://portal:4000/ws -i home-01 -t <token> -f -v\n",
	AGENT_NAME, AGENT_VERSION, argv0, DEFAULT_CONFIG, argv0);
}

/* Interruptible sleep so SIGTERM during backoff exits promptly. */
static void sleep_interruptible(int seconds)
{
	while (seconds-- > 0 && !g_stop)
		sleep(1);
}

static int next_backoff(int cur)
{
	return (cur * 2 > BACKOFF_MAX_S) ? BACKOFF_MAX_S : cur * 2;
}

int main(int argc, char **argv)
{
	struct mdev_config cfg;
	struct mdev_state st;
	struct ws_client ws;
	const char *conf_path = DEFAULT_CONFIG;
	char cli_url[256] = "", cli_id[65] = "", cli_mac[18] = "", cli_token[192] = "";
	char cli_ca[160] = "";
	bool foreground = false, dry_run = false, no_verify = false;
	enum ws_auth_mode auth_mode = WS_AUTH_INSTALL_TOKEN;
	int backoff = BACKOFF_MIN_S;
	int opt;

	while ((opt = getopt(argc, argv, "c:s:i:m:t:A:jknfvh")) != -1) {
		switch (opt) {
		case 'c': conf_path = optarg; break;
		case 's': snprintf(cli_url, sizeof(cli_url), "%s", optarg); break;
		case 'i': snprintf(cli_id, sizeof(cli_id), "%s", optarg); break;
		case 't': snprintf(cli_token, sizeof(cli_token), "%s", optarg); break;
		case 'A': snprintf(cli_ca, sizeof(cli_ca), "%s", optarg); break;
		case 'j': auth_mode = WS_AUTH_BEARER; break;
		case 'k': no_verify = true; break;
		case 'n': dry_run = true; break;
		case 'f': foreground = true; break;
		case 'v': mdev_verbose = true; break;
		case 'm':
			if (!mdev_mac_normalize(optarg, cli_mac)) {
				fprintf(stderr, "invalid MAC: %s\n", optarg);
				return 2;
			}
			break;
		case 'h': usage(argv[0]); return 0;
		default:  usage(argv[0]); return 2;
		}
	}

	if (foreground)
		setenv("MDEV_AGENT_FOREGROUND", "1", 1);
	mdev_log_init(AGENT_NAME);

	mdev_config_defaults(&cfg);
	if (mdev_config_load(&cfg, conf_path) != 0)
		log_dbg("no config at %s; using defaults and CLI options", conf_path);

	/* CLI wins over the config file. */
	if (*cli_url)   snprintf(cfg.server_url, sizeof(cfg.server_url), "%s", cli_url);
	if (*cli_id)    snprintf(cfg.router_id, sizeof(cfg.router_id), "%s", cli_id);
	if (*cli_token) snprintf(cfg.token, sizeof(cfg.token), "%s", cli_token);
	if (*cli_ca)    snprintf(cfg.ca_file, sizeof(cfg.ca_file), "%s", cli_ca);
	if (*cli_mac)   snprintf(cfg.mac, sizeof(cfg.mac), "%s", cli_mac);
	if (no_verify)  cfg.tls_verify = false;

	if (!*cfg.mac && !mdev_mac_detect(cfg.mac)) {
		log_err("could not determine the router MAC; pass -m aa:bb:cc:dd:ee:ff");
		return 1;
	}
	if (!*cfg.router_id) {
		log_err("router_id is required (-i, or router_id in %s)", conf_path);
		return 1;
	}
	if (!*cfg.token) {
		log_err("token is required (-t, or token in %s)", conf_path);
		return 1;
	}

	signal(SIGTERM, on_signal);
	signal(SIGINT, on_signal);
	signal(SIGPIPE, SIG_IGN);   /* write errors surface as EPIPE instead */

	memset(&st, 0, sizeof(st));
	st.cfg     = &cfg;
	st.dry_run = dry_run;

	log_inf("%s %s starting (router=%s mac=%s server=%s)",
	        AGENT_NAME, AGENT_VERSION, cfg.router_id, cfg.mac, cfg.server_url);

	while (!g_stop) {
		bool hard_fail = false;

		if (ws_connect(&ws, &cfg, auth_mode) != 0) {
			if (g_stop)
				break;
			log_wrn("reconnecting in %ds", backoff);
			sleep_interruptible(backoff);
			backoff = next_backoff(backoff);
			continue;
		}

		st.registered = false;
		if (mdev_send_hello(&ws, &st) != 0) {
			ws_disconnect(&ws);
			sleep_interruptible(backoff);
			backoff = next_backoff(backoff);
			continue;
		}

		/* Connected: reset the backoff for the next disconnect. */
		backoff = BACKOFF_MIN_S;

		while (!g_stop) {
			const char *text = NULL;
			enum ws_event ev = ws_poll(&ws, 1000, &text);

			if (ev == WS_EV_TEXT) {
				if (!mdev_handle_message(&ws, &st, text)) {
					hard_fail = true;
					break;
				}
				/* Reboot only after the response is on the wire. */
				if (st.reboot_pending) {
					ws_disconnect(&ws);
					mdev_do_reboot(&st);
					if (!st.dry_run)
						return 0;   /* not reached on real HW */
					break;
				}
				continue;
			}

			if (ev == WS_EV_CLOSED || ev == WS_EV_ERROR)
				break;
		}

		ws_disconnect(&ws);
		if (g_stop)
			break;

		if (hard_fail) {
			/*
			 * Identity/auth rejection: retrying fast only spams the
			 * portal, so start the backoff high.
			 */
			backoff = BACKOFF_AUTH_S;
			log_err("portal rejected this agent; retrying in %ds "
			        "(check router_id, MAC and token)", backoff);
		} else {
			log_wrn("disconnected; reconnecting in %ds", backoff);
		}

		sleep_interruptible(backoff);
		backoff = next_backoff(backoff);
	}

	log_inf("shutting down");
	return 0;
}


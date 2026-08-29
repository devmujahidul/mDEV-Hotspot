/*
 * mDEV_agent - command dispatch implementation.
 */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/reboot.h>

#include "cmd.h"
#include "json.h"
#include "util.h"

/* Longest reboot delay we accept from the portal. */
#define REBOOT_DELAY_MAX_S 300

int mdev_send_hello(struct ws_client *ws, const struct mdev_state *st)
{
	char hostname[128], model[128], firmware[160];
	char e_host[260], e_model[260], e_fw[330], e_id[160];
	char frame[1200];

	mdev_hostname(hostname, sizeof(hostname));
	mdev_model(model, sizeof(model));
	mdev_firmware(firmware, sizeof(firmware));

	/* Everything interpolated into JSON must be escaped. */
	mdev_json_escape(e_id, sizeof(e_id), st->cfg->router_id);
	mdev_json_escape(e_host, sizeof(e_host), hostname);
	mdev_json_escape(e_model, sizeof(e_model), model);
	mdev_json_escape(e_fw, sizeof(e_fw), firmware);

	snprintf(frame, sizeof(frame),
	         "{\"type\":\"hello\","
	         "\"routerId\":\"%s\","
	         "\"mac\":\"%s\","
	         "\"hostname\":\"%s\","
	         "\"model\":\"%s\","
	         "\"firmware\":\"%s\","
	         "\"agentVersion\":\"" AGENT_VERSION "\"}",
	         e_id, st->cfg->mac, e_host, e_model, e_fw);

	return ws_send_text(ws, frame);
}

/* Reply to a command: {"type":"response","requestId":...,"status":...} */
static int send_response(struct ws_client *ws, const char *request_id,
                         const char *status, const char *message)
{
	char e_id[160], e_msg[400];
	char frame[700];

	mdev_json_escape(e_id, sizeof(e_id), request_id);
	mdev_json_escape(e_msg, sizeof(e_msg), message);

	snprintf(frame, sizeof(frame),
	         "{\"type\":\"response\",\"requestId\":\"%s\","
	         "\"status\":\"%s\",\"message\":\"%s\"}",
	         e_id, status, e_msg);

	return ws_send_text(ws, frame);
}

static void handle_command(struct ws_client *ws, struct mdev_state *st, const char *json)
{
	char action[64] = "", request_id[128] = "";
	long delay;

	json_get_string(json, "action", action, sizeof(action));
	json_get_string(json, "requestId", request_id, sizeof(request_id));

	if (!*request_id) {
		log_wrn("command without requestId ignored");
		return;
	}

	if (!strcmp(action, "reboot")) {
		delay = json_get_int(json, "delay", 2);
		if (delay < 0)
			delay = 0;
		if (delay > REBOOT_DELAY_MAX_S)
			delay = REBOOT_DELAY_MAX_S;

		/*
		 * Answer first: the hub times out after 10 s and the portal
		 * would otherwise report the reboot as failed.
		 */
		st->reboot_pending = true;
		st->reboot_delay_s = (int)delay;
		send_response(ws, request_id, "ok",
		              st->dry_run ? "reboot acknowledged (dry-run)"
		                          : "reboot scheduled");
		log_inf("reboot requested by portal (delay %lds%s)", delay,
		        st->dry_run ? ", dry-run" : "");
		return;
	}

	if (!strcmp(action, "ping")) {
		send_response(ws, request_id, "ok", "pong");
		return;
	}

	log_wrn("unsupported action \"%s\"", action);
	send_response(ws, request_id, "error", "unsupported action");
}

bool mdev_handle_message(struct ws_client *ws, struct mdev_state *st, const char *json)
{
	char type[32] = "";

	log_dbg("rx: %s", json);

	if (!json_get_string(json, "type", type, sizeof(type))) {
		log_wrn("message without a type field ignored");
		return true;
	}

	if (!strcmp(type, "command")) {
		handle_command(ws, st, json);
		return true;
	}

	if (!strcmp(type, "ack")) {
		st->registered = true;
		log_inf("registered with portal as \"%s\"", st->cfg->router_id);
		return true;
	}

	if (!strcmp(type, "error")) {
		char code[64] = "", message[256] = "";

		json_get_string(json, "code", code, sizeof(code));
		json_get_string(json, "message", message, sizeof(message));
		log_err("portal error: %s (%s)", message, code);

		/*
		 * Identity/auth failures will never fix themselves by
		 * reconnecting quickly - let the caller back off hard.
		 */
		if (!strcmp(code, "unauthorized") || !strcmp(code, "router-not-found") ||
		    !strcmp(code, "mac-mismatch") || !strcmp(code, "not-owner") ||
		    !strcmp(code, "hello-no-router") || !strcmp(code, "hello-no-mac"))
			return false;

		return true;
	}

	log_dbg("ignoring message type \"%s\"", type);
	return true;
}

void mdev_do_reboot(struct mdev_state *st)
{
	if (!st->reboot_pending)
		return;
	st->reboot_pending = false;

	if (st->reboot_delay_s > 0)
		sleep((unsigned)st->reboot_delay_s);

	if (st->dry_run) {
		log_wrn("dry-run: reboot suppressed (-n)");
		return;
	}

	log_inf("rebooting now");

	/*
	 * Prefer OpenWrt's own reboot, which lets procd stop services and
	 * flush overlayfs cleanly. Fall back to the syscall if exec fails.
	 */
	sync();
	if (fork() == 0) {
		execl("/sbin/reboot", "reboot", (char *)NULL);
		execl("/bin/busybox", "reboot", (char *)NULL);
		_exit(127);
	}

	sleep(20);
	log_wrn("/sbin/reboot did not take effect; using reboot(2)");
	sync();
	reboot(RB_AUTOBOOT);
}

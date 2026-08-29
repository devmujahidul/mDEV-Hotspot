/*
 * mDEV_agent - command dispatch.
 *
 * Frames from the portal hub (backend/src/websocket/hub.js):
 *   {"type":"command","action":"reboot","requestId":"<uuid>"}
 *   {"type":"ack","routerId":"<id>"}                 -> hello accepted
 *   {"type":"error","code":"...","message":"..."}
 *
 * The hub gives a command 10 s to answer (DEFAULT_COMMAND_TIMEOUT_MS in
 * routers.service.js), so the agent always replies *before* acting on a
 * disruptive command like reboot.
 */
#ifndef MDEV_CMD_H
#define MDEV_CMD_H

#include <stdbool.h>

#include "ws.h"

struct mdev_state {
	struct mdev_config *cfg;
	bool registered;        /* hello was acked by the hub          */
	bool reboot_pending;    /* reboot scheduled after the response */
	int  reboot_delay_s;
	bool dry_run;           /* -n: log instead of rebooting        */
};

/* Send the `hello` frame that registers this router with the hub. */
int  mdev_send_hello(struct ws_client *ws, const struct mdev_state *st);

/*
 * Handle one inbound text frame.
 * Returns true to keep the connection, false to tear it down.
 */
bool mdev_handle_message(struct ws_client *ws, struct mdev_state *st, const char *json);

/* Execute a pending reboot (called once the response has been flushed). */
void mdev_do_reboot(struct mdev_state *st);

#endif /* MDEV_CMD_H */

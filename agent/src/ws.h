/*
 * mDEV_agent - minimal RFC 6455 WebSocket client.
 *
 * Only what the portal's hub (`ws` on Node) actually needs:
 *   - HTTP/1.1 Upgrade with Sec-WebSocket-Key/Accept validation
 *   - `Sec-WebSocket-Protocol: bearer, <jwt>` or `?token=<installToken>`
 *   - masked client text frames, unmasked server frames
 *   - ping/pong and close handling, fragmentation reassembly
 *
 * Extensions (permessage-deflate) are never negotiated, so no zlib.
 */
#ifndef MDEV_WS_H
#define MDEV_WS_H

#include <stdbool.h>
#include <stddef.h>

#include "net.h"
#include "util.h"

/* Portal frames are small JSON objects; 16 KiB is generous. */
#define WS_MAX_PAYLOAD 16384

enum ws_auth_mode {
	WS_AUTH_INSTALL_TOKEN,  /* ?token=<installToken> (real agents)  */
	WS_AUTH_BEARER,         /* Sec-WebSocket-Protocol: bearer, <jwt> */
};

enum ws_event {
	WS_EV_NONE,     /* timeout with nothing to report        */
	WS_EV_TEXT,     /* a complete text message is available  */
	WS_EV_CLOSED,   /* peer closed / connection lost         */
	WS_EV_ERROR,    /* protocol or I/O error                 */
};

struct ws_client {
	struct mdev_conn *conn;
	const struct mdev_config *cfg;
	struct mdev_url url;

	/* Reassembly buffer for the current (possibly fragmented) message. */
	char   msg[WS_MAX_PAYLOAD + 1];
	size_t msg_len;
	int    msg_opcode;

	/* Raw byte buffer straddling frame boundaries. */
	unsigned char rx[WS_MAX_PAYLOAD + 64];
	size_t rx_len;

	long last_rx;       /* mdev_now() of the last inbound byte  */
	long last_ping;     /* mdev_now() of the last ping we sent  */
	bool closing;
};

/*
 * Connect + perform the WebSocket handshake against cfg->server_url.
 * Returns 0 on success; the client is then ready for ws_send_text().
 */
int  ws_connect(struct ws_client *ws, const struct mdev_config *cfg,
                enum ws_auth_mode mode);

void ws_disconnect(struct ws_client *ws);

/* Send a masked text frame. Returns 0 on success. */
int  ws_send_text(struct ws_client *ws, const char *text);

/*
 * Wait up to timeout_ms for a message.  On WS_EV_TEXT, *text points at
 * ws->msg (valid until the next ws_poll call).  Handles ping/pong and
 * keepalive internally.
 */
enum ws_event ws_poll(struct ws_client *ws, int timeout_ms, const char **text);

#endif /* MDEV_WS_H */

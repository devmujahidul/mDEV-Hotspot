/*
 * mDEV_agent - byte transport (plain TCP, optionally TLS via mbedTLS).
 *
 * Build with -DMDEV_WITH_TLS to link libmbedtls and enable wss://.
 * Without it the agent has zero library dependencies beyond libc and
 * refuses wss:// URLs at startup with a clear error.
 */
#ifndef MDEV_NET_H
#define MDEV_NET_H

#include <stdbool.h>
#include <stddef.h>

#include "util.h"

struct mdev_conn;

/*
 * Connect to u->host:u->port, performing the TLS handshake when u->tls.
 * Returns NULL on failure (already logged).
 */
struct mdev_conn *mdev_conn_open(const struct mdev_url *u, const struct mdev_config *cfg);

void mdev_conn_close(struct mdev_conn *c);

/* Underlying fd, for poll(). */
int mdev_conn_fd(const struct mdev_conn *c);

/*
 * Read/write with the socket in blocking mode but guarded by a timeout.
 * Return > 0 on progress, 0 on clean EOF, -1 on error.
 * mdev_conn_write() writes the whole buffer or fails.
 */
int mdev_conn_read(struct mdev_conn *c, void *buf, size_t len, int timeout_ms);
int mdev_conn_write(struct mdev_conn *c, const void *buf, size_t len, int timeout_ms);

/* True when the TLS layer still holds decrypted bytes poll() cannot see. */
bool mdev_conn_pending(const struct mdev_conn *c);

/* True when this build supports wss://. */
bool mdev_tls_supported(void);

#endif /* MDEV_NET_H */

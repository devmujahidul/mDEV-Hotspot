/*
 * Minimal SHA-1 + Base64 for the WebSocket handshake.
 *
 * Carrying these locally (~150 lines) avoids linking libmbedcrypto or
 * libubox just for `Sec-WebSocket-Accept` validation, which keeps the
 * agent usable on plain-ws builds with zero extra dependencies.
 * SHA-1 is used here only as an RFC 6455 handshake checksum, never for
 * security decisions.
 */
#ifndef MDEV_SHA1_H
#define MDEV_SHA1_H

#include <stddef.h>
#include <stdint.h>

#define SHA1_DIGEST_LEN 20

struct sha1_ctx {
	uint32_t state[5];
	uint64_t bitlen;
	uint8_t  buf[64];
	size_t   buflen;
};

void sha1_init(struct sha1_ctx *ctx);
void sha1_update(struct sha1_ctx *ctx, const void *data, size_t len);
void sha1_final(struct sha1_ctx *ctx, uint8_t out[SHA1_DIGEST_LEN]);
void sha1(const void *data, size_t len, uint8_t out[SHA1_DIGEST_LEN]);

/*
 * Base64-encode `len` bytes into `dst` (NUL terminated).
 * `dcap` must be at least 4 * ((len + 2) / 3) + 1.
 * Returns the number of characters written, or 0 if dst is too small.
 */
size_t base64_encode(const void *src, size_t len, char *dst, size_t dcap);

#endif /* MDEV_SHA1_H */

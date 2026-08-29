/*
 * Minimal SHA-1 (RFC 3174) + Base64 (RFC 4648) implementation.
 * Used exclusively for the RFC 6455 WebSocket opening handshake.
 */
#include <stdbool.h>
#include <string.h>

#include "sha1.h"

static uint32_t rol(uint32_t v, int n)
{
	return (v << n) | (v >> (32 - n));
}

static void sha1_block(struct sha1_ctx *ctx, const uint8_t block[64])
{
	uint32_t w[80];
	uint32_t a, b, c, d, e;
	int i;

	for (i = 0; i < 16; i++)
		w[i] = ((uint32_t)block[i * 4] << 24) | ((uint32_t)block[i * 4 + 1] << 16) |
		       ((uint32_t)block[i * 4 + 2] << 8) | (uint32_t)block[i * 4 + 3];
	for (; i < 80; i++)
		w[i] = rol(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);

	a = ctx->state[0];
	b = ctx->state[1];
	c = ctx->state[2];
	d = ctx->state[3];
	e = ctx->state[4];

	for (i = 0; i < 80; i++) {
		uint32_t f, k, tmp;

		if (i < 20) {
			f = (b & c) | (~b & d);
			k = 0x5a827999;
		} else if (i < 40) {
			f = b ^ c ^ d;
			k = 0x6ed9eba1;
		} else if (i < 60) {
			f = (b & c) | (b & d) | (c & d);
			k = 0x8f1bbcdc;
		} else {
			f = b ^ c ^ d;
			k = 0xca62c1d6;
		}

		tmp = rol(a, 5) + f + e + k + w[i];
		e = d;
		d = c;
		c = rol(b, 30);
		b = a;
		a = tmp;
	}

	ctx->state[0] += a;
	ctx->state[1] += b;
	ctx->state[2] += c;
	ctx->state[3] += d;
	ctx->state[4] += e;
}

void sha1_init(struct sha1_ctx *ctx)
{
	ctx->state[0] = 0x67452301;
	ctx->state[1] = 0xefcdab89;
	ctx->state[2] = 0x98badcfe;
	ctx->state[3] = 0x10325476;
	ctx->state[4] = 0xc3d2e1f0;
	ctx->bitlen   = 0;
	ctx->buflen   = 0;
}

void sha1_update(struct sha1_ctx *ctx, const void *data, size_t len)
{
	const uint8_t *p = data;

	ctx->bitlen += (uint64_t)len * 8;

	if (ctx->buflen) {
		size_t need = 64 - ctx->buflen;
		size_t take = len < need ? len : need;

		memcpy(ctx->buf + ctx->buflen, p, take);
		ctx->buflen += take;
		p += take;
		len -= take;
		if (ctx->buflen < 64)
			return;
		sha1_block(ctx, ctx->buf);
		ctx->buflen = 0;
	}

	while (len >= 64) {
		sha1_block(ctx, p);
		p += 64;
		len -= 64;
	}

	if (len) {
		memcpy(ctx->buf, p, len);
		ctx->buflen = len;
	}
}

void sha1_final(struct sha1_ctx *ctx, uint8_t out[SHA1_DIGEST_LEN])
{
	uint8_t tail[128] = { 0 };
	uint64_t bits = ctx->bitlen;
	size_t padlen;
	int i;

	/* 0x80 marker, zero padding to 56 mod 64, then 64-bit BE bit length. */
	padlen = (ctx->buflen < 56) ? (56 - ctx->buflen) : (120 - ctx->buflen);
	tail[0] = 0x80;
	for (i = 0; i < 8; i++)
		tail[padlen + 7 - i] = (uint8_t)((bits >> (i * 8)) & 0xff);

	/* bitlen is irrelevant from here on; the length block is already fixed. */
	sha1_update(ctx, tail, padlen + 8);

	for (i = 0; i < 5; i++) {
		out[i * 4]     = (uint8_t)(ctx->state[i] >> 24);
		out[i * 4 + 1] = (uint8_t)(ctx->state[i] >> 16);
		out[i * 4 + 2] = (uint8_t)(ctx->state[i] >> 8);
		out[i * 4 + 3] = (uint8_t)(ctx->state[i]);
	}
}

void sha1(const void *data, size_t len, uint8_t out[SHA1_DIGEST_LEN])
{
	struct sha1_ctx ctx;

	sha1_init(&ctx);
	sha1_update(&ctx, data, len);
	sha1_final(&ctx, out);
}

size_t base64_encode(const void *src, size_t len, char *dst, size_t dcap)
{
	static const char tbl[] =
		"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	const uint8_t *p = src;
	size_t need = 4 * ((len + 2) / 3);
	size_t o = 0, i = 0;

	if (dcap < need + 1)
		return 0;

	while (i + 2 < len) {
		uint32_t v = ((uint32_t)p[i] << 16) | ((uint32_t)p[i + 1] << 8) | p[i + 2];

		dst[o++] = tbl[(v >> 18) & 0x3f];
		dst[o++] = tbl[(v >> 12) & 0x3f];
		dst[o++] = tbl[(v >> 6) & 0x3f];
		dst[o++] = tbl[v & 0x3f];
		i += 3;
	}

	if (i < len) {
		uint32_t v = (uint32_t)p[i] << 16;
		bool two = (i + 1 < len);

		if (two)
			v |= (uint32_t)p[i + 1] << 8;
		dst[o++] = tbl[(v >> 18) & 0x3f];
		dst[o++] = tbl[(v >> 12) & 0x3f];
		dst[o++] = two ? tbl[(v >> 6) & 0x3f] : '=';
		dst[o++] = '=';
	}

	dst[o] = '\0';
	return o;
}

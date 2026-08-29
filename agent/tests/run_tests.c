/*
 * mDEV_agent - dependency-free self-tests.
 *
 * Covers:
 *   - SHA-1 against the FIPS-180-1 / RFC 3174 vectors
 *   - Base64 against RFC 4648 vectors
 *   - The WebSocket handshake digest from RFC 6455
 *   - json_get_string / json_get_int / json_get_bool on portal-shaped payloads
 *   - mdev_url_parse (ws://, wss://, ipv6 literal, default ports, error paths)
 *   - mdev_mac_normalize (colon, dash, dot, mixed case, junk)
 *   - mdev_json_escape
 */
#include <ctype.h>
#include <stdbool.h>
#include <stdio.h>
#include <string.h>

#include "sha1.h"
#include "json.h"
#include "util.h"

static int g_pass, g_fail;

#define CHECK(cond) do {                                                 \
	if (cond) { g_pass++; }                                          \
	else { g_fail++;                                                 \
		fprintf(stderr, "  FAIL  %s:%d: %s\n",                   \
		        __FILE__, __LINE__, #cond); }                    \
} while (0)

#define CHECK_STREQ(a, b) do {                                           \
	const char *_a = (a), *_b = (b);                                 \
	if (_a && _b && strcmp(_a, _b) == 0) { g_pass++; }               \
	else { g_fail++;                                                 \
		fprintf(stderr, "  FAIL  %s:%d: \"%s\" != \"%s\"\n",     \
		        __FILE__, __LINE__,                              \
		        _a ? _a : "(null)", _b ? _b : "(null)"); }        \
} while (0)

static void hex_of(const uint8_t *bin, size_t n, char *out)
{
	static const char *h = "0123456789abcdef";
	for (size_t i = 0; i < n; i++) {
		out[2 * i]     = h[bin[i] >> 4];
		out[2 * i + 1] = h[bin[i] & 0xf];
	}
	out[2 * n] = '\0';
}

static void test_sha1_vectors(void)
{
	struct {
		const char *in;
		const char *hex;
	} v[] = {
		{ "",                              "da39a3ee5e6b4b0d3255bfef95601890afd80709" },
		{ "abc",                           "a9993e364706816aba3e25717850c26c9cd0d89d" },
		{ "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
		                                  "84983e441c3bd26ebaae4aa1f95129e5e54670f1" },
		{ "The quick brown fox jumps over the lazy dog",
		                                  "2fd4e1c67a2d28fced849ee1bb76e7391b93eb12" },
		{ "The quick brown fox jumps over the lazy dog.",
		                                  "408d94384216f890ff7a0c3528e8bed1e0b01621" },
		{ NULL,                            "34aa973cd4c4daa4f61eeb2bdbad27316534016f" },
	};
	printf("[sha1] FIPS-180-1 / RFC 3174 vectors\n");
	uint8_t out[SHA1_DIGEST_LEN];
	char hex[2 * SHA1_DIGEST_LEN + 1];

	for (size_t i = 0; i < sizeof(v) / sizeof(v[0]) - 1; i++) {
		sha1(v[i].in, strlen(v[i].in), out);
		hex_of(out, sizeof(out), hex);
		CHECK_STREQ(hex, v[i].hex);
	}

	/* Million 'a's via the streaming API. */
	struct sha1_ctx c;
	sha1_init(&c);
	for (int i = 0; i < 1000; i++) {
		char blk[1000];
		memset(blk, 'a', sizeof(blk));
		sha1_update(&c, blk, sizeof(blk));
	}
	sha1_final(&c, out);
	hex_of(out, sizeof(out), hex);
	CHECK_STREQ(hex, v[sizeof(v) / sizeof(v[0]) - 1].hex);
}

static void test_websocket_accept(void)
{
	printf("[sha1] RFC 6455 Sec-WebSocket-Accept derivation\n");
	const char *key = "dGhlIHNhbXBsZSBub25jZQ==";
	const char *want = "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=";
	char got[64];

	uint8_t digest[SHA1_DIGEST_LEN];
	char concat[128];
	snprintf(concat, sizeof(concat), "%s%s", key,
	         "258EAFA5-E914-47DA-95CA-C5AB0DC85B11");
	sha1(concat, strlen(concat), digest);
	CHECK(base64_encode(digest, sizeof(digest), got, sizeof(got)) > 0);
	CHECK_STREQ(got, want);
}

static void test_base64_vectors(void)
{
	struct {
		const char *in;
		size_t      in_len;
		const char *out;
	} v[] = {
		{ "",       0, ""         },  /* returns 0, but output is "" */
		{ "f",      1, "Zg=="     },
		{ "fo",     2, "Zm8="     },
		{ "foo",    3, "Zm9v"     },
		{ "foob",   4, "Zm9vYg==" },
		{ "fooba",  5, "Zm9vYmE=" },
		{ "foobar", 6, "Zm9vYmFy" },
		{ "\x00\x00\x00", 3, "AAAA" },
	};
	printf("[base64] RFC 4648 round-trip\n");
	char got[64];
	for (size_t i = 0; i < sizeof(v) / sizeof(v[0]); i++) {
		size_t r = base64_encode(v[i].in, v[i].in_len, got, sizeof(got));
		CHECK(r == strlen(v[i].out));
		CHECK_STREQ(got, v[i].out);
	}
}

static void test_json_string(void)
{
	printf("[json] get_string on portal-shaped payload\n");
	const char *j =
		"{\"type\":\"command\","
		 "\"action\":\"reboot\","
		 "\"requestId\":\"abc-123\","
		 "\"delay\":5}";

	char buf[64];
	CHECK(json_get_string(j, "type", buf, sizeof(buf)));
	CHECK_STREQ(buf, "command");

	CHECK(json_get_string(j, "action", buf, sizeof(buf)));
	CHECK_STREQ(buf, "reboot");

	CHECK(json_get_string(j, "requestId", buf, sizeof(buf)));
	CHECK_STREQ(buf, "abc-123");

	/* Absent key -> false, buffer untouched. */
	buf[0] = '!';
	CHECK(!json_get_string(j, "missing", buf, sizeof(buf)));
	CHECK(buf[0] == '!');

	/* Escape decoding (\\n, \\t, \\\", \\u00e9). */
	const char *esc =
		"{\"msg\":\"line1\\nline2\\ttab\\\"q\\\"\u00e9\"}";
	CHECK(json_get_string(esc, "msg", buf, sizeof(buf)));
	CHECK_STREQ(buf, "line1\nline2\ttab\"q\"\xc3\xa9");

	/* Nested field must NOT be matched. */
	const char *nested =
		"{\"data\":{\"action\":\"wrong\"},\"action\":\"right\"}";
	CHECK(json_get_string(nested, "action", buf, sizeof(buf)));
	CHECK_STREQ(buf, "right");
}

static void test_json_int(void)
{
	printf("[json] get_int / get_bool\n");
	const char *j =
		"{\"delay\":5,\"retries\":-2,\"flag\":true,\"off\":false}";
	CHECK(json_get_int(j, "delay",    -1) == 5);
	CHECK(json_get_int(j, "retries",  -1) == -2);
	CHECK(json_get_int(j, "missing",  42) == 42);
	CHECK(json_get_bool(j, "flag",  false) == true);
	CHECK(json_get_bool(j, "off",   true)  == false);
	CHECK(json_get_bool(j, "missing", true) == true);
}

static void test_url_parse(void)
{
	printf("[url] mdev_url_parse\n");
	struct mdev_url u;

	CHECK(mdev_url_parse("ws://portal:4000/ws", &u) == 0);
	CHECK(!u.tls);
	CHECK_STREQ(u.host, "portal");
	CHECK_STREQ(u.port, "4000");
	CHECK_STREQ(u.path, "/ws");

	CHECK(mdev_url_parse("wss://portal/ws", &u) == 0);
	CHECK(u.tls);
	CHECK_STREQ(u.host, "portal");
	CHECK_STREQ(u.port, "443");
	CHECK_STREQ(u.path, "/ws");

	CHECK(mdev_url_parse("http://h/", &u) == 0);
	CHECK_STREQ(u.port, "80");
	CHECK_STREQ(u.path, "/");

	CHECK(mdev_url_parse("https://h", &u) == 0);
	CHECK(u.tls);
	CHECK_STREQ(u.port, "443");
	CHECK_STREQ(u.path, "/");

	CHECK(mdev_url_parse("wss://[::1]:9443/ws", &u) == 0);
	CHECK(u.tls);
	CHECK_STREQ(u.host, "::1");
	CHECK_STREQ(u.port, "9443");

	/* Failures. */
	CHECK(mdev_url_parse("", &u)              == -1);
	CHECK(mdev_url_parse("ftp://h/", &u)      == -1);
	CHECK(mdev_url_parse("ws://", &u)         == -1);
	CHECK(mdev_url_parse("ws://[::1", &u)     == -1);
}

static void test_mac(void)
{
	printf("[mac] mdev_mac_normalize\n");
	char out[18];
	CHECK(mdev_mac_normalize("AA:BB:CC:DD:EE:FF", out));
	CHECK_STREQ(out, "aa:bb:cc:dd:ee:ff");
	CHECK(mdev_mac_normalize("aa-bb-cc-dd-ee-ff", out));
	CHECK_STREQ(out, "aa:bb:cc:dd:ee:ff");
	CHECK(mdev_mac_normalize("AABB.CCdd.eeff", out));
	CHECK_STREQ(out, "aa:bb:cc:dd:ee:ff");
	CHECK(mdev_mac_normalize("  aabbccddeeff  ", out));
	CHECK_STREQ(out, "aa:bb:cc:dd:ee:ff");
	CHECK(!mdev_mac_normalize("aabbccddeefg", out));
	CHECK(!mdev_mac_normalize("aabbccddeeff00", out));
	CHECK(!mdev_mac_normalize("", out));
}

static void test_json_escape(void)
{
	printf("[json] mdev_json_escape\n");
	char buf[64];
	size_t n;

	n = mdev_json_escape(buf, sizeof(buf), "hello \"world\"\n");
	CHECK(n > 0);
	CHECK_STREQ(buf, "hello \\\"world\\\"\\n");

	/* Truncation still NUL-terminates. */
	n = mdev_json_escape(buf, 5, "0123456789");
	CHECK(n > 0);
	CHECK(strlen(buf) < 5);
}

int main(void)
{
	mdev_verbose = false;

	test_sha1_vectors();
	test_websocket_accept();
	test_base64_vectors();
	test_json_string();
	test_json_int();
	test_url_parse();
	test_mac();
	test_json_escape();

	printf("\n-------------------------------------------------\n");
	printf("  %d passed, %d failed\n", g_pass, g_fail);
	return g_fail == 0 ? 0 : 1;
}

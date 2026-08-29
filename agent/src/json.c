/*
 * mDEV_agent - tiny read-only JSON scanner implementation.
 */
#include <ctype.h>
#include <stdlib.h>
#include <string.h>

#include "json.h"

static const char *skip_ws(const char *p)
{
	while (*p && isspace((unsigned char)*p))
		p++;
	return p;
}

/* Advance past a JSON string literal (p points at the opening quote). */
static const char *skip_string(const char *p)
{
	if (*p != '"')
		return NULL;
	for (p++; *p; p++) {
		if (*p == '\\') {
			if (!p[1])
				return NULL;
			p++;
			continue;
		}
		if (*p == '"')
			return p + 1;
	}
	return NULL;
}

/* Advance past any JSON value, including nested objects and arrays. */
static const char *skip_value(const char *p)
{
	int depth = 0;

	p = skip_ws(p);
	if (*p == '"')
		return skip_string(p);

	if (*p == '{' || *p == '[') {
		for (; *p; p++) {
			if (*p == '"') {
				p = skip_string(p);
				if (!p)
					return NULL;
				p--;            /* loop's p++ compensates */
				continue;
			}
			if (*p == '{' || *p == '[') {
				depth++;
			} else if (*p == '}' || *p == ']') {
				if (--depth == 0)
					return p + 1;
			}
		}
		return NULL;
	}

	/* Number, true, false, null. */
	while (*p && *p != ',' && *p != '}' && *p != ']' && !isspace((unsigned char)*p))
		p++;
	return p;
}

/* Locate the value of top-level member `key`, or NULL. */
static const char *find_member(const char *json, const char *key)
{
	const char *p = skip_ws(json);
	size_t klen = strlen(key);

	if (*p != '{')
		return NULL;
	p = skip_ws(p + 1);

	while (*p && *p != '}') {
		const char *kstart, *kend, *vstart;

		if (*p != '"')
			return NULL;         /* malformed */
		kstart = p + 1;
		kend = skip_string(p);
		if (!kend)
			return NULL;

		p = skip_ws(kend);
		if (*p != ':')
			return NULL;
		vstart = skip_ws(p + 1);

		/* kend - 1 is the closing quote, so the key is [kstart, kend-1). */
		if ((size_t)((kend - 1) - kstart) == klen &&
		    !memcmp(kstart, key, klen))
			return vstart;

		p = skip_value(vstart);
		if (!p)
			return NULL;
		p = skip_ws(p);
		if (*p == ',')
			p = skip_ws(p + 1);
	}
	return NULL;
}

/* Append a code point as UTF-8; returns bytes written. */
static size_t utf8_put(char *dst, size_t cap, unsigned cp)
{
	if (cp < 0x80 && cap >= 1) {
		dst[0] = (char)cp;
		return 1;
	}
	if (cp < 0x800 && cap >= 2) {
		dst[0] = (char)(0xc0 | (cp >> 6));
		dst[1] = (char)(0x80 | (cp & 0x3f));
		return 2;
	}
	if (cp < 0x10000 && cap >= 3) {
		dst[0] = (char)(0xe0 | (cp >> 12));
		dst[1] = (char)(0x80 | ((cp >> 6) & 0x3f));
		dst[2] = (char)(0x80 | (cp & 0x3f));
		return 3;
	}
	if (cap >= 1) {
		dst[0] = '?';           /* astral plane: not needed here */
		return 1;
	}
	return 0;
}

bool json_get_string(const char *json, const char *key, char *out, size_t cap)
{
	const char *v = find_member(json, key);
	size_t o = 0;

	if (!v || !cap)
		return false;

	if (*v != '"') {
		/* Render numbers/true/false/null verbatim. */
		const char *end = skip_value(v);

		if (!end)
			return false;
		while (v < end && o + 1 < cap)
			out[o++] = *v++;
		out[o] = '\0';
		return o > 0;
	}

	for (v++; *v && *v != '"'; v++) {
		char ch = *v;

		if (ch == '\\') {
			v++;
			switch (*v) {
			case 'n':  ch = '\n'; break;
			case 't':  ch = '\t'; break;
			case 'r':  ch = '\r'; break;
			case 'b':  ch = '\b'; break;
			case 'f':  ch = '\f'; break;
			case '/':  ch = '/';  break;
			case '"':  ch = '"';  break;
			case '\\': ch = '\\'; break;
			case 'u': {
				char hex[5] = { v[1], v[2], v[3], v[4], '\0' };
				unsigned cp;

				if (!isxdigit((unsigned char)hex[0]) ||
				    !isxdigit((unsigned char)hex[3]))
					return false;
				cp = (unsigned)strtoul(hex, NULL, 16);
				v += 4;
				o += utf8_put(out + o, cap - o - 1, cp);
				continue;
			}
			case '\0':
				return false;
			default:
				ch = *v;
				break;
			}
		}

		if (o + 1 >= cap)
			break;
		out[o++] = ch;
	}

	out[o] = '\0';
	return true;
}

long json_get_int(const char *json, const char *key, long dflt)
{
	const char *v = find_member(json, key);

	if (!v)
		return dflt;
	if (*v == '"')
		v++;
	if (*v != '-' && *v != '+' && !isdigit((unsigned char)*v))
		return dflt;
	return strtol(v, NULL, 10);
}

bool json_get_bool(const char *json, const char *key, bool dflt)
{
	const char *v = find_member(json, key);

	if (!v)
		return dflt;
	if (!strncmp(v, "true", 4))
		return true;
	if (!strncmp(v, "false", 5))
		return false;
	return dflt;
}

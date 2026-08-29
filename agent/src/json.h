/*
 * mDEV_agent - tiny read-only JSON scanner.
 *
 * The portal only ever sends flat control objects, e.g.
 *   {"type":"command","action":"reboot","requestId":"...","delay":5}
 * so a top-level key scanner is enough and costs ~120 lines instead of
 * linking libjson-c (which would be fine on OpenWrt, but this keeps the
 * agent dependency-free and the binary small).
 *
 * Only top-level members are matched: nested objects/arrays are skipped
 * wholesale, so a key inside `data` can never be mistaken for a real field.
 */
#ifndef MDEV_JSON_H
#define MDEV_JSON_H

#include <stdbool.h>
#include <stddef.h>

/*
 * Copy the top-level string (or number/bool, rendered verbatim) member
 * `key` of the JSON object `json` into `out`. JSON escapes in strings are
 * decoded (\uXXXX becomes UTF-8, or '?' outside the BMP).
 * Returns true when the key exists.
 */
bool json_get_string(const char *json, const char *key, char *out, size_t cap);

/* Top-level integer member; returns `dflt` when absent or not numeric. */
long json_get_int(const char *json, const char *key, long dflt);

/* True when the top-level member exists and is JSON `true`. */
bool json_get_bool(const char *json, const char *key, bool dflt);

#endif /* MDEV_JSON_H */

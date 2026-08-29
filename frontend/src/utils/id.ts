/**
 * Frontend ID helpers.
 */

/** Base36 (lowercase, no leading zero issues) for short friendly IDs. */
function randBase36(len: number): string {
  // crypto.getRandomValues is available in all modern browsers; falls back
  // to Math.random if not (shouldn't happen in practice).
  const bytes = new Uint8Array(len);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < len; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let out = '';
  for (let i = 0; i < len; i++) out += (bytes[i] % 36).toString(36);
  return out;
}

/** Generate a short, human-friendly router id, e.g. "router-7h2k".
 *  Matches the backend's `^[A-Za-z0-9_-]{2,40}$` validation regex. */
export function suggestRouterId(): string {
  return `router-${randBase36(4)}`;
}

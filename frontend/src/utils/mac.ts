/**
 * MAC-address normalization.
 *
 * Mirrors the backend's `src/utils/mac.js` and the C agent's
 * `mdev_mac_normalize()`. All three accept the same four input formats:
 *
 *   aa:bb:cc:dd:ee:ff   (colon-separated, the canonical form)
 *   aa-bb-cc-dd-ee-ff   (dash-separated)
 *   aabb.ccdd.eeff      (Cisco / dot-separated triplets)
 *   aabbccddeeff        (no separators)
 *
 * Leading / trailing whitespace is tolerated. Output is the canonical
 * lowercase colon-separated form, or `null` if the input is invalid.
 */
const MAC_RE = /^[0-9a-fA-F]{12}$/;

export function normalizeMac(input: string | null | undefined): string | null {
  if (!input) return null;
  const compact = String(input).replace(/[\s.:-]+/g, '').toLowerCase();
  if (compact.length !== 12) return null;
  if (!MAC_RE.test(compact)) return null;
  return compact.match(/.{1,2}/g)!.join(':');
}

export function isValidMac(input: string | null | undefined): boolean {
  return normalizeMac(input) !== null;
}

/** "aa:bb:cc:dd:ee:ff" -> "AABB-CCDD-EEFF" hint used in the UI. */
export function macHint(input: string | null | undefined): string {
  const n = normalizeMac(input);
  if (!n) return '';
  return n.replace(/:/g, '').toUpperCase();
}

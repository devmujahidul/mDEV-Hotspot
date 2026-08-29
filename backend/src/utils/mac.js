/**
 * MAC address helpers.
 *
 * Accepted input forms (case-insensitive):
 *   - AA:BB:CC:DD:EE:FF
 *   - AA-BB-CC-DD-EE-FF
 *   - aabb.ccdd.eeff    (Cisco style)
 *   - aabbccddeeff      (no separators)
 *
 * Normalized output is always lowercase colon-separated:
 *   - aa:bb:cc:dd:ee:ff
 */

const HEX = '[0-9a-fA-F]';

/** Strict regex: six 2-hex-digit groups separated by ':' or '-' or '.', or 12 hex chars. */
const FORMATS = [
  new RegExp(`^(${HEX}{2}:){5}${HEX}{2}$`),                         // AA:BB:...
  new RegExp(`^(${HEX}{2}-){5}${HEX}{2}$`),                         // AA-BB-...
  new RegExp(`^(${HEX}{4}\\.){2}${HEX}{4}$`),                       // AABB.CCDD.EEFF
  new RegExp(`^${HEX}{12}$`),                                      // AABBCCDDEEFF
];

export function isValidMac(input) {
  if (typeof input !== 'string') return false;
  const s = input.trim();
  if (s.length < 12 || s.length > 17) return false;
  return FORMATS.some((r) => r.test(s));
}

/** Normalize any accepted form to lowercase colon-separated. Throws on invalid. */
export function normalizeMac(input) {
  if (!isValidMac(input)) {
    const e = new Error(`invalid MAC address: ${input}`);
    e.code = 'INVALID_MAC';
    throw e;
  }
  const stripped = String(input).trim().toLowerCase().replace(/[-.:]/g, '');
  // stripped is now 12 hex chars
  return `${stripped.slice(0,2)}:${stripped.slice(2,4)}:${stripped.slice(4,6)}:${stripped.slice(6,8)}:${stripped.slice(8,10)}:${stripped.slice(10,12)}`;
}

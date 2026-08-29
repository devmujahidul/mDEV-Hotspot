/**
 * Tiny leveled logger.  Honors LOG_LEVEL from env (default 'info').
 * Format: [2026-08-29 12:34:56] [LEVEL] message
 *
 * Intentionally dependency-free so it works in any Node version we ship to.
 * Reads LOG_LEVEL directly from process.env to avoid a circular import with
 * the config module (which itself uses this logger to report validation errors).
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const ACTIVE = LEVELS[process.env.LOG_LEVEL || 'info'] ?? LEVELS.info;

function fmt(level, args) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const parts = args.map((a) => {
    if (typeof a === 'string') return a;
    try { return JSON.stringify(a); } catch { return String(a); }
  });
  return `[${ts}] [${level.toUpperCase()}] ${parts.join(' ')}`;
}

function make(level) {
  return (...args) => {
    if (LEVELS[level] < ACTIVE) return;
    const line = fmt(level, args);
    if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
    else                                  process.stdout.write(line + '\n');
  };
}

export const logger = {
  debug: make('debug'),
  info:  make('info'),
  warn:  make('warn'),
  error: make('error'),
};

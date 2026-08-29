/**
 * Wrap an async route handler so any rejection is forwarded to next()
 * (which Express's error middleware will turn into a JSON response).
 *
 * Without this, throwing from an `async` route handler in Express 4
 * crashes the process (unhandled promise rejection).
 *
 * Usage:
 *   router.get('/foo', asyncHandler(async (req, res) => { ... }));
 */
export const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

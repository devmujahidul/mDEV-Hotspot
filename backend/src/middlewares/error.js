import { ApiError } from '../errors/ApiError.js';
import { logger } from '../logger/index.js';

/**
 * Global error handler. Mounted LAST.
 *
 * Always returns:
 *   { "error": { "code", "message", "status", "details"? } }
 *
 * In development, the response also includes `stack` for easier debugging.
 */
// eslint-disable-next-line no-unused-vars
export function errorMiddleware(err, req, res, _next) {
  let apiError;

  if (err instanceof ApiError) {
    apiError = err;
  } else if (err?.code === 11000) {
    // MongoDB duplicate-key error — e.g. a unique-index race on
    // routerId (per owner) or macAddress (global).  Report as a
    // structured 409 Conflict instead of a generic 500.
    const dupField = Object.keys(err?.keyPattern ?? {})[0] ?? 'field';
    apiError = new ApiError(
      409,
      'conflict',
      `A router with this ${dupField} already exists`
    );
    logger.warn(`409 conflict (dup key on "${dupField}")`);
  } else {
    // Unknown error: log full, return generic 500 to the client.
    logger.error('Unhandled error', {
      method: req.method,
      url: req.originalUrl,
      message: err.message,
      stack: err.stack,
    });
    apiError = new ApiError(500, 'internal-error', 'Internal server error');
  }

  // Always log the final shape
  if (apiError.status >= 500) {
    logger.error(`${apiError.status} ${apiError.code} ${apiError.message}`);
  } else {
    logger.warn(`${apiError.status} ${apiError.code} ${apiError.message}`);
  }

  const body = {
    error: {
      code: apiError.code,
      message: apiError.message,
      status: apiError.status,
    },
  };
  if (apiError.details) body.error.details = apiError.details;
  if (process.env.NODE_ENV !== 'production' && err?.stack) {
    body.error.stack = err.stack.split('\n').slice(0, 8);
  }

  res.status(apiError.status).json(body);
}

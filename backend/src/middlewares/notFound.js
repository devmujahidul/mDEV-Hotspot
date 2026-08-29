import { ApiError } from '../errors/ApiError.js';

/**
 * 404 catch-all. Mounted AFTER all routes.
 */
export function notFoundMiddleware(req, _res, next) {
  next(ApiError.notFound(`No route for ${req.method} ${req.originalUrl}`));
}

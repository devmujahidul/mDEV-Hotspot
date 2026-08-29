/**
 * Custom error class so controllers can throw semantic errors and
 * the global error middleware can render a consistent JSON body.
 *
 * Example:
 *   throw new ApiError(404, 'router-not-found', `Router ${id} not found`);
 *
 * Renders as:
 *   { "error": { "code": "router-not-found", "message": "...", "status": 404 } }
 */
export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

/* Pre-canned errors for common cases. */
ApiError.unauthorized    = (msg = 'unauthorized')       => new ApiError(401, 'unauthorized', msg);
ApiError.forbidden       = (msg = 'forbidden')          => new ApiError(403, 'forbidden', msg);
ApiError.notFound        = (msg = 'not found')          => new ApiError(404, 'not-found', msg);
ApiError.conflict        = (msg = 'conflict')           => new ApiError(409, 'conflict', msg);
ApiError.badRequest      = (msg = 'bad request')        => new ApiError(400, 'bad-request', msg);
ApiError.gatewayTimeout  = (msg = 'gateway timeout')    => new ApiError(504, 'gateway-timeout', msg);
ApiError.badGateway      = (msg = 'bad gateway')        => new ApiError(502, 'bad-gateway', msg);
ApiError.serviceUnavailable = (msg = 'service unavailable') => new ApiError(503, 'service-unavailable', msg);

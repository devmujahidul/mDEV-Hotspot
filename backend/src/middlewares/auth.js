import { verifyToken as verifyJwt } from '../auth/jwt.js';
import { ApiError } from '../errors/ApiError.js';
import { User } from '../models/User.js';

/**
 * Extract a bearer token from any of the standard places:
 *   - Authorization: Bearer <token>             (HTTP or WS upgrade)
 *   - ?token=<token>                            (WS upgrade query, for
 *                                                browsers that can't set
 *                                                custom headers on WS)
 *   - Sec-WebSocket-Protocol: bearer, <token>   (WS subprotocol pattern)
 */
export function extractToken(req) {
  const h = req.headers || {};

  // 1) Authorization header
  const auth = h.authorization;
  if (auth && auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }

  // 2) ?token= query param.  Works whether req went through Express
  //    (req.query set) or is a raw HTTP upgrade request (url query only).
  if (req.query && req.query.token) return String(req.query.token).trim();
  if (req.url && req.url.includes('?')) {
    try {
      const qsToken = new URLSearchParams(req.url.split('?')[1]).get('token');
      if (qsToken) return qsToken.trim();
    } catch { /* ignore malformed query */ }
  }

  // 3) Sec-WebSocket-Protocol:  "bearer, <token>"  (or any position)
  const sp = h['sec-websocket-protocol'];
  if (sp) {
    const parts = sp.split(',').map((s) => s.trim());
    for (let i = 0; i < parts.length - 1; i++) {
      if (parts[i].toLowerCase() === 'bearer') return parts[i + 1];
    }
  }
  return null;
}

/* Express middleware: require a JWT. Attaches `req.user` on success. */
export async function httpAuth(req, _res, next) {
  try {
    const token = extractToken(req);
    if (!token) throw ApiError.unauthorized('missing token');

    let payload;
    try {
      payload = verifyJwt(token);
    } catch {
      throw ApiError.unauthorized('invalid or expired token');
    }

    const user = await User.findById(payload.sub).lean();
    if (!user) throw ApiError.unauthorized('user not found');

    req.user = {
      id: user._id.toString(),
      email: user.email,
      displayName: user.displayName,
    };
    next();
  } catch (e) {
    next(e);
  }
}

/* Lower-level helper for the WS upgrade: returns { user, token } or throws. */
export async function authenticateRequest(req) {
  const token = extractToken(req);
  if (!token) throw ApiError.unauthorized('missing token');
  let payload;
  try { payload = verifyJwt(token); } catch { throw ApiError.unauthorized('invalid or expired token'); }
  const user = await User.findById(payload.sub).lean();
  if (!user) throw ApiError.unauthorized('user not found');
  return { user: { id: user._id.toString(), email: user.email }, token };
}


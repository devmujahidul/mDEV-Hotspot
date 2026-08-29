/**
 * Shared TypeScript types for the mDEV Hotspot frontend.
 *
 * These mirror the backend's JSON contracts:
 *   backend/src/models/User.js
 *   backend/src/models/Router.js
 *   backend/src/controllers/auth.controller.js
 *   backend/src/controllers/routers.controller.js
 */

export interface User {
  id: string;
  email: string;
  displayName: string;
  createdAt: string;
  updatedAt: string;
}

export type RouterStatus = 'online' | 'offline' | 'unknown';

export interface Router {
  _id: string;
  ownerId: string;
  routerId: string;
  name: string;
  macAddress: string;
  status: RouterStatus;
  lastSeen: string | null;
  hostname: string;
  model: string;
  firmware: string;
  ip: string;
  agentVersion: string;
  installTokenHint: string;
  installTokenRotatedAt: string;
  createdAt: string;
  updatedAt: string;
}

/** Returned ONLY by create / rotate-token. Plaintext install token
 *  is shown to the user once and never returned again. */
export interface RouterWithInstallToken extends Router {
  installToken: string;
  installCommand: string;
}

/* ---------- API envelope types ---------- */

export interface AuthLoginResponse {
  token: string;
  user: User;
}

export interface AuthRegisterResponse {
  token: string;
  user: User;
}

export interface AuthMeResponse {
  user: User;
}

export interface RoutersListResponse {
  routers: Router[];
}

export interface RouterCreateResponse extends RouterWithInstallToken {}

/** POST /api/routers/:id/rotate-token — refreshed router + once-shown
 *  plaintext install token. */
export interface RouterRotateTokenResponse {
  router: Router;
  installToken: string;
  installCommand: string;
  rotatedAt: string;
}

export interface RebootResponse {
  ok: boolean;
  result: {
    status: 'ok' | 'error';
    message: string;
    data?: Record<string, unknown>;
  };
}

export interface ApiError {
  error: {
    code: string;
    message: string;
    status: number;
    details?: Record<string, unknown>;
  };
}

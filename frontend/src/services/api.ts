import axios, { AxiosError, AxiosInstance } from 'axios';
import type {
  AuthLoginResponse,
  AuthMeResponse,
  AuthRegisterResponse,
  RebootResponse,
  RouterCreateResponse,
  RouterRotateTokenResponse,
  RoutersListResponse,
  Router,
} from '@/types';

/* ------------------------------------------------------------------ */
/*  Public runtime config                                              */
/* ------------------------------------------------------------------ */

/** Base URL for the backend API.  Defaults to a relative path so the
 *  Vite dev server proxy can forward /api to the backend. */
export const API_BASE: string =
  (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/+$/, '') ||
  '/api';

/** Public origin where the root-mounted public routes (`/install.sh`,
 *  `/agent/:arch`) are served.  This is NOT necessarily the same as
 *  `API_BASE` (which is the axios base path, often `/api` in dev).
 *  Falls back to the current browser origin so the same code works
 *  on localhost, behind a reverse proxy, or on a public hostname. */
export const PUBLIC_ORIGIN: string =
  (import.meta.env.VITE_PUBLIC_ORIGIN as string | undefined)?.replace(/\/+$/, '') ||
  (typeof window !== 'undefined' ? window.location.origin : '');

/** Public WebSocket URL, used to build the "install command" snippet
 *  shown to the user on the router detail page. */
export const WS_URL: string =
  (import.meta.env.VITE_WS_URL as string | undefined) ||
  (typeof window !== 'undefined'
    ? `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws`
    : 'ws://localhost:4000/ws');

/* ------------------------------------------------------------------ */
/*  Token storage                                                      */
/* ------------------------------------------------------------------ */

const TOKEN_KEY = 'mdev.token';

/** Persisted JWT (read on app boot, written on login/register). */
export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(TOKEN_KEY);
}

/* ------------------------------------------------------------------ */
/*  Axios instance + interceptors                                       */
/* ------------------------------------------------------------------ */

const api: AxiosInstance = axios.create({
  baseURL: API_BASE,
  timeout: 15_000,
  headers: { 'Content-Type': 'application/json' },
});

/* Attach Authorization header to every request that has a token. */
api.interceptors.request.use((config) => {
  const t = getToken();
  if (t) {
    config.headers = config.headers ?? {};
    config.headers.Authorization = `Bearer ${t}`;
  }
  return config;
});

/* On 401, drop the token and let the auth slice / RequireAuth route
 * the user to /login on the next render. */
let onUnauthorized: (() => void) | null = null;
export function registerUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

api.interceptors.response.use(
  (r) => r,
  (err: AxiosError) => {
    const backend = (err.response?.data as any)?.error;
    if (backend) {
      (err as any).userMessage = backend.message || 'Request failed';
      (err as any).userCode = backend.code || 'unknown';
    } else {
      (err as any).userMessage = err.message || 'Network error';
      (err as any).userCode = 'network';
    }
    if (err.response?.status === 401 && onUnauthorized) {
      onUnauthorized();
    }
    return Promise.reject(err);
  }
);

/** Extract a human-readable error message from any caught value. */
export function errorMessage(e: unknown): string {
  if (typeof e === 'string') return e;
  if (e && typeof e === 'object') {
    const m = (e as any).userMessage ?? (e as any).message;
    if (m) return String(m);
  }
  return 'Unknown error';
}

/* ------------------------------------------------------------------ */
/*  Auth API                                                           */
/* ------------------------------------------------------------------ */

export const AuthApi = {
  async register(input: { email: string; password: string; displayName?: string }) {
    const { data } = await api.post<AuthRegisterResponse>('/auth/register', input);
    return data;
  },
  async login(input: { email: string; password: string }) {
    const { data } = await api.post<AuthLoginResponse>('/auth/login', input);
    return data;
  },
  async me() {
    const { data } = await api.get<AuthMeResponse>('/auth/me');
    return data;
  },
  async logout() {
    // Best-effort.  Backend returns 200 even without a valid token.
    await api.post('/auth/logout').catch(() => undefined);
  },
};

/* ------------------------------------------------------------------ */
/*  Routers API                                                        */
/* ------------------------------------------------------------------ */

export const RoutersApi = {
  async list() {
    const { data } = await api.get<RoutersListResponse>('/routers');
    return data.routers;
  },
  async get(routerId: string) {
    const { data } = await api.get<Router>(`/routers/${encodeURIComponent(routerId)}`);
    return data;
  },
  async create(input: { routerId: string; name?: string; macAddress: string }) {
    const { data } = await api.post<RouterCreateResponse>('/routers', input);
    return data;
  },
  async update(routerId: string, input: { name?: string; macAddress?: string }) {
    const { data } = await api.put<Router>(
      `/routers/${encodeURIComponent(routerId)}`,
      input
    );
    return data;
  },
  async remove(routerId: string) {
    await api.delete(`/routers/${encodeURIComponent(routerId)}`);
  },
  async rotateToken(routerId: string) {
    const { data } = await api.post<RouterRotateTokenResponse>(
      `/routers/${encodeURIComponent(routerId)}/rotate-token`
    );
    return data;
  },
  async reboot(routerId: string) {
    const { data } = await api.post<RebootResponse>(
      `/routers/${encodeURIComponent(routerId)}/reboot`
    );
    return data;
  },
};

export default api;

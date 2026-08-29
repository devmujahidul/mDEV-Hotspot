import { Router } from 'express';
import { asyncHandler } from '../middlewares/asyncHandler.js';
import { httpAuth } from '../middlewares/auth.js';
import * as authService from '../auth/service.js';

const router = Router();

/**
 * POST /api/auth/register
 * Open self-signup.  Returns { user, token }.
 */
router.post('/auth/register', asyncHandler(async (req, res) => {
  const { email, password, displayName } = req.body || {};
  const result = await authService.register({ email, password, displayName });
  res.status(201).json(result);
}));

/**
 * POST /api/auth/login
 * Returns { user, token }.
 */
router.post('/auth/login', asyncHandler(async (req, res) => {
  const { email, password } = req.body || {};
  const result = await authService.login({ email, password });
  res.json(result);
}));

/**
 * GET /api/auth/me
 * Current user info (used by the frontend on app load to validate
 * a persisted token).
 */
router.get('/auth/me', httpAuth, asyncHandler(async (req, res) => {
  res.json({ user: req.user });
}));

/**
 * POST /api/auth/logout
 * Stateless — the client should just drop the token.  This endpoint
 * exists so the client can confirm the server is reachable before
 * clearing local state.
 */
router.post('/auth/logout', httpAuth, (_req, res) => {
  res.json({ ok: true });
});

export default router;

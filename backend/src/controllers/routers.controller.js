import { Router } from 'express';
import { httpAuth } from '../middlewares/auth.js';
import { asyncHandler } from '../middlewares/asyncHandler.js';
import * as routersService from '../services/routers.service.js';

const router = Router();

// All routers routes require auth.
router.use(httpAuth);

/**
 * GET /api/routers
 * List routers owned by the current user.
 */
router.get('/routers', asyncHandler(async (req, res) => {
  const routers = await routersService.listRoutersForUser(req.user.id);
  res.json({ routers });
}));

/**
 * POST /api/routers
 * Register a new router. The install token is shown ONCE in the response.
 */
router.post('/routers', asyncHandler(async (req, res) => {
  const { routerId, name, macAddress } = req.body || {};
  const data = await routersService.createRouterForUser(req.user.id, {
    routerId, name, macAddress,
  }, { req });
  res.status(201).json({ router: data });
}));

/**
 * GET /api/routers/:id
 */
router.get('/routers/:id', asyncHandler(async (req, res) => {
  const data = await routersService.getRouterForUser(req.user.id, req.params.id);
  res.json({ router: data });
}));

/**
 * PATCH /api/routers/:id
 */
router.patch('/routers/:id', asyncHandler(async (req, res) => {
  const { name, macAddress } = req.body || {};
  const data = await routersService.updateRouterForUser(
    req.user.id, req.params.id, { name, macAddress }
  );
  res.json({ router: data });
}));

/**
 * DELETE /api/routers/:id
 */
router.delete('/routers/:id', asyncHandler(async (req, res) => {
  const data = await routersService.deleteRouterForUser(req.user.id, req.params.id);
  res.json(data);
}));

/**
 * POST /api/routers/:id/rotate-token
 * Issue a new install token; the old one is invalidated. The new token
 * is shown ONCE in the response.
 */
router.post('/routers/:id/rotate-token', asyncHandler(async (req, res) => {
  const data = await routersService.rotateInstallToken(req.user.id, req.params.id, { req });
  res.json(data);
}));

/**
 * POST /api/routers/:id/reboot
 * Issue a reboot command. Agent responds BEFORE actually rebooting,
 * so we can confirm receipt. The actual reboot happens ~1s later.
 */
router.post('/routers/:id/reboot', asyncHandler(async (req, res) => {
  const result = await routersService.rebootRouterForUser(req.user.id, req.params.id);
  res.json({ ok: true, result });
}));

export default router;



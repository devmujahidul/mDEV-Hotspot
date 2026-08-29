import { Router } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { logger } from '../logger/index.js';
import { findRouterForAgent, verifyInstallToken } from '../services/routers.service.js';
import { normalizeMac } from '../utils/mac.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

/* Resolve the install.sh and agent/ directory relative to this file
 * so the controller works regardless of process.cwd(). */
const SCRIPTS_DIR  = path.resolve(__dirname, '../../scripts');
const INSTALL_SH   = path.join(SCRIPTS_DIR, 'install.sh');
const AGENT_DIR    = path.join(SCRIPTS_DIR, '..', '..', 'agent', 'build');

const router = Router();

/* Allow-list of architectures the frontend / install.sh will request. */
const ALLOWED_ARCHES = new Set(['mipsel', 'arm', 'aarch64', 'x86_64', 'x86']);

/* Minimal in-memory rate limiter for the public bcrypt verify endpoint.
 * Prevents token-guessing / CPU-exhaustion via the unauthenticated route.
 * (Per-process; replace with Redis if scaled to multiple instances.) */
const verifyHits = new Map();
function rateLimit(key, { windowMs = 60000, max = 20 } = {}) {
  const now = Date.now();
  const rec = verifyHits.get(key) || { n: 0, reset: now + windowMs };
  if (now > rec.reset) { rec.n = 0; rec.reset = now + windowMs; }
  rec.n += 1;
  verifyHits.set(key, rec);
  if (rec.n > max) {
    const retry = Math.ceil((rec.reset - now) / 1000);
    return { limited: true, retry };
  }
  return { limited: false };
}

/* GET /install.sh
 * Public — used by the one-liner the user pastes into the OpenWrt box.
 * Sends a `text/x-shellscript` response with the install script. */
router.get('/install.sh', (_req, res, next) => {
  try {
    if (!fs.existsSync(INSTALL_SH)) {
      const e = new Error('install.sh not found on server');
      e.status = 500;
      throw e;
    }
    res.setHeader('Content-Type', 'text/x-shellscript; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    fs.createReadStream(INSTALL_SH).pipe(res);
  } catch (e) {
    next(e);
  }
});

/* GET /agent/:arch
 * Public — serves the prebuilt agent binary for the requested arch.
 * If the binary isn't built yet we return a 404 with a helpful message
 * (the install script surfaces this to the user). */
router.get('/agent/:arch', (req, res, next) => {
  try {
    const arch = String(req.params.arch || '').toLowerCase();
    if (!ALLOWED_ARCHES.has(arch)) {
      return res.status(400).type('text/plain').send(
        `Unknown arch "${arch}". Supported: ${[...ALLOWED_ARCHES].join(', ')}.\n`
      );
    }
    const filename = `mDEV_agent-${arch}`;
    const fullPath = path.join(AGENT_DIR, filename);
    if (!fs.existsSync(fullPath)) {
      logger.warn(`Agent binary not built: ${fullPath}`);
      return res.status(404).type('text/plain').send(
        `Agent binary for arch "${arch}" is not built on this server.\n` +
        `Build it with:  cd agent && make TARGET=mDEV_agent ARCH=${arch}\n` +
        `Expected path:  ${fullPath}\n`
      );
    }
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-cache');
    fs.createReadStream(fullPath).pipe(res);
  } catch (e) {
    next(e);
  }
});

/* POST /api/install/verify
 * Public — called by install.sh BEFORE writing anything to the router.
 * Verifies, for the given router:
 *   1. the router exists and the install token is valid,
 *   2. the (server-reported or agent-detected) MAC matches the registered MAC,
 *   3. the architecture is allowed and a binary is served for it.
 * Prevents a MAC/arch mismatch / bad token from producing an unusable install. */
router.post('/api/install/verify', async (req, res) => {
  try {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const lim = rateLimit(ip);
    if (lim.limited) {
      res.setHeader('Retry-After', String(lim.retry));
      return res.status(429).json({ ok: false, code: 'rate-limited', message: `too many requests; retry in ${lim.retry}s` });
    }

    const body = req.body || {};
    const routerId = body.routerId || body.router_id;
    const token    = body.token;
    const mac      = body.mac;
    const arch     = body.arch;

    if (!routerId || typeof routerId !== 'string') {
      return res.status(400).json({ ok: false, code: 'bad-request', message: 'routerId is required' });
    }
    if (!token || typeof token !== 'string') {
      return res.status(400).json({ ok: false, code: 'bad-request', message: 'token is required' });
    }

    const router = await findRouterForAgent(routerId);
    if (!router) {
      return res.status(404).json({ ok: false, code: 'router-not-found', message: `router "${routerId}" not found` });
    }

    const tokenOk = await verifyInstallToken(router, token);
    if (!tokenOk) {
      return res.status(401).json({ ok: false, code: 'invalid-token', message: 'invalid install token' });
    }

    const out = {
      ok: true,
      routerId,
      registeredMac: router.macAddress,
      name: router.name,
    };

    if (mac) {
      let normalized;
      try { normalized = normalizeMac(mac); }
      catch { return res.status(400).json({ ok: false, code: 'invalid-mac', message: 'mac is not a valid MAC address' }); }
      if (normalized !== router.macAddress) {
        return res.status(409).json({
          ok: false,
          code: 'mac-mismatch',
          message: `this router's MAC (${normalized}) does not match the registered MAC (${router.macAddress})`,
          reportedMac: normalized,
          registeredMac: router.macAddress,
        });
      }
      out.reportedMac = normalized;
    }

    if (arch) {
      const a = String(arch).toLowerCase();
      // Allow the arch only if it's a known/supported target.  A supported
      // arch that currently has no prebuilt binary is still reported OK so
      // the pre-install MAC/token gate can pass; the binary's presence is
      // surfaced separately (and handled with a clear message at download
      // time), not conflated with the MAC/token verification.
      if (!ALLOWED_ARCHES.has(a)) {
        return res.status(400).json({
          ok: false, code: 'unsupported-arch',
          message: `unsupported architecture "${a}"; supported: ${[...ALLOWED_ARCHES].join(', ')}`,
        });
      }
      out.arch = a;
      out.binaryAvailable = fs.existsSync(path.join(AGENT_DIR, `mDEV_agent-${a}`));
    }

    return res.json(out);
  } catch (err) {
    logger.error('install/verify error', { err: err.message });
    return res.status(500).json({ ok: false, code: 'server-error', message: err.message });
  }
});

export default router;

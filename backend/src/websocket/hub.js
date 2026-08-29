import { WebSocketServer } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { authenticateRequest, extractToken } from '../middlewares/auth.js';
import {
  listAgents, registerAgent, unregisterAgent, getAgentWs,
} from './registry.js';
import { findRouterForAgent, verifyInstallToken } from '../services/routers.service.js';
import { logger } from '../logger/index.js';

const PING_INTERVAL_MS = 30_000;
const HELLO_TIMEOUT_MS = 10_000;

/**
 * Attach a WebSocket server to the given HTTP server. Path: /ws.
 *
 * Auth model:
 *  1) The HTTP upgrade must include a valid JWT (user session).
 *  2) The first message after upgrade MUST be a `hello` carrying
 *     `routerId` and `mac`. The registry verifies the (owner, routerId)
 *     pair exists and the reported MAC matches the registered MAC.
 *  3) Only then is the connection added to the live registry.
 */
export function attachWebSocket(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', async (ws, req) => {
    // ---- 1) Authenticate the upgrade ----
    // Two accepted modes:
    //   a) User JWT (browser / power-user) -> resolves req.user immediately.
    //   b) Router install token (`?token=` or `Authorization: Bearer`).
    //      The install token identifies the ROUTER, not the user, so we
    //      defer authentication: we hold the token on the socket and only
    //      bind it to the router's owner once the `hello` (with routerId)
    //      arrives and the token is verified against that router.
    let user;
    const token = extractToken(req);
    try {
      const auth = await authenticateRequest(req);
      user = auth.user;
    } catch (err) {
      if (!token) {
        logger.warn('WS upgrade rejected: no token', { remote: req.socket.remoteAddress });
        try { ws.close(4001, 'unauthorized'); } catch { /* ignore */ }
        return;
      }
      // Defer: token present but not a valid JWT — treat it as an
      // install token and resolve at hello time.
      user = null;
    }

    // Connection is open but not in registry yet — wait for hello.
    let helloReceived = false;
    const helloTimer = setTimeout(() => {
      if (!helloReceived) {
        logger.warn('WS closed: no hello received', { user: user?.id ?? 'install-token' });
        try { ws.close(4002, 'hello-timeout'); } catch { /* ignore */ }
      }
    }, HELLO_TIMEOUT_MS);

    ws.isAlive       = true;
    ws.user          = user;
    ws.installToken  = user ? null : (token ?? null); // deferred install-token auth
    ws.routerId      = null;
    ws.pending       = new Map();
    ws.helloTimer    = helloTimer;

    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); }
      catch {
        try { ws.send(JSON.stringify({ type: 'error', code: 'invalid-json', message: 'Message is not valid JSON' })); } catch { /* ignore */ }
        return;
      }
      if (msg?.type === 'hello') {
        helloReceived = true;
        clearTimeout(helloTimer);
      }
      await handleAgentMessage(ws, msg);
    });

    ws.on('close', () => onClose(ws));
    ws.on('error', () => onClose(ws));

    logger.info('WS socket opened (awaiting hello)', { user: user?.id ?? 'install-token' });
  });

  // Keepalive ping
  const interval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (!ws.isAlive) { ws.terminate(); return; }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* ignore */ }
    });
  }, PING_INTERVAL_MS);

  wss.on('close', () => clearInterval(interval));
  return wss;
}

function onClose(ws) {
  if (ws.helloTimer) clearTimeout(ws.helloTimer);
  if (ws.routerId) {
    unregisterAgent(ws);
    logger.info('WS agent disconnected', { routerId: ws.routerId });
  }
}

/* ---- inbound message dispatch ---- */
async function handleAgentMessage(ws, msg) {
  if (!msg || typeof msg !== 'object') {
    return sendError(ws, null, 'invalid-message', 'expected a JSON object');
  }
  switch (msg.type) {
    case 'hello':    return onHello(ws, msg);
    case 'response': return onResponse(ws, msg);
    case 'status':   return;   // keepalive
    default:
      return sendError(ws, msg.requestId, 'unknown-type', `unknown message type: ${msg.type}`);
  }
}



async function onHello(ws, msg) {
  const { routerId, mac } = msg;
  if (!routerId) return sendError(ws, null, 'hello-no-router', 'hello.routerId is required');
  if (!mac)      return sendError(ws, null, 'hello-no-mac',   'hello.mac is required');

  // If the upgrade carried an install token (deferred auth), resolve it now:
  // the token must verify against THIS router, after which we bind the
  // socket to the router's owner so registerAgent's ownership check passes.
  if (ws.installToken) {
    const router = await findRouterForAgent(routerId);
    if (!router) {
      logger.warn('WS hello rejected: router not found (install token)', { routerId, user: ws.user?.id });
      try { ws.send(JSON.stringify({ type: 'error', code: 'router-not-found', message: `router "${routerId}" not found` })); } catch { /* ignore */ }
      try { ws.close(4003, 'router-not-found'); } catch { /* ignore */ }
      return;
    }
    const okToken = await verifyInstallToken(router, ws.installToken);
    if (!okToken) {
      logger.warn('WS hello rejected: bad install token', { routerId, user: ws.user?.id });
      try { ws.send(JSON.stringify({ type: 'error', code: 'unauthorized', message: 'invalid install token' })); } catch { /* ignore */ }
      try { ws.close(4003, 'unauthorized'); } catch { /* ignore */ }
      return;
    }
    ws.user = { id: String(router.ownerId), email: '' };
  }

  if (!ws.user) {
    return sendError(ws, null, 'unauthorized', 'connection not authenticated');
  }

  const result = await registerAgent(ws, ws.user, routerId, mac, {
    hostname: msg.hostname,
    model:    msg.model,
    firmware: msg.firmware,
    ip:       msg.ip,
    agentVersion: msg.agentVersion || msg.version,
  });

  if (!result.ok) {
    logger.warn(`WS hello rejected: ${result.code}`, { routerId, mac, user: ws.user.id });
    try { ws.send(JSON.stringify({ type: 'error', code: result.code, message: result.message })); } catch { /* ignore */ }
    try { ws.close(4003, result.code); } catch { /* ignore */ }
    return;
  }

  ws.routerId = routerId;
  try { ws.send(JSON.stringify({ type: 'ack', routerId })); } catch { /* ignore */ }
  logger.info('WS agent registered', { routerId, mac, user: ws.user.id });
}

function onResponse(ws, msg) {
  const { requestId, status, message, data } = msg;
  if (!requestId) return sendError(ws, null, 'response-no-id', 'response.requestId is required');
  const pending = ws.pending?.get(requestId);
  if (!pending) return;   // late response; ignore
  ws.pending.delete(requestId);
  pending.resolve({ status, message, data });
}

function sendError(ws, requestId, code, message) {
  try { ws.send(JSON.stringify({ type: 'error', requestId, code, message })); } catch { /* ignore */ }
}

/* ---- outbound commands ---- */

export function sendCommandToRouter(routerId, command, timeoutMs = 15_000) {
  const ws = getAgentWs(routerId);
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== ws.OPEN) {
      return reject(new Error(`Router ${routerId} is not connected`));
    }
    const requestId = uuidv4();
    const timer = setTimeout(() => {
      if (ws.pending.has(requestId)) {
        ws.pending.delete(requestId);
        reject(new Error(`Command ${command.action || JSON.stringify(command)} timed out for ${routerId}`));
      }
    }, timeoutMs);

    ws.pending.set(requestId, {
      resolve: (resp) => { clearTimeout(timer); resolve(resp); },
      reject:  (err)  => { clearTimeout(timer); reject(err);  },
    });

    ws.send(JSON.stringify({ type: 'command', ...command, requestId }));
  });
}

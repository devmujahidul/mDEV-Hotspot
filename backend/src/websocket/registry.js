// In-memory registry of connected agents (routerId -> { ws, meta, user })
// For multi-instance deployment, swap this for Redis.

import { logger } from '../logger/index.js';
import { Router } from '../models/Router.js';
import { normalizeMac } from '../utils/mac.js';

const agents = new Map();

/**
 * Register a freshly-hello'd agent.  Validates:
 *   - (ownerId, routerId) exists
 *   - normalized mac equals the registered MAC
 *
 * On success, updates the DB doc (status='online', lastSeen, hello fields)
 * and adds the agent to the in-memory map. Returns { ok: true }.
 *
 * On failure, returns { ok: false, code, message } so the hub can close
 * the socket with a meaningful reason.
 */
export async function registerAgent(ws, user, routerId, mac, meta = {}) {
  let normalizedMac;
  try { normalizedMac = normalizeMac(mac); }
  catch { return { ok: false, code: 'invalid-mac', message: 'hello.mac is not a valid MAC address' }; }

  const doc = await Router.findOne({ ownerId: user.id, routerId });
  if (!doc) {
    return { ok: false, code: 'router-not-found', message: `router "${routerId}" is not registered to this user` };
  }
  if (doc.macAddress !== normalizedMac) {
    return {
      ok: false,
      code: 'mac-mismatch',
      message: `reported MAC ${normalizedMac} does not match the registered MAC ${doc.macAddress}`,
    };
  }

  // Update DB state in the background (don't block the hello ack on a write).
  Router.updateOne(
    { _id: doc._id },
    {
      $set: {
        status: 'online',
        lastSeen: new Date(),
        hostname:    meta.hostname    ?? doc.hostname,
        model:       meta.model       ?? doc.model,
        firmware:    meta.firmware    ?? doc.firmware,
        ip:          meta.ip          ?? doc.ip,
        agentVersion:meta.agentVersion?? doc.agentVersion,
      },
    }
  ).catch((err) => logger.warn('DB status update failed', { routerId, err: err.message }));

  // Replace any prior agent for this router.
  const prior = agents.get(routerId);
  if (prior && prior.ws !== ws) {
    try { prior.ws.close(4004, 'replaced'); } catch { /* ignore */ }
  }

  agents.set(routerId, {
    ws,
    user: { id: user.id, email: user.email },
    meta: { ...meta, mac: normalizedMac, lastSeen: new Date().toISOString() },
  });
  logger.info('agent registered', { routerId, user: user.id, mac: normalizedMac });
  return { ok: true };
}

export function unregisterAgent(ws) {
  if (!ws.routerId) return;
  const existing = agents.get(ws.routerId);
  if (existing && existing.ws === ws) {
    agents.delete(ws.routerId);
    // Mark offline in DB (fire & forget).
    Router.updateOne(
      { routerId: ws.routerId },
      { $set: { status: 'offline', lastSeen: new Date() } }
    ).catch((err) => logger.warn('DB status update failed', { routerId: ws.routerId, err: err.message }));
    logger.info('agent unregistered', { routerId: ws.routerId });
  }
}

export function listAgents() {
  return agents;
}

/** Returns the WebSocket for a given routerId, or undefined. */
export function getAgentWs(routerId) {
  return agents.get(routerId)?.ws;
}

/** Public list of online agents with metadata. */
export function getAgentList() {
  const out = [];
  for (const [routerId, entry] of agents.entries()) {
    out.push({
      routerId,
      online: entry.ws.readyState === entry.ws.OPEN,
      user:   { id: entry.user.id, email: entry.user.email },
      ...entry.meta,
    });
  }
  return out;
}



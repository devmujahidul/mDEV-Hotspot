import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Router } from '../models/Router.js';
import { ApiError } from '../errors/ApiError.js';
import { normalizeMac } from '../utils/mac.js';
import { sendCommandToRouter } from '../websocket/hub.js';

const INSTALL_TOKEN_BYTES = 24; // 32 chars base64url
const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;

function generateInstallToken() {
  return crypto.randomBytes(INSTALL_TOKEN_BYTES).toString('base64url');
}

/* ---- DB-backed CRUD ---- */

export async function listRoutersForUser(userId) {
  const docs = await Router.find({ ownerId: userId }).sort({ createdAt: -1 }).lean();
  return docs.map(toPublic);
}

export async function getRouterForUser(userId, routerId) {
  const doc = await Router.findOne({ ownerId: userId, routerId }).lean();
  if (!doc) throw ApiError.notFound(`Router "${routerId}" not found`);
  return toPublic(doc);
}

/**
 * Build the install command the user pastes on the OpenWrt box.
 *
 * The command is always a single `curl | sh` line that:
 *   - downloads /install.sh from the same origin the user is talking to
 *   - passes the install token, router id, and (already-known) MAC
 *   - lets the script auto-detect the architecture and (optionally) the
 *     router's actual MAC if --mac is not given
 *
 * `ctx` is the request context ({ req }) so we can derive the public
 * origin from the request headers (so the same backend works in dev
 * with localhost, behind a reverse proxy, on a public hostname, etc.).
 */
function buildInstallCommand(doc, installToken, ctx) {
  const { httpUrl, wsUrl } = originFromCtx(ctx);
  return (
    `curl -fsSL "${httpUrl}/install.sh" -o /tmp/mdev_install.sh && ` +
    `sh /tmp/mdev_install.sh ` +
      `--router-id ${doc.routerId} ` +
      `--mac ${doc.macAddress} ` +
      `--server ${wsUrl} ` +
      `--token ${installToken}`
  );
}

function originFromCtx(ctx) {
  // Allow env-var override for tests / scripted contexts.
  if (process.env.INSTALL_HTTP_URL && process.env.INSTALL_WS_URL) {
    return { httpUrl: process.env.INSTALL_HTTP_URL, wsUrl: process.env.INSTALL_WS_URL };
  }

  const req = ctx?.req;
  if (req) {
    const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').toString().split(',')[0];
    const host  = (req.headers['x-forwarded-host']  || req.headers.host   || 'localhost').toString().split(',')[0];
    const wsProto = proto === 'https' ? 'wss' : 'ws';
    return {
      httpUrl: `${proto}://${host}`,
      wsUrl:   `${wsProto}://${host}/ws`,
    };
  }
  // Fallback for non-HTTP callers (tests, etc.)
  return {
    httpUrl: process.env.INSTALL_HTTP_URL || 'http://YOUR_BACKEND_HOST:4000',
    wsUrl:   process.env.INSTALL_WS_URL   || 'ws://YOUR_BACKEND_HOST:4000/ws',
  };
}

export async function createRouterForUser(userId, { routerId, name, macAddress }, ctx) {
  if (!routerId) throw ApiError.badRequest('routerId is required');
  if (!macAddress) throw ApiError.badRequest('macAddress is required');
  let normalizedMac;
  try { normalizedMac = normalizeMac(macAddress); }
  catch (e) { throw ApiError.badRequest(e.message); }

  const dup = await Router.findOne({ ownerId: userId, routerId }).lean();
  if (dup) throw ApiError.conflict(`Router "${routerId}" already exists`);
  // MAC uniqueness is global (any account).
  const macDup = await Router.findOne({ macAddress: normalizedMac }).lean();
  if (macDup) throw ApiError.conflict(`MAC ${normalizedMac} is already registered to another router`);

  const installToken = generateInstallToken();
  const installTokenHash = await bcrypt.hash(installToken, 8);
  const installTokenHint = installToken.slice(0, 4) + '…' + installToken.slice(-4);

  const doc = await Router.create({
    ownerId: userId,
    routerId,
    name: name || routerId,
    macAddress: normalizedMac,
    installTokenHash,
    installTokenHint,
    installTokenRotatedAt: new Date(),
  });

  return {
    ...toPublic(doc.toObject()),
    installToken,                                  // shown ONCE
    installCommand: buildInstallCommand(doc, installToken, ctx),
  };
}

export async function updateRouterForUser(userId, routerId, { name, macAddress }) {
  const update = {};
  if (name !== undefined) update.name = name;
  if (macAddress !== undefined) {
    try { update.macAddress = normalizeMac(macAddress); }
    catch (e) { throw ApiError.badRequest(e.message); }
  }
  if (Object.keys(update).length === 0) throw ApiError.badRequest('no updatable fields provided');

  if (update.macAddress !== undefined) {
    // MAC uniqueness is global (any account), but exclude this router
    // itself (it may be re-saving its own current MAC).
    const macDup = await Router.findOne({
      macAddress: update.macAddress,
      routerId: { $ne: routerId },
    }).lean();
    if (macDup) throw ApiError.conflict(`MAC ${update.macAddress} is already registered to another router`);
  }

  const doc = await Router.findOneAndUpdate(
    { ownerId: userId, routerId },
    { $set: update },
    { new: true }
  ).lean();
  if (!doc) throw ApiError.notFound(`Router "${routerId}" not found`);
  return toPublic(doc);
}

export async function deleteRouterForUser(userId, routerId) {
  const r = await Router.findOneAndDelete({ ownerId: userId, routerId });
  if (!r) throw ApiError.notFound(`Router "${routerId}" not found`);
  return { ok: true, routerId };
}

export async function rotateInstallToken(userId, routerId, ctx) {
  const doc = await Router.findOne({ ownerId: userId, routerId });
  if (!doc) throw ApiError.notFound(`Router "${routerId}" not found`);

  const installToken = generateInstallToken();
  doc.installTokenHash = await bcrypt.hash(installToken, 8);
  doc.installTokenHint = installToken.slice(0, 4) + '…' + installToken.slice(-4);
  doc.installTokenRotatedAt = new Date();
  await doc.save();

  // Return the refreshed router alongside the once-shown token so the
  // frontend can update its list/registry consistently.  The frontend
  // reducer for rotate currently assumes the payload *is* a full Router,
  // which left byId[undefined] pollution + a lastInstallToken with no
  // routerId (the "(unknown)" panel).  Returning the router fixes that.
  return {
    router: toPublic(doc.toObject()),
    installToken,
    installCommand: buildInstallCommand(doc, installToken, ctx),
    rotatedAt: doc.installTokenRotatedAt,
  };
}

/* ---- Live actions ---- */

export async function rebootRouterForUser(userId, routerId) {
  const doc = await Router.findOne({ ownerId: userId, routerId }).lean();
  if (!doc) throw ApiError.notFound(`Router "${routerId}" not found`);
  if (doc.status !== 'online') {
    throw ApiError.badGateway(`Router "${routerId}" is not online (status: ${doc.status})`);
  }
  try {
    const result = await sendCommandToRouter(
      routerId, { action: 'reboot' }, DEFAULT_COMMAND_TIMEOUT_MS
    );
    return { routerId, ...result };
  } catch (err) {
    if (/timed out/i.test(err.message)) {
      throw ApiError.gatewayTimeout(err.message);
    }
    throw ApiError.badGateway(err.message);
  }
}

/* ---- Agent-side helpers (used by the WS hub) ---- */

export async function findRouterForAgent(routerId, ownerIdHint) {
  // ownerIdHint is optional; if the agent's JWT doesn't identify the user
  // we fall back to routerId alone (used for ad-hoc token rotation tests).
  const query = { routerId };
  if (ownerIdHint) query.ownerId = ownerIdHint;
  return Router.findOne(query);
}

export async function verifyInstallToken(router, token) {
  if (!router || !token) return false;
  return bcrypt.compare(token, router.installTokenHash);
}

/* ---- helpers ---- */

function toPublic(doc) {
  const { installTokenHash, ...rest } = doc;
  return rest;
}


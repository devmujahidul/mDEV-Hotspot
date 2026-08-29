import mongoose from 'mongoose';
import { normalizeMac, isValidMac } from '../utils/mac.js';

/**
 * Router registered by a user.
 *
 * - `routerId` is the user-chosen identifier shown in URLs and used by
 *   the agent. Unique per owner.
 * - `macAddress` is the br-lan MAC of the OpenWrt router. The agent
 *   reports this on connect; if it doesn't match, the server kicks the
 *   connection. Stored normalized (lowercase, colon-separated).
 * - `installTokenHash` is a bcrypt of the secret install token. The plain
 *   token is shown to the user ONCE (on create or rotate). The agent
 *   sends it as `Authorization: Bearer <installToken>` on WS upgrade;
 *   the server looks up the router by (owner, routerId) and compares.
 * - `status` is driven by the WS hub:
 *     pending  - created but the agent has never connected
 *     online   - agent connected (and MAC matched)
 *     offline  - agent disconnected
 */
const routerSchema = new mongoose.Schema(
  {
    ownerId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    routerId:   { type: String, required: true, trim: true, minlength: 1, maxlength: 64 },
    name:       { type: String, default: '' },
    macAddress: { type: String, required: true, set: (v) => normalizeMac(v) },
    status:     { type: String, enum: ['pending', 'online', 'offline'], default: 'pending' },
    lastSeen:   { type: Date, default: null },

    // Last hello payload from the agent (populated live).
    hostname:   { type: String, default: '' },
    model:      { type: String, default: '' },
    firmware:   { type: String, default: '' },
    ip:         { type: String, default: '' },
    agentVersion:{ type: String, default: '' },

    // Hashed install token (bcrypt). The plain token is shown to the user
    // once on creation/rotation; the agent passes it on the WS upgrade.
    installTokenHash: { type: String, required: true },
    installTokenHint: { type: String, default: '' },  // e.g. "abc...xyz" for display
    installTokenRotatedAt: { type: Date, default: Date.now },
  },
  { timestamps: true, versionKey: false }
);

routerSchema.index({ ownerId: 1, routerId: 1 }, { unique: true });
// MAC addresses are globally unique: a physical router belongs to exactly
// one account, so no two routers (across any account) may claim the same
// br-lan MAC.
routerSchema.index({ macAddress: 1 }, { unique: true });

routerSchema.set('toJSON', {
  transform: (_doc, ret) => {
    delete ret.installTokenHash;
    ret.id = ret._id;
    delete ret._id;
    return ret;
  },
});

/** Static helper: assert a string is a valid MAC. */
routerSchema.statics.assertValidMac = function (mac) {
  if (!isValidMac(mac)) {
    const e = new Error('invalid MAC address');
    e.code = 'INVALID_MAC';
    throw e;
  }
};

export const Router = mongoose.model('Router', routerSchema);

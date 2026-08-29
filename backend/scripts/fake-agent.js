// Fake mDEV agent for end-to-end testing.
//
// Usage:
//   NODE_PATH=.../node_modules node fake-agent.js <routerId> <mac> <token> [wsUrl] [--install-token]
//
//   routerId   The router's public id (e.g. "home-01")
//   mac        The br-lan MAC the agent will report (e.g. "AA:BB:...")
//   token      Auth credential for the upgrade. By default this is a user
//              JWT.  Pass `--install-token` (last arg) to send the token as
//              `?token=<installToken>` instead (matching a real installed
//              agent's `-t` flag), which the backend now accepts via
//              deferred install-token auth.
//   wsUrl      (optional) WS URL.  Defaults to ws://localhost:4000/ws
//
// Behavior:
//   - Opens a WebSocket to the backend, sending the JWT in
//     `Sec-WebSocket-Protocol: bearer, <jwt>` (or the install token as the
//     `?token=` query when --install-token is given).
//   - On open, sends a `hello` with the routerId + mac + a few extra
//     fields.
//   - On `command`, sends back a `response` message and stays connected.
//   - On `reboot` it logs and stays connected (the real agent would
//     actually reboot here).
//   - Logs every message to stdout.

import WebSocket from 'ws';

const [, , routerId, mac, token, rest] = process.argv;
let wsUrl = rest || 'ws://localhost:4000/ws';
const installTokenMode = rest === '--install-token' || process.argv[6] === '--install-token';

if (process.argv[6] && process.argv[6] !== '--install-token') {
  wsUrl = process.argv[6];
}

if (!routerId || !mac || !token) {
  console.error('usage: fake-agent.js <routerId> <mac> <token> [wsUrl] [--install-token]');
  process.exit(2);
}

console.log(`[fake-agent] connecting to ${wsUrl} as ${routerId} (mac=${mac}, mode=${installTokenMode ? 'install-token' : 'jwt'})`);

let ws;
if (installTokenMode) {
  const sep = wsUrl.includes('?') ? '&' : '?';
  ws = new WebSocket(`${wsUrl}${sep}token=${encodeURIComponent(token)}`);
} else {
  ws = new WebSocket(wsUrl, ['bearer', token]);
}

ws.on('open', () => {
  console.log('[fake-agent] connected, sending hello');
  ws.send(JSON.stringify({
    type: 'hello',
    routerId,
    mac,
    hostname: 'fake-host',
    model: 'FakeModel v1',
    firmware: 'OpenWrt 99.99',
    ip: '10.0.0.1',
    agentVersion: 'test-1.0.0',
  }));
});

ws.on('message', (raw) => {
  let msg;
  try { msg = JSON.parse(raw.toString()); }
  catch { console.log('[fake-agent] non-JSON message:', raw.toString()); return; }
  console.log('[fake-agent] recv:', msg);

  if (msg.type === 'command') {
    if (msg.action === 'reboot') {
      console.log('[fake-agent] reboot command received, replying (no actual reboot)');
      ws.send(JSON.stringify({
        type: 'response',
        requestId: msg.requestId,
        status: 'ok',
        message: 'reboot scheduled',
        data: { fake: true },
      }));
    } else {
      ws.send(JSON.stringify({
        type: 'response',
        requestId: msg.requestId,
        status: 'ok',
        message: `ack ${msg.action}`,
      }));
    }
  } else if (msg.type === 'error') {
    console.log(`[fake-agent] error: code=${msg.code} message=${msg.message}`);
  }
});

ws.on('close', (code, reason) => {
  console.log(`[fake-agent] closed: code=${code} reason=${reason?.toString?.() || reason}`);
  process.exit(0);
});

ws.on('error', (err) => {
  console.error('[fake-agent] error:', err.message);
});

setTimeout(() => {
  console.log('[fake-agent] timeout, closing');
  try { ws.close(); } catch { /* ignore */ }
  process.exit(0);
}, 30_000);

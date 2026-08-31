# mDEV-Hotspot — Phase 0 Audit (OpenNDS integration readiness)

> **Status:** Phase 0 / read-only inspection. No source files were modified.
> **Target:** Prepare the repo for an upcoming OpenNDS integration (capture-portal + ndsctl).
> **Repo state:** single commit `18d5af4` — *“V1.00 Only Reboot Option with Agent And Web application”* — confirms this is a V1 baseline.

---

## 0. TL;DR (what to do next)

1. **Wire `opennds` to the existing install one-liner** (backend `install.controller.js` already serves `install.sh` + the agent binary — add an `opennds` config block to the same script, so a single `curl | sh` line is enough).
2. **Extend the agent command surface** (`agent/src/cmd.c`) with `client_list`, `client_auth`, `client_deauth`, `client_details`. The shell out to `ndsctl` already fits the existing `command` → `response` pattern.
3. **Add REST proxy routes** under `/api/routers/:id/opennds/*` that call `sendCommandToRouter(...)` and return the agent’s response. No new infra; pure plumbing.
4. **Backfill hygiene:** add `.gitignore` entries, rename/install scripts to host OpenNDS, add a per-frame `seq` so dropped responses can be detected, add `mac-mismatch` rate-limit on `/api/install/verify` keyed by `mac` not just IP (already IP-keyed — see §10).
5. **Do not** redesign auth, the registry, or the install flow. Both layers are well-shaped and clean for V1.

---

## 1. Repo layout & tooling

```
mDEV-Hotspot/
├── agent/          C, single binary (libc-only, mbedTLS optional)
├── backend/        Node 20+, Express + Mongoose + ws
├── frontend/       React + Vite + Redux Toolkit
├── docs/           (this file)
└── (no .gitignore, no CI, no docker-compose at root)
```

* **LOC** (source only, excluding `node_modules`, `build`, `dist`): **~4.9K lines across ~85 files** (read counts during the audit).
* **Single commit** `18d5af4` — no history, no tags, no `CHANGELOG`.
* **No** `LICENSE`, `CONTRIBUTING`, `CODE_OF_CONDUCT`, `README.md` is present (must check — but no top-level docs).
* **No** `Dockerfile`, `docker-compose.yml`, or CI workflow (`.github/workflows`, `.gitlab-ci.yml`, etc.) anywhere.

## 2. Agent (`agent/`)

### 2.1 What it is

A single statically-shaped C99 program (`main.c`, `cmd.c`, `ws.c`, `net.c`, `util.c`, `json.c`, `sha1.c`) producing the `mDEV_agent` binary. With `MDEV_WITH_TLS=1` it links mbedTLS; without, it refuses `wss://`. Builds with a plain `make` (host) or an OpenWrt SDK (`make CC=… STAGING=… MDEV_WITH_TLS=1`).

Hardening (Makefile): `-Os -fstack-protector-strong -D_FORTIFY_SOURCE=2 -fPIE -Wl,-z,relro,-z,now --gc-sections`. Stripped by default.

### 2.2 Runtime

* Reconnect: exponential backoff **5s → 5min, doubled**, separate `BACKOFF_AUTH_S = 60` after an identity/auth rejection (routerId/MAC/token) — does not spam the portal.
* WS keepalive: client pings every 25s; idle timeout 90s; `OP_PING` auto-pong; fragment reassembly up to 16 KiB.
* Auth modes (compile-time selectable per-process): `WS_AUTH_INSTALL_TOKEN` (production — `?token=…` on the upgrade URL) or `WS_AUTH_BEARER` (`Sec-WebSocket-Protocol: bearer, <jwt>`, used by `backend/scripts/fake-agent.js` for tests).
* Config: `/etc/mdev_agent.conf` (`key="value"`, optional quotes, `#` comments). CLI flags override.
* Logging: syslog (`mDEV_agent`) + stderr when tty or `MDEV_AGENT_FOREGROUND=1`.

### 2.3 Wire protocol (the only one that exists)

Frames are single-line JSON, **no per-frame auth** (auth is at the WS upgrade only), **no compression** (no `permessage-deflate`), **no heartbeats from agent → server** (the server tracks liveness via the in-memory registry; the agent has no `lastSeen` push — see §10).

| Direction     | Type     | Fields                                                                                   | Notes                                                                              |
|---------------|----------|------------------------------------------------------------------------------------------|------------------------------------------------------------------------------------|
| agent → hub   | `hello`  | `type`, `routerId`, `mac`, `hostname`, `model`, `firmware`, `agentVersion`               | First message after upgrade; `routerId` + `mac` must match the DB.                  |
| hub → agent   | `ack`    | `type`, `routerId`                                                                       | Confirms hello; agent sets `st.registered = true`.                                  |
| hub → agent   | `error`  | `type`, `code`, `message` (and `requestId` if in response to a command)                  | Hard-fail codes (`unauthorized`, `router-not-found`, `mac-mismatch`, …) close the socket and reset backoff to 60s. |
| hub → agent   | `command`| `type`, `action`, `requestId`, `…action-specific…`                                      | e.g. `{"type":"command","action":"reboot","requestId":"…","delay":5}`.             |
| agent → hub   | `response`| `type`, `requestId`, `status` (`ok`/`error`), `message`                                | Must be sent **before** acting on a destructive action (reboot, …) so the hub doesn’t 10s-timeout. |

Implemented actions: `reboot` (with `delay` 0..300s), `ping` (no-op echo). Everything else logs `unsupported action` and replies `error`.


### 2.4 Key agent entry points (for the OpenNDS work)

* `mdev_send_hello()` — emits the `hello` JSON; add new optional fields here if the OpenNDS build reports `ndsctl --json` capability.
* `handle_command()` — single `if/else` over `action`; this is where the four OpenNDS actions will be added. Each one shells out via `popen("ndsctl …", "r")`, reads the output, then `send_response(ws, request_id, "ok", output)`.
* `mdev_handle_message()` — top-level dispatch; already ignores unknown `type` values cleanly, so a new server-pushed `event` (e.g. portal telling the agent a client just authed) slots in without touching this.
* `mdev_config_load()` — already accepts arbitrary `key="value"` lines; OpenNDS-related agent knobs (e.g. `ndsctl_path=/usr/bin/ndsctl`, `opennds_debug=1`) can be added without touching the parser.

### 2.5 What the agent does **not** do today

* No per-frame auth tag, no nonce, no timestamp.
* No `ndsctl`/UCI/`/etc/config/opennds` access.
* No MAC/IP reporting beyond the registration hello (the `ndsctl status` payload is much richer and could replace/supplement the current hello).
* No filesystem access beyond `/etc/mdev_agent.conf`, `/etc/ssl/certs/...`, `/tmp/sysinfo/model`, `/proc/device-tree/model`, `/etc/openwrt_release`, `/sys/class/net/*` (read-only).
* No package management; depends on the install script having already installed `ndsctl` on the box.

---

## 3. Backend (`backend/`)

### 3.1 Stack & shape

* Node 20+ ESM, Express 4, Mongoose 8, `ws` 8, `jsonwebtoken`, `bcryptjs`, `dotenv`.
* Process model: **single Node process** holding both the HTTP server, the WS hub, and the in-memory agent registry. Horizontally scaling needs swapping `registry.js` for Redis (already commented as such).
* Mongo-only state. No file storage, no S3, no other backing services.
* Config: `src/config/index.js` validates `process.env` against `src/config/schema.js` and **throws at startup** on any missing/invalid key. `JWT_SECRET` is required; `ALLOWED_ORIGIN` and `PORT` have defaults.

### 3.2 Auth model

| Surface    | Credential                              | How verified                                          |
|------------|------------------------------------------|-------------------------------------------------------|
| HTTP API   | `Authorization: Bearer <jwt>` (or `?token=` for non-browser callers) | `middlewares/auth.js#httpAuth` → `verifyJwt` → `User.findById(payload.sub)` |
| WS upgrade | (a) user JWT *or* (b) install token in `?token=`, `Authorization: Bearer`, or `Sec-WebSocket-Protocol: bearer, <token>` | `hub.js#attachWebSocket` first tries `authenticateRequest()` (JWT path) — if it fails *and* a token is present, the token is parked on the socket (`ws.installToken`) and resolved at `hello` time against the matched router’s bcrypt hash. |
| Install one-liner | install token (24 random bytes → 32 base64url chars) | `POST /api/install/verify` rate-limited per IP (20/min), validates token via `bcrypt.compare(router.installTokenHash, token)` and also reports MAC + arch sanity. |

JWT signing: `HS256`, `expiresIn: config.JWT_EXPIRES_IN` (e.g. 7d). No refresh tokens, no rotation, no revocation list — a stolen JWT is valid until expiry.

Bcrypt: rounds = 10 for user passwords, rounds = 8 for install tokens. Both `bcrypt.compare` and `bcrypt.hash` are CPU-expensive and **unprotected by work-queue isolation** — the public `/api/install/verify` is the only per-IP-limited surface; login is not.

### 3.3 WS hub (`backend/src/websocket/`)

* Path: `/ws` on the same HTTP server (`attachWebSocket(httpServer)`).
* `WebSocketServer({ server, path: '/ws' })` — the **only** WS endpoint in the system.
* `PING_INTERVAL_MS = 30_000` server-side; uses `ws.isAlive` + `pong` (RFC 6455) keepalive. **The server has no application-level heartbeat** beyond this — if a peer silently dies between two server pings the disconnect is detected at most 30s later.
* `HELLO_TIMEOUT_MS = 10_000` — every connection is dropped if `hello` doesn’t arrive in time. Pending identity (install-token mode) is held on the socket (`ws.installToken`, `ws.user = null`).
* Registry: `registry.js` is a `Map<routerId, { ws, user, meta }>`. **`replaced` (close code 4004)** is sent to the prior agent on re-registration (e.g. agent process restart, double registration). DB `status` is `pending` → `online` → `offline`, and `lastSeen` is updated on register only.
* `sendCommandToRouter(routerId, command, timeoutMs = 15_000)` — generates a UUID `requestId`, stores `{ resolve, reject }` in `ws.pending`, sends `{"type":"command",...command,"requestId"}`, rejects with a `gateway-timeout` if the agent doesn’t reply in time. This is the single RPC primitive every new feature will use.
* `handleAgentMessage` is the inbound router: `hello` → register, `response` → resolve pending, anything else → ignore with a debug log. JSON parse errors are reported back as `{"type":"error","code":"invalid-json"}`.

### 3.4 REST API

Mounted at `/api` (`server.js` → `routes/index.js`), in order: `authController` (no middleware), then `routersController` (uses `httpAuth` on itself for every route). Errors are funnelled into `errorMiddleware` which renders a stable `{ error: { code, message, status, details? } }` envelope and converts Mongo duplicate-key (`code 11000`) into a 409 conflict (so a race on `(ownerId, routerId)` or `macAddress` doesn’t surface as a 500).

Endpoints are listed in §8.


### 3.5 Frontend serving

`server.js` does **not** serve the frontend build. The frontend runs as a separate Vite dev server (or its own static host in prod). The two communicate through `ALLOWED_ORIGIN` (CORS allow-list) and `VITE_API_URL` (see §5).

### 3.6 Scripts (`backend/scripts/`)

* `install.sh` — see §4. The hub uses this as the source of truth for install semantics; install-command generation in `routers.service.js` references it and produces a matching `curl | sh` one-liner.
* `fake-agent.js` — minimal `ws` client used by `e2e.sh` and `smoke.sh` to drive end-to-end tests (register/hello/response). Mirrors the C agent’s frame shape.
* `e2e.sh` / `smoke.sh` — shell drivers for `fake-agent.js`. Not part of the runtime.

---

## 4. Installer (`backend/scripts/install.sh`)

Single POSIX-`sh` script; no `bash`-isms; safe to `set -e` everywhere.

**Responsibilities (in order):**

1. Parse args: `--router-id`, `--token`, `--server`, `--mac`, `--arch`, `--no-start`, `--uninstall`, `-h`. Both `--key value` and `--key=value` forms; unknown arg calls `usage; exit 2`.
2. Preflight: **shape-validate the token (32 base64url chars)** before doing anything else. This catches terminal hard-wraps that introduce a literal newline in the pasted one-liner, which would otherwise surface as a downstream 401 with no hint about the cause. Empty token caught separately.
3. Detect platform: OpenWrt (`/etc/openwrt_release`) vs. generic Linux. Branch the install path.
4. Detect MAC: br-lan → eth0 → first non-lo iface from `/sys/class/net` (same priority as the agent’s `mdev_mac_detect`).
5. Detect arch: `uname -m` mapped to one of `mipsel | arm | aarch64 | x86_64 | x86`. Allow-list is enforced again on the server side in `install.controller.js`.
6. **Pre-verify against the portal**: `curl -fsS -X POST <backend>/api/install/verify` with `{routerId, token, mac, arch}`. Fails fast on bad token / MAC mismatch / unsupported arch.
7. `curl` the agent binary from `<backend>/agent/<arch>` into `/usr/bin/mDEV_agent` (`chmod 0755`).
8. Write `/etc/mdev_agent.conf` (`key="value"`, one per line) — the format the C agent’s `mdev_config_load` accepts.
9. Write the procd init script `/etc/init.d/mdev_agent` with explicit shell-source validation (catches the “plain `key value` text” failure mode by sourcing in a subshell and checking for missing values).
10. `procd_set_param respawn 3600 5 5` — respawn after 1h, throttle 5/5, threshold 5.
11. `--uninstall` arm reverses all of the above.

**No OpenNDS / uci / ndsctl / hostapd / iptables references anywhere in the script** — this is the cleanest place to drop an OpenNDS install step (see §9).

**Drift risk identified** (worth fixing while we’re here): `routers.service.js#buildInstallCommand` produces a `curl -fsSL "<server>/install.sh" -o /tmp/mdev_install.sh && sh /tmp/mdev_install.sh --router-id … --mac … --server <wsUrl> --token …` one-liner, while the script also accepts `--server` (WS URL). The backend deliberately embeds `--server <wsUrl>` and **not** the HTTP origin (it can be derived from headers via `X-Forwarded-Proto/Host` and defaults to `http://YOUR_BACKEND_HOST:4000`). This works in dev and behind a single reverse proxy, but **if a user fronts the backend with a CDN that rewrites `Host` to the backend, the WS upgrade will go to the wrong host**. The cleanest fix: add `--api-base` to the script (the public HTTP origin) and use it for the `/api/install/verify` and `/agent/<arch>` URLs, distinct from `--server` (the WS URL). Today this is the same host; after the fix they can diverge.

---

## 5. Frontend (`frontend/`)

### 5.1 Stack

Vite + React 18 + TypeScript + Redux Toolkit + React Router. RTK Query is **not** used — there’s a hand-rolled `@/services/api` with a small fetch wrapper. State: feature slices under `src/features/{auth,routers}/`. Persistence: `localStorage` for both the JWT and the install-token map.

### 5.2 Structure

```
src/
├── App.tsx, main.tsx, types.ts, vite-env.d.ts
├── routes/router.tsx           React Router v6 routes
├── layouts/AppLayout.tsx       AppShell (top bar + Outlet + Toast)
├── pages/
│   ├── LoginPage.tsx
│   ├── RegisterPage.tsx
│   ├── RoutersListPage.tsx     list + per-row status pill + install command modal
│   └── RouterDetailPage.tsx    metadata, hello payload, reboot, rotate, install command
├── features/
│   ├── auth/authSlice.ts       login/register/me, token in localStorage
│   └── routers/routersSlice.ts CRUD + reboot + rotateToken + persisted install tokens
├── services/
│   └── api.ts                  thin fetch wrapper, auth header, error normalisation
├── store/index.ts              configureStore + persistence
├── components/                 small UI primitives
└── styles.css
```

### 5.3 Vite config

`vite.config.ts` only configures the React plugin, the `@` alias to `src/`, and a couple of dev-server flags. **No Vite proxy** for `/api` or `/ws` — the frontend expects `VITE_API_URL` to point at the backend, including in dev. The two `nodemon.json` files (backend and frontend) only watch config files, **not source** — restart-on-save is not set up. (That is fine for the audit; just noting for the dev-experience backlog.)

### 5.4 Build / dev

* `npm run dev` — Vite (HMR works for source).
* `npm run build` — TypeScript compile + Vite build to `frontend/build/`.
* `npm run preview` — local preview of the build.
* `npm run typecheck` — `tsc --noEmit`.
* `npm run lint` — ESLint (config not re-read in this audit).

### 5.5 What the frontend will need for OpenNDS

* A new slice / RTK sub-state for “clients of router X”: list, details, auth, deauth. The shape is a list of `{ mac, ip, token, state, firstSeen, lastSeen, ... }` rows keyed by routerId.
* A “Captive Clients” page under `/routers/:id/clients` and a top-level summary on `RoutersListPage`.
* A new endpoint wrapper in `services/api.ts` for `GET /api/routers/:id/opennds/clients`, `POST .../auth`, `POST .../deauth`, `GET .../clients/:mac`.
* No new global state; the existing routers slice pattern is enough.


---

## 6. Auth, security, and observability — current state

| Concern | Today | Gap |
|---|---|---|
| Password hashing | bcrypt rounds=10 (`auth/service.js`) | None for V1; consider argon2id later. |
| Install token | 24 random bytes base64url, bcrypt rounds=8, shown once | Plaintext lives in `/etc/mdev_agent.conf` (root-only, 0600 implicit); rotate is via `POST /api/routers/:id/rotate-token`. |
| Install token on WS | Sent in `?token=` query string | Visible in proxy access logs; prefer `Authorization: Bearer` (already accepted) or `Sec-WebSocket-Protocol` in a future hardening pass. |
| WS auth fallback | “token in query, defer to `hello`” allows the **router** to be identified by the token (good) but anyone with the upgrade token can’t *do* anything until the **MAC matches the registered one** at the hub (good). | None for V1. |
| Brute-force on `/api/install/verify` | Per-IP rate limit, 20/min (`install.controller.js`) | Add per-MAC limit too — a single LAN can hit from one IP. |
| Brute-force on `/api/auth/login` | **None** | High priority. Add per-IP and per-email rate limit. |
| CORS | `ALLOWED_ORIGIN` allow-list with `credentials: true` | Fine; add a wildcard-CDN caveat. |
| JWT revocation | None (stateless) | Acceptable for V1 if expiry is short; log out is client-side only. |
| TLS | Optional on agent (`MDEV_WITH_TLS=1`); server trusts nothing by default | Operator must put a reverse proxy in front for production. |
| HMAC/signature on agent binary download | None | The install script `curl -fsSL`es the agent from the same origin as the install script. A compromised origin means a compromised binary. Add a `*.sha256` sidecar and `sha256sum -c` step in `install.sh`. |
| Logs | Pino-style `logger/index.js` (not re-read but referenced); per-request access log on `/api/*` only; `lastSeen` updated on register only | No `lastSeen` heartbeat from agent (see §10). |
| Metrics / tracing | None | Acceptable for V1. |

---

## 7. Database schema

Mongoose 8, MongoDB. `server.js` calls `connection.syncIndexes()` on startup so the indexes declared on the schemas are (re)built.

### 7.1 `User` (`backend/src/models/User.js`)

| Field         | Type    | Notes                                                  |
|---------------|---------|--------------------------------------------------------|
| `_id`         | ObjectId| Mongoose default                                        |
| `email`       | String  | required, unique, lowercased, trimmed, regex-validated, indexed |
| `passwordHash`| String  | required, bcrypt rounds=10                              |
| `displayName` | String  | default `''`                                            |
| `createdAt`/`updatedAt` | Date | `timestamps: true`                                   |

Indexes:
* `email` — **unique** (declared on the field with `unique: true` and `index: true`).
* `_id` — Mongoose default.

`toJSON` strips `passwordHash` and renames `_id` → `id`.

### 7.2 `Router` (`backend/src/models/Router.js`)

| Field                  | Type     | Notes                                                                                  |
|------------------------|----------|----------------------------------------------------------------------------------------|
| `_id`                  | ObjectId |                                                                                        |
| `ownerId`              | ObjectId→User | required, indexed, no FK ref enforcement                                            |
| `routerId`             | String   | required, trimmed, 1..64 chars; user-chosen handle (the one in the one-liner)         |
| `name`                 | String   | default `''`                                                                            |
| `macAddress`           | String   | required; **normalized on write** by `set: (v) => normalizeMac(v)` → always lowercase colon form |
| `status`               | String   | enum `['pending','online','offline']`, default `'pending'`                              |
| `lastSeen`             | Date     | default `null`; updated by `registry.js` on register/disconnect                          |
| `hostname`             | String   | default `''`; populated from the `hello` payload                                        |
| `model`                | String   | default `''`                                                                            |
| `firmware`             | String   | default `''`                                                                            |
| `ip`                   | String   | default `''`                                                                            |
| `agentVersion`         | String   | default `''`                                                                            |
| `installTokenHash`     | String   | required; bcrypt rounds=8                                                               |
| `installTokenHint`     | String   | e.g. `abc…xyz`; safe to display, never the secret                                       |
| `installTokenRotatedAt`| Date     | default `Date.now`                                                                      |
| `createdAt`/`updatedAt`| Date     | `timestamps: true`; `versionKey: false`                                                 |

Indexes:
1. **`{ ownerId: 1, routerId: 1 }`** — **unique** (one routerId per owner).
2. **`{ macAddress: 1 }`** — **unique**, global (a physical router belongs to exactly one account).
3. `ownerId` — non-unique index from `index: true` on the field.

`toJSON` strips `installTokenHash`, renames `_id` → `id`.

**Status transitions** (driven entirely by the WS hub):
* create → `pending`
* `registerAgent` ok → `online` (background `updateOne`, ack is not blocked on the DB write)
* `unregisterAgent` (close/error) → `offline` (background `updateOne`)

**Install-token rotation** is implemented in `routers.service.js#rotateInstallToken`: generates a fresh 24-byte base64url, bcrypts it, saves hint, sets `installTokenRotatedAt`. The plaintext is returned **once** to the caller alongside the new install command. The frontend persists it in `localStorage` under `mdev:installTokens` so a tab refresh can recover the one-liner.

There is **no token expiry** — rotation is the only invalidation path. There is **no audit log** of who/when rotated, only the last `installTokenRotatedAt`.


---

## 8. REST API surface

All routes mounted under `/api` (except install/agent binary, which are public at the root). Auth column: `—` = public, `JWT` = `Authorization: Bearer <jwt>` (or `?token=<jwt>`), `WS-only` = not exposed over HTTP (only the WS hub uses it).

| Method | Path                                | Auth   | Controller / handler                                  | Notes |
|--------|-------------------------------------|--------|--------------------------------------------------------|-------|
| GET    | `/health`                           | —      | `server.js` (inline)                                   | `{ ok: true, ts }`. No auth. |
| GET    | `/install.sh`                       | —      | `install.controller.js`                                | Streams `backend/scripts/install.sh` with `Content-Type: text/x-shellscript`. |
| GET    | `/agent/:arch`                      | —      | `install.controller.js`                                | 200 `application/octet-stream` if `agent/build/mDEV_agent-<arch>` exists; 404 with build instructions otherwise. Allow-list: `mipsel,arm,aarch64,x86_64,x86`. |
| POST   | `/api/install/verify`               | —      | `install.controller.js`                                | Body: `{ routerId, token, mac?, arch? }`. Per-IP rate limit (20/min). Returns `{ ok, routerId, registeredMac, name?, reportedMac?, arch?, binaryAvailable? }`. Used by `install.sh` before any writes. |
| POST   | `/api/auth/register`                | —      | `auth.controller.js` → `authService.register`          | Body: `{ email, password, displayName? }`. 201 `{ user, token }`. Password ≥ 8 chars. |
| POST   | `/api/auth/login`                   | —      | `auth.controller.js` → `authService.login`             | `{ user, token }`. **No rate limit.** |
| GET    | `/api/auth/me`                      | JWT    | `auth.controller.js`                                   | `{ user: req.user }`. |
| POST   | `/api/auth/logout`                  | JWT    | `auth.controller.js`                                   | Stateless. `{ ok: true }`. |
| GET    | `/api/routers`                      | JWT    | `routers.controller.js` → `routersService.listRoutersForUser` | `{ routers: [...] }`. Newest first. |
| POST   | `/api/routers`                      | JWT    | `routers.controller.js` → `routersService.createRouterForUser` | Body: `{ routerId, name?, macAddress }`. 201 `{ router: { …, installToken, installCommand } }` — plaintext token shown **once**. |
| GET    | `/api/routers/:id`                  | JWT    | `routers.controller.js`                                | `{ router }`; 404 if not owned. |
| PATCH  | `/api/routers/:id`                  | JWT    | `routers.controller.js`                                | Body: `{ name?, macAddress? }`. MAC change goes through the same global-uniqueness check. |
| DELETE | `/api/routers/:id`                  | JWT    | `routers.controller.js`                                | `{ ok, routerId }`. **Does not** close the WS (the agent will be evicted by a later MAC-mismatch on the next hello, or by the next registerAgent call). |
| POST   | `/api/routers/:id/rotate-token`     | JWT    | `routers.controller.js` → `routersService.rotateInstallToken` | `{ router, installToken, installCommand, rotatedAt }`. The plaintext is shown **once**; the previously-issued agent will fail to re-hello on its next reconnect and is told `unauthorized` (close 4003). |
| POST   | `/api/routers/:id/reboot`           | JWT    | `routers.controller.js` → `routersService.rebootRouterForUser` | 502 if `status !== 'online'`; 504 on 10s timeout. Sends `{"type":"command","action":"reboot","requestId":...}` over WS and resolves with the agent’s `response` payload. |
| WS     | `/ws`                               | JWT **or** install token | `hub.js#attachWebSocket`                | Two-stage auth: (1) HTTP upgrade auth (JWT or install token); (2) `hello` frame binds `routerId`+`mac`. `hello` within 10s, then JSON command/response cycle. |

Error envelope (always):
```json
{ "error": { "code": "router-not-found", "message": "router \"foo\" not found", "status": 404 } }
```


---

## 9. OpenNDS integration — proposed seams

There is **no** existing OpenNDS / ndsctl / hostapd / iptables / wpad code in the repo. The cleanest integration is layered on the existing primitives; do not invent a parallel control plane.

### 9.1 Agent (`agent/src/cmd.c`) — command surface

Add four new `action`s in `handle_command()`, all shelling out to `ndsctl` and returning the stdout as the `message` field of the `response`:

| `action`         | `ndsctl` call                              | `data` returned (in `response.data`) | Notes |
|------------------|--------------------------------------------|---------------------------------------|-------|
| `client_list`    | `ndsctl json`                              | parsed JSON of all currently-authed clients | First implementation: wrap stdout as `{ clients: <parsed> }`. The agent already has `json_get_string`/`json_get_int`; add a `json_get_object` (or just `strstr`/`strndup` for the `clients` array) if needed. |
| `client_auth`    | `ndsctl auth <mac> <ip> <tok> <duration>`  | `{ mac, ip, duration, output }`        | Required args: `mac`, `ip`, `token` (the preauth token from `ndsctl` CP), `duration` (s, max 86400). |
| `client_deauth`  | `ndsctl deauth <mac>`                      | `{ mac, output }`                      | Required: `mac`. |
| `client_details` | `ndsctl json <mac>` (or `ndsctl status <mac>`) | per-client JSON                       | Optional. |

Implementation guidance:
* The `popen()` path is the only place the agent touches the shell. Wrap with `popen` + `pclose`, capture stdout into a 2 KiB buffer (the existing `mdev_json_escape` handles quoting).
* Add a config key `ndsctl_path` (default `/usr/bin/ndsctl`) read by `mdev_config_load` and exposed in `mdev_config`.
* On `ndsctl` not found / non-zero exit, return `status: "error"` with the stderr in `message`; the hub will turn this into a 502 (existing mapping in `rebootRouterForUser` shows the pattern).
* All four must answer **before** any side effect — same contract `reboot` already uses.

**Do not** add a per-frame `seq` here; the existing `requestId` UUID already gives one-shot correlation.

### 9.2 Backend hub — no changes needed

`sendCommandToRouter(routerId, command, timeoutMs)` already does everything the new REST routes need. The new commands can take 1..3s on a busy AP — bump the per-route timeout (passed as the third arg) to 10s for `client_list` and 5s for the per-client actions.

### 9.3 Backend REST proxy

Add a thin controller at `backend/src/controllers/opennds.controller.js`, mounted at `/api/routers/:id/opennds` (so it can `routersController.use(httpAuth)` once and then attach its own routes). Pattern:

```
GET  /api/routers/:id/opennds/clients          -> client_list      (timeout 10s)
POST /api/routers/:id/opennds/auth             -> client_auth      (timeout 5s)
POST /api/routers/:id/opennds/deauth           -> client_deauth    (timeout 5s)
GET  /api/routers/:id/opennds/clients/:mac     -> client_details   (timeout 5s)
```

All four routes do the same thing: look up the router (404 if not owned), assert `status === 'online'` (502 otherwise), `sendCommandToRouter` with the corresponding action, return the agent’s `response.data` directly. Re-use `routersService` ownership check (`req.user.id, req.params.id`) so a router owned by someone else returns 404, not 403 (no information leak).

### 9.4 Installer (`backend/scripts/install.sh`) — co-install OpenNDS

The current install is single-purpose (just the agent). The OpenNDS-capable version needs a small block that:

1. Detects the package manager (`opkg` on OpenWrt, `apt`/`dnf` on x86) and skips on `--uninstall`.
2. Installs `opennds` and any required deps (`nodogsplash` is unrelated; `opennds` is in the OpenWrt `packages` feed for most targets).
3. Writes `/etc/config/opennds` (UCI) with the minimum needed:
   * `option gatewayinterface 'br-lan'`
   * `option maxclients '250'`
   * `option gatewayname 'mDEV Hotspot'`
   * `option gatewayaddress '192.168.10.1'` (sensible default; the install script can take `--nds-lan-ip` to override)
   * `option authentication 'none'` for the first cut (we’ll auth clients from the portal via the agent), or `'allow'` for an open splash.
4. Restart `opennds` (`/etc/init.d/opennds enable && /etc/init.d/opennds start`).
5. Verify by running `ndsctl status` and surfacing a non-zero exit to the user (this is the “did the install actually work?” check that V1 doesn’t have for the agent).

A **first-boot UCI hook** (or a small `/etc/hotplug.d/iface/95-mdev-opennds`) is **optional** for Phase 1: the portal UI can populate the per-client auth tokens via the agent (see §9.1) without OpenNDS needing to know about the portal. Defer the splash-page fork to a later phase.

### 9.5 What the install one-liner changes to

```
curl -fsSL "http://<host>/install.sh" -o /tmp/mdev_install.sh && \
sh /tmp/mdev_install.sh \
  --router-id my-router-01 \
  --mac  aa:bb:cc:dd:ee:ff \
  --server ws://<host>/ws \
  --token <installToken> \
  --with-opennds               # new flag, default-on in the next version
```

`--with-opennds=no` keeps the current behaviour for users who only want the agent.


---

## 10. Risks, gaps, and quick wins (sorted by ROI)

1. **No agent binary integrity check.** `install.sh` does `curl | sh` against the agent from the same origin. A compromised backend can ship anything. Add a `*.sha256` sidecar served at `/agent/<arch>.sha256` and `sha256sum -c` in the script before `chmod 0755`.
2. **No per-frame auth on the WS.** Once the upgrade is accepted, any client that can hold the socket can send `command` frames. Today the only producer of `command`s is the same backend, so the threat is internal — but a leaked install token plus a hijacked agent is enough to issue commands to *that router* (but not others). Recommend adding a short per-frame HMAC (e.g. `seq`+`mac`+`payload` HMAC-SHA256 with a per-router key derived from the install token) as a Phase 2 hardening.
3. **Install token in `?token=` query string.** Visible to proxies and access logs. Today the WS hub already accepts `Authorization: Bearer`; switch the C agent to that path (`WS_AUTH_INSTALL_TOKEN_BEARER`) and have the install script pass the token in the `Authorization` header (which `ws.c` does **not** yet build; add it). Optional but cheap.
4. **No login rate limit.** `/api/auth/login` is wide open to credential stuffing. Add a per-IP and per-email token bucket (e.g. 10/min/IP, 5/15min/email). Mirror the `install.controller.js` pattern.
5. **No `lastSeen` heartbeat from agent.** `registry.js` only updates `lastSeen` on `registerAgent` (i.e. on connect) and on `unregisterAgent` (i.e. on disconnect). A long-lived connection that’s silently dead (NAT timeout, cell tower handoff) shows as `online` until the next server-side ping fails (≤30s) — fine, but it means `lastSeen` is misleading in the DB. Add a tiny periodic `{"type":"heartbeat"}` from agent → hub (or piggyback on the existing client-initiated `OP_PING` with a `{"type":"heartbeat"}` text frame every 60s), and have the hub `updateOne({routerId}, {$set:{lastSeen: now}})` (fire-and-forget).
6. **Single-commit repo, no CI, no `.gitignore`.** Add:
   ```
   # root .gitignore
   node_modules/
   agent/build/
   frontend/build/
   frontend/dist/
   *.log
   .env
   .env.local
   .idea/  .vscode/  *.swp
   ```
   and a minimal GitHub Actions workflow (lint + typecheck + `agent make test`) before Phase 1 grows.
7. **Env-var drift in the one-liner** (called out in §4): `--server` is the WS URL, but the script also calls back to the HTTP origin for `/api/install/verify` and `/agent/<arch>`. They will diverge the moment someone fronts the backend with a CDN. Add `--api-base` to `install.sh` and have the backend emit it in the one-liner.
8. **`/api/install/verify` is rate-limited by IP only.** A small LAN can share an IP (CGN, hotel, captive-portal hot-spot itself). Add a per-MAC counter on top of the per-IP one.
9. **No `requestId` collision handling.** `sendCommandToRouter` uses `uuidv4`; collisions are negligible. But: if the **same** routerId has a command in-flight and a *second* command is sent before the first responds, both share `ws.pending` and there’s no ordering guarantee. OpenNDS commands are independent so this is fine in practice, but consider a per-router FIFO queue if user-visible ordering ever matters.
10. **No `frontend/nodemon.json` watches source.** The backend `nodemon.json` only watches its own `*.json`; same in the frontend. Devs are relying on Vite HMR for source changes (works) but config changes don’t restart either service. Low priority.
11. **`agent/src/util.c#mdev_random` falls back to `srandom()/random()` if `/dev/urandom` is unreadable.** Used only for WS frame masking, so security is unaffected; but it can mask deterministically if both `/dev/urandom` *and* `time()`/`getpid()` collide. Acceptable for masking, never for crypto.
12. **No per-router `lastSeen` index.** Queries by `(status, lastSeen)` (e.g. “find APs that were online 24h ago”) will table-scan. Defer until needed.

---

## 11. Recommended Phase 1 scope (minimal, testable)

Goal: prove the **agent → backend → portal UI** path for one OpenNDS action end-to-end before building the rest.

**In scope (Phase 1):**

1. **Agent** — add `client_list` action in `cmd.c` that runs `ndsctl json` and returns the parsed stdout as `response.data.clients`. Add a `ndsctl_path` config key. No other ndsctl actions.
2. **Backend** — new file `controllers/opennds.controller.js` mounted at `/api/routers/:id/opennds`. One route: `GET /clients` → `sendCommandToRouter(req.params.id, { action: 'client_list' }, 10_000)`. Re-use `routersService` ownership check.
3. **Frontend** — under `RouterDetailPage.tsx`, a “Connected clients (live)” section that calls `GET /api/routers/:id/opennds/clients` every 10s when `status === 'online'`, shows MAC, IP, auth time, and download/upload counters from the ndsctl payload. No new state library.
4. **Installer** — add a `--with-opennds` flag (default off in Phase 1) that installs `opennds` and writes a minimum `/etc/config/opennds`. Document the flag in `usage`.
5. **Docs** — extend this audit with a “Phase 1 done / Phase 2 plan” addendum.

**Explicitly out of scope (Phase 2+):**

* `client_auth` / `client_deauth` / `client_details` (Phase 2).
* Per-frame HMAC (Phase 3 hardening).
* Splash-page fork (UI change in `fas-aa-0.1.x`).
* Multiple-instance WS hub (Redis registry).
* Agent binary signing/checksums (Phase 3, or sooner if you front the backend with a CDN).
* OpenNDS FAS (“Forward Authentication Service”) callback (Phase 3; not needed for the basic list/auth/deauth).

**Definition of done for Phase 1:**

* An OpenWrt box with `opennds` + the new `mDEV_agent` builds, registers, and shows a non-empty client list in the portal UI when a device connects to the captive portal.
* A minimal integration test (`backend/scripts/e2e.sh` extended) drives the full path: spawn `fake-agent.js` with the new `client_list` action stubbed, call `GET /api/routers/:id/opennds/clients`, assert the parsed payload.
* All four C `agent/tests/run_tests.c` cases still pass.
* `docs/PHASE0_AUDIT.md` (this file) is updated with a “Phase 1: done” section.

---

## 12. Appendix — single-source references

* Agent binary build: `agent/Makefile` (`make`, `make MDEV_WITH_TLS=1`, `make test`).
* Agent wire protocol: `agent/src/cmd.c` (sends `hello`, `response`); `agent/src/ws.c` (handshake + keepalive); `agent/src/ws.h` (limits).
* Backend hub: `backend/src/websocket/hub.js`; registry: `backend/src/websocket/registry.js`.
* Install one-liner: `backend/src/controllers/install.controller.js` (serves the script and the agent binary) + `backend/src/services/routers.service.js#buildInstallCommand` (generates the curl line).
* Install script: `backend/scripts/install.sh` (the script that runs on the router).
* Schemas: `backend/src/models/Router.js`, `backend/src/models/User.js`.
* Frontend state: `frontend/src/features/auth/authSlice.ts`, `frontend/src/features/routers/routersSlice.ts`.
* Frontend routes: `frontend/src/routes/router.tsx`, pages under `frontend/src/pages/`.
* Env schema (backend): `backend/src/config/schema.js` (referenced from `config/index.js`).
* `.env.example` files: `backend/.env.example`, `frontend/.env.example` (referenced, not re-read in this audit).
* Tests: `agent/tests/run_tests.c` (host-side pure-logic tests), `backend/scripts/{e2e.sh,smoke.sh,fake-agent.js}` (integration).


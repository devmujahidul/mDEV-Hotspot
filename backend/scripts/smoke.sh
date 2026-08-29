#!/bin/bash
# Backend smoke test.  Uses an in-memory MongoDB so no external service
# is required.  Tests the new JWT-based auth + the routers CRUD endpoints.
set -e

cd "$(dirname "$0")/.."

# Pick a node binary
if [ -x "/tmp/mdevtest/node-v20.18.0-linux-x64/bin/node" ]; then
  NODE="/tmp/mdevtest/node-v20.18.0-linux-x64/bin/node"
elif command -v node >/dev/null 2>&1; then
  NODE="node"
else
  echo "No node binary found" >&2
  exit 1
fi

LOG="/tmp/mdevtest/backend.log"
PIDFILE="/tmp/mdevtest/backend.pid"
EMAIL="smoke+$$@example.com"
PASS="correct-horse-battery-staple"
# Port is configurable so the smoke test can run alongside a dev server
# (which usually owns :4000).  Override with TEST_HTTP_PORT if needed.
HTTP_PORT="${TEST_HTTP_PORT:-4000}"
BASE_URL="http://localhost:$HTTP_PORT"

cleanup() {
  if [ -f "$PIDFILE" ]; then
    kill "$(cat $PIDFILE)" 2>/dev/null || true
    rm -f "$PIDFILE"
  fi
}
trap cleanup EXIT

# Only kill a leftover backend from a *prior failed run of this script*
# (tracked by PIDFILE).  Never match -f 'src/server.js' broadly: that
# would kill a developer's running server.
if [ -f "$PIDFILE" ]; then
  kill "$(cat $PIDFILE)" 2>/dev/null || true
  rm -f "$PIDFILE"
fi

# Start server (relies on .env having JWT_SECRET + MONGO_URI pointing to
# a working Mongo. The e2e script handles the in-memory variant.)
PORT=$HTTP_PORT $NODE src/server.js > "$LOG" 2>&1 &
echo $! > "$PIDFILE"
sleep 2

if ! kill -0 "$(cat $PIDFILE)" 2>/dev/null; then
  echo "Server failed to start. Log:"
  cat "$LOG"
  exit 1
fi

ok()   { printf "  \033[32mOK\033[0m   %s\n" "$1"; }
fail() { printf "  \033[31mFAIL\033[0m %s\n" "$1"; exit 1; }

echo
echo "=== backend smoke test ==="

# /health
out=$(curl -s "$BASE_URL"/health)
echo "$out" | grep -q '"ok":true' && ok "/health" || fail "/health: $out"

# 1) No token -> 401 on /api/routers
code=$(curl -s -o /tmp/mdevtest/r1.json -w '%{http_code}' "$BASE_URL"/api/routers)
[ "$code" = "401" ] || fail "no-token expected 401 got $code"
grep -q '"unauthorized"' /tmp/mdevtest/r1.json && ok "no-token 401 structured" \
  || fail "no-token body: $(cat /tmp/mdevtest/r1.json)"

# 2) Register a user
code=$(curl -s -o /tmp/mdevtest/reg.json -w '%{http_code}' \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}" \
  "$BASE_URL"/api/auth/register)
[ "$code" = "201" ] || fail "register expected 201 got $code: $(cat /tmp/mdevtest/reg.json)"
TOKEN=$(node -e "console.log(JSON.parse(require('fs').readFileSync('/tmp/mdevtest/reg.json','utf8')).token)")
[ -n "$TOKEN" ] || fail "no token in register response"
ok "register 201 -> got JWT"

# 3) Re-register same email -> 409
code=$(curl -s -o /tmp/mdevtest/reg2.json -w '%{http_code}' \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}" \
  "$BASE_URL"/api/auth/register)
[ "$code" = "409" ] || fail "duplicate register expected 409 got $code"
grep -q '"conflict"' /tmp/mdevtest/reg2.json && ok "duplicate register 409" \
  || fail "dup body: $(cat /tmp/mdevtest/reg2.json)"

# 4) Login with bad password -> 401
code=$(curl -s -o /tmp/mdevtest/bad.json -w '%{http_code}' \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"wrong\"}" \
  "$BASE_URL"/api/auth/login)
[ "$code" = "401" ] || fail "bad login expected 401 got $code"
ok "bad password 401"

# 5) Login with right password -> 200
code=$(curl -s -o /tmp/mdevtest/login.json -w '%{http_code}' \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}" \
  "$BASE_URL"/api/auth/login)
[ "$code" = "200" ] || fail "login expected 200 got $code"
ok "login 200"

# 6) /api/auth/me with token -> 200 + user info
code=$(curl -s -o /tmp/mdevtest/me.json -w '%{http_code}' \
  -H "Authorization: Bearer $TOKEN" \
  "$BASE_URL"/api/auth/me)
[ "$code" = "200" ] || fail "me expected 200 got $code"
grep -q "$EMAIL" /tmp/mdevtest/me.json && ok "/me 200 with email" \
  || fail "/me body: $(cat /tmp/mdevtest/me.json)"

# 7) List routers (empty for new user) -> 200
code=$(curl -s -o /tmp/mdevtest/r2.json -w '%{http_code}' \
  -H "Authorization: Bearer $TOKEN" \
  "$BASE_URL"/api/routers)
[ "$code" = "200" ] || fail "list expected 200 got $code"
grep -q '"routers":\[\]' /tmp/mdevtest/r2.json && ok "list empty for new user" \
  || fail "list body: $(cat /tmp/mdevtest/r2.json)"

# 8) Register a router with valid MAC -> 201 + installToken returned
code=$(curl -s -o /tmp/mdevtest/rr.json -w '%{http_code}' \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"routerId":"home-01","name":"Home Router","macAddress":"AA:BB:CC:DD:EE:FF"}' \
  "$BASE_URL"/api/routers)
[ "$code" = "201" ] || fail "create router expected 201 got $code: $(cat /tmp/mdevtest/rr.json)"
grep -q '"installToken"' /tmp/mdevtest/rr.json && ok "create router returns installToken" \
  || fail "no installToken: $(cat /tmp/mdevtest/rr.json)"

# 9) Same routerId again -> 409
code=$(curl -s -o /tmp/mdevtest/rr2.json -w '%{http_code}' \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"routerId":"home-01","name":"Dup","macAddress":"11:22:33:44:55:66"}' \
  "$BASE_URL"/api/routers)
[ "$code" = "409" ] || fail "duplicate routerId expected 409 got $code"
ok "duplicate routerId 409"

# 10) Invalid MAC -> 400
code=$(curl -s -o /tmp/mdevtest/rr3.json -w '%{http_code}' \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"routerId":"home-02","macAddress":"not-a-mac"}' \
  "$BASE_URL"/api/routers)
[ "$code" = "400" ] || fail "invalid MAC expected 400 got $code"
ok "invalid MAC 400"

# 11) Reboot on a pending router -> 502 (not online)
code=$(curl -s -o /tmp/mdevtest/rb.json -w '%{http_code}' \
  -X POST -H "Authorization: Bearer $TOKEN" \
  "$BASE_URL"/api/routers/home-01/reboot)
[ "$code" = "502" ] || fail "reboot-pending expected 502 got $code: $(cat /tmp/mdevtest/rb.json)"
ok "reboot pending 502"

# 12) Unknown route -> 404
code=$(curl -s -o /tmp/mdevtest/r4.json -w '%{http_code}' \
  -H "Authorization: Bearer $TOKEN" "$BASE_URL"/api/nope)
[ "$code" = "404" ] || fail "bad route expected 404 got $code"
grep -q '"code":"not-found"' /tmp/mdevtest/r4.json && ok "bad route 404" \
  || fail "bad route body: $(cat /tmp/mdevtest/r4.json)"

echo
echo "=== ALL PASSED ==="


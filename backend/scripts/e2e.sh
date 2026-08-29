#!/bin/bash
# End-to-end test for the mDEV backend.
#
# Uses an in-memory MongoDB (mongodb-memory-server) so no external DB
# is required.  Tests the full user-auth + router-registration + agent
# hello with MAC verification + reboot roundtrip.
set -e

cd "$(dirname "$0")/.."

if [ -x "/tmp/mdevtest/node-v20.18.0-linux-x64/bin/node" ]; then
  NODE="/tmp/mdevtest/node-v20.18.0-linux-x64/bin/node"
else
  NODE="node"
fi

# Make sure the fake agent (in /tmp) can require('ws') from our node_modules.
export NODE_PATH="$PWD/node_modules:${NODE_PATH:-}"

LOG="/tmp/mdevtest/backend.log"
PIDFILE="/tmp/mdevtest/backend.pid"
MEMDB_LOG="/tmp/mdevtest/memdb.log"
MEMDB_PIDFILE="/tmp/mdevtest/memdb.pid"
EMAIL="e2e+$$@example.com"
PASS="correct-horse-battery-staple"
RID="fake-router-A"
MAC="aa:bb:cc:dd:ee:01"
# Ports are configurable so the tests can run alongside a dev server
# (which usually owns :4000).  Pick free ports via TEST_HTTP_PORT /
# TEST_MEMDB_PORT if needed.
HTTP_PORT="${TEST_HTTP_PORT:-4000}"
MEMDB_PORT="${TEST_MEMDB_PORT:-4100}"
BASE_URL="http://localhost:$HTTP_PORT"
WS_URL="ws://localhost:$HTTP_PORT/ws"

cleanup() {
  if [ -f "$PIDFILE" ]; then
    kill "$(cat $PIDFILE)" 2>/dev/null || true
    rm -f "$PIDFILE"
  fi
  if [ -f "$MEMDB_PIDFILE" ]; then
    kill "$(cat $MEMDB_PIDFILE)" 2>/dev/null || true
    rm -f "$MEMDB_PIDFILE"
  fi
  pkill -f fake-agent.js 2>/dev/null || true
  pkill -f start-memdb.js 2>/dev/null || true
}
trap cleanup EXIT

# Only clean up leftovers from a *prior failed run of this script*.  The
# ugly `pkill -f 'node src/server.js'` is deliberately NOT used here: it
# would kill a developer's running backend on :4000.
if [ -f "$PIDFILE" ]; then
  kill "$(cat $PIDFILE)" 2>/dev/null || true
  rm -f "$PIDFILE"
fi
pkill -9 -f start-memdb.js 2>/dev/null || true
pkill -9 -f fake-agent.js 2>/dev/null || true
sleep 1

# ---- 1) Start an in-memory MongoDB on MEMDB_PORT ----
cat > /tmp/mdevtest/start-memdb.js <<EOF
import { MongoMemoryServer } from '${PWD}/node_modules/mongodb-memory-server/index.js';
const srv = await MongoMemoryServer.create({ instance: { port: ${MEMDB_PORT} } });
console.log('MEMDB_URI=' + srv.getUri());
// Keep the process alive.
setInterval(() => {}, 1 << 30);
EOF
NODE_PATH="$PWD/node_modules" $NODE /tmp/mdevtest/start-memdb.js > "$MEMDB_LOG" 2>&1 &
echo $! > "$MEMDB_PIDFILE"

# Wait for the URI line
for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  if grep -q '^MEMDB_URI=' "$MEMDB_LOG" 2>/dev/null; then break; fi
  sleep 0.5
done
MEMDB_URI=$(grep '^MEMDB_URI=' "$MEMDB_LOG" | tail -1 | cut -d= -f2-)
[ -n "$MEMDB_URI" ] || { cat "$MEMDB_LOG"; echo "failed to start in-memory Mongo"; exit 1; }
echo "Using in-memory MongoDB: $MEMDB_URI"

# ---- 2) Start backend pointing at it ----
PORT=$HTTP_PORT \
JWT_SECRET=e2e-test-jwt-secret-at-least-16-chars \
MONGO_URI="$MEMDB_URI" \
ALLOWED_ORIGIN=http://localhost:5173 \
$NODE src/server.js > "$LOG" 2>&1 &
echo $! > "$PIDFILE"

for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -s -f "$BASE_URL/health" >/dev/null 2>&1; then break; fi
  sleep 0.5
done
curl -s -f "$BASE_URL/health" >/dev/null || { cat "$LOG"; exit 1; }
echo "Backend up."

ok()   { printf "  \033[32mOK\033[0m   %s\n" "$1"; }
fail() { printf "  \033[31mFAIL\033[0m %s\n" "$1"; cat "$LOG" /tmp/mdevtest/fake*.log 2>/dev/null; exit 1; }

echo
echo "=== e2e: auth + router registration + agent + reboot ==="

# 3) Register
code=$(curl -s -o /tmp/mdevtest/reg.json -w '%{http_code}' \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}" \
  "$BASE_URL/api/auth/register")
[ "$code" = "201" ] || fail "register expected 201 got $code: $(cat /tmp/mdevtest/reg.json)"
TOKEN=$(node -e "console.log(JSON.parse(require('fs').readFileSync('/tmp/mdevtest/reg.json','utf8')).token)")
ok "registered user, got JWT"

# 4) Register router $RID
code=$(curl -s -o /tmp/mdevtest/rr.json -w '%{http_code}' \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"routerId\":\"$RID\",\"name\":\"Fake A\",\"macAddress\":\"$MAC\"}" \
  "$BASE_URL/api/routers")
[ "$code" = "201" ] || fail "create router expected 201 got $code: $(cat /tmp/mdevtest/rr.json)"
ok "registered router $RID with MAC $MAC"

# 4b) Global MAC uniqueness: a different account cannot claim the same MAC
EMAIL2="e2e+2+$$@example.com"
code=$(curl -s -o /tmp/mdevtest/reg2.json -w '%{http_code}' \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL2\",\"password\":\"$PASS\"}" \
  "$BASE_URL/api/auth/register")
[ "$code" = "201" ] || fail "register second user expected 201 got $code: $(cat /tmp/mdevtest/reg2.json)"
TOKEN2=$(node -e "console.log(JSON.parse(require('fs').readFileSync('/tmp/mdevtest/reg2.json','utf8')).token)")
# Same MAC under a different routerId + different account -> 409
code=$(curl -s -o /tmp/mdevtest/macdup.json -w '%{http_code}' \
  -H "Authorization: Bearer $TOKEN2" -H 'Content-Type: application/json' \
  -d "{\"routerId\":\"$RID-other\",\"macAddress\":\"$MAC\"}" \
  "$BASE_URL/api/routers")
[ "$code" = "409" ] || fail "duplicate MAC across accounts expected 409 got $code: $(cat /tmp/mdevtest/macdup.json)"
grep -q '"conflict"' /tmp/mdevtest/macdup.json || fail "dup-MAC body: $(cat /tmp/mdevtest/macdup.json)"
ok "MAC is globally unique across accounts (409)"

# 4c) The install token is returned once on create; capture it for later tests
INSTALL_TOKEN=$(node -e "console.log(JSON.parse(require('fs').readFileSync('/tmp/mdevtest/rr.json','utf8')).router?.installToken)")
[ ${#INSTALL_TOKEN} -ge 20 ] || fail "create-router installToken suspiciously short: '$INSTALL_TOKEN'"
ok "create-router returns install token"

# 4d) /api/install/verify: happy path (correct token + MAC; arch omitted so
#     we don't require a prebuilt binary in CI)
out=$(curl -s -o /tmp/mdevtest/verify_ok.json -w '%{http_code}' \
  -H 'Content-Type: application/json' \
  -d "{\"routerId\":\"$RID\",\"token\":\"$INSTALL_TOKEN\",\"mac\":\"$MAC\"}" \
  "$BASE_URL/api/install/verify")
[ "$out" = "200" ] || fail "verify happy-path expected 200 got $out: $(cat /tmp/mdevtest/verify_ok.json)"
grep -q '"ok":true' /tmp/mdevtest/verify_ok.json || fail "verify happy-path body: $(cat /tmp/mdevtest/verify_ok.json)"
ok "verify endpoint accepts correct token + MAC"

# 4d2) verify: unsupported arch -> 400
out=$(curl -s -o /tmp/mdevtest/verify_arch400.json -w '%{http_code}' \
  -H 'Content-Type: application/json' \
  -d "{\"routerId\":\"$RID\",\"token\":\"$INSTALL_TOKEN\",\"mac\":\"$MAC\",\"arch\":\"powerpc\"}" \
  "$BASE_URL/api/install/verify")
[ "$out" = "400" ] || fail "verify unsupported-arch expected 400 got $out: $(cat /tmp/mdevtest/verify_arch400.json)"
grep -q 'unsupported-arch' /tmp/mdevtest/verify_arch400.json || fail "verify unsupported-arch code missing: $(cat /tmp/mdevtest/verify_arch400.json)"
ok "verify rejects unsupported arch (400)"

# 4d3) verify: allowed arch but no binary built -> still ok:true, but
#      reports binaryAvailable=false (CI has no prebuilt binaries)
out=$(curl -s -o /tmp/mdevtest/verify_arch404.json -w '%{http_code}' \
  -H 'Content-Type: application/json' \
  -d "{\"routerId\":\"$RID\",\"token\":\"$INSTALL_TOKEN\",\"mac\":\"$MAC\",\"arch\":\"x86_64\"}" \
  "$BASE_URL/api/install/verify")
[ "$out" = "200" ] || fail "verify supported-arch expected 200 got $out: $(cat /tmp/mdevtest/verify_arch404.json)"
grep -q '"binaryAvailable":false' /tmp/mdevtest/verify_arch404.json || fail "verify should report binaryAvailable=false in CI: $(cat /tmp/mdevtest/verify_arch404.json)"
ok "verify reports binaryAvailable=false for unbuilt arch (not a hard failure)"

# 4e) verify: MAC mismatch -> 409
out=$(curl -s -o /tmp/mdevtest/verify_mac.json -w '%{http_code}' \
  -H 'Content-Type: application/json' \
  -d "{\"routerId\":\"$RID\",\"token\":\"$INSTALL_TOKEN\",\"mac\":\"ff:ff:ff:ff:ff:ff\"}" \
  "$BASE_URL/api/install/verify")
[ "$out" = "409" ] || fail "verify MAC-mismatch expected 409 got $out: $(cat /tmp/mdevtest/verify_mac.json)"
grep -q 'mac-mismatch' /tmp/mdevtest/verify_mac.json || fail "verify MAC-mismatch code missing: $(cat /tmp/mdevtest/verify_mac.json)"
ok "verify rejects MAC mismatch (409 mac-mismatch)"

# 4f) verify: bad token -> 401
out=$(curl -s -o /tmp/mdevtest/verify_tok.json -w '%{http_code}' \
  -H 'Content-Type: application/json' \
  -d "{\"routerId\":\"$RID\",\"token\":\"wrong-token\",\"mac\":\"$MAC\"}" \
  "$BASE_URL/api/install/verify")
[ "$out" = "401" ] || fail "verify bad-token expected 401 got $out: $(cat /tmp/mdevtest/verify_tok.json)"
grep -q 'invalid-token' /tmp/mdevtest/verify_tok.json || fail "verify bad-token code missing: $(cat /tmp/mdevtest/verify_tok.json)"
ok "verify rejects bad install token (401 invalid-token)"

# 4g) verify: form-encoded body (as install.sh sends it) works too
out=$(curl -s -o /tmp/mdevtest/verify_form.json -w '%{http_code}' \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d "router_id=$RID&token=$INSTALL_TOKEN&mac=$MAC" \
  "$BASE_URL/api/install/verify")
[ "$out" = "200" ] || fail "verify form-encoded expected 200 got $out: $(cat /tmp/mdevtest/verify_form.json)"
grep -q '"ok":true' /tmp/mdevtest/verify_form.json || fail "verify form-encoded body: $(cat /tmp/mdevtest/verify_form.json)"
ok "verify accepts form-encoded body (install.sh format)"


# 5) Start fake agent that sends hello with this routerId + MAC, using the JWT
$NODE "$PWD/scripts/fake-agent.js" "$RID" "$MAC" "$TOKEN" "$WS_URL" > /tmp/mdevtest/fake.log 2>&1 &
sleep 2

# 6) List should show the router as online
out=$(curl -s -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/routers")
echo "$out" | grep -q "\"routerId\":\"$RID\"" || fail "router not in list: $out"
echo "$out" | grep -q '"status":"online"' || fail "router not online: $out"
ok "agent connected, router online"

# 7) Get single
out=$(curl -s -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/routers/$RID")
echo "$out" | grep -q '"macAddress":"aa:bb:cc:dd:ee:01"' && ok "GET single shows normalized MAC" \
  || fail "single body: $out"

# 8) Reboot roundtrip
out=$(curl -s -X POST -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/routers/$RID/reboot")
echo "$out" | grep -q '"ok":true' || fail "reboot: $out"
echo "$out" | grep -q 'reboot' || fail "no agent response: $out"
ok "reboot roundtrip OK"

# 9) Rotate install token returns refreshed router + once-shown token
out=$(curl -s -X POST -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/routers/$RID/rotate-token")
echo "$out" | grep -q '"router"' || fail "rotate-token missing router object: $out"
echo "$out" | grep -q '"routerId":"'$RID'"' || fail "rotate-token router lacks routerId: $out"
echo "$out" | grep -q '"installToken"' || fail "rotate-token missing installToken: $out"
echo "$out" | grep -q '"installCommand"' || fail "rotate-token missing installCommand: $out"
echo "$out" | grep -q "localhost:$HTTP_PORT/install.sh" || fail "rotate-token installCommand references wrong host: $out"
NEWTOKEN=$(node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).installToken)" <<<"$out")
[ ${#NEWTOKEN} -ge 20 ] || fail "rotate-token installToken suspiciously short: '$NEWTOKEN'"
ok "rotate-token returns refreshed router + once-shown token"

# 10) Wrong MAC agent should be rejected
$NODE "$PWD/scripts/fake-agent.js" "$RID" "ff:ff:ff:ff:ff:ff" "$TOKEN" "$WS_URL" > /tmp/mdevtest/fake-bad.log 2>&1 &
sleep 2
# The DB should still show the original MAC; the bad agent should not be online.
out=$(curl -s -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/routers/$RID")
echo "$out" | grep -q '"status":"online"' || fail "original router went offline unexpectedly: $out"
ok "wrong-MAC agent was rejected, original still online"

# 10b) Install-token WS auth: an agent connecting with ONLY the install
#      token (as a real installed agent does via ?token=) is accepted when
#      its MAC matches.  Use a second router so we don't disturb $RID.
RID2="fake-router-B"
MAC2="aa:bb:cc:dd:ee:02"
code=$(curl -s -o /tmp/mdevtest/rr2.json -w '%{http_code}' \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"routerId\":\"$RID2\",\"name\":\"Fake B\",\"macAddress\":\"$MAC2\"}" \
  "$BASE_URL/api/routers")
[ "$code" = "201" ] || fail "create router B expected 201 got $code: $(cat /tmp/mdevtest/rr2.json)"
TOKEN2_INSTALL=$(node -e "console.log(JSON.parse(require('fs').readFileSync('/tmp/mdevtest/rr2.json','utf8')).router?.installToken)")
[ ${#TOKEN2_INSTALL} -ge 20 ] || fail "router B installToken short: '$TOKEN2_INSTALL'"
$NODE "$PWD/scripts/fake-agent.js" "$RID2" "$MAC2" "$TOKEN2_INSTALL" "$WS_URL" --install-token > /tmp/mdevtest/fake-install.log 2>&1 &
sleep 2
out=$(curl -s -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/routers/$RID2")
echo "$out" | grep -q '"status":"online"' || fail "install-token agent not online: $out"
ok "agent connecting with install token (not JWT) is accepted when MAC matches"

# 10c) Install-token WS auth with a WRONG MAC must be rejected and the
#      router must NOT come online (or must not be bound to the bad MAC).
$NODE "$PWD/scripts/fake-agent.js" "$RID2" "ff:ff:ff:ff:ff:fe" "$TOKEN2_INSTALL" "$WS_URL" --install-token > /tmp/mdevtest/fake-install-bad.log 2>&1 &
sleep 2
out=$(curl -s -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/routers/$RID2")
echo "$out" | grep -q '"macAddress":"aa:bb:cc:dd:ee:02"' || fail "bad-MAC install-token agent changed registration: $out"
ok "install-token agent with wrong MAC is rejected"

# 10d) Install-token WS auth with a VALID jwt-style token but WRONG token
#      for the router must be rejected (deferred auth fails at hello).
$NODE "$PWD/scripts/fake-agent.js" "$RID2" "$MAC2" "not-the-right-install-token" "$WS_URL" --install-token > /tmp/mdevtest/fake-install-tok.log 2>&1 &
sleep 2
out=$(curl -s -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/routers/$RID2")
echo "$out" | grep -q '"status":"online"' || fail "router B unexpectedly went offline: $out"
ok "install-token agent with wrong token is rejected"


# 11) Install script + agent binary endpoints
out=$(curl -s -o /tmp/mdevtest/install.sh -w '%{http_code}' "$BASE_URL/install.sh")
[ "$out" = "200" ] || fail "install.sh expected 200 got $out"
head -1 /tmp/mdevtest/install.sh | grep -q '^#!/bin/sh' || fail "install.sh first line not shebang: $(head -1 /tmp/mdevtest/install.sh)"
grep -q 'sh -s -- --help\|--router-id\|--token\|--server' /tmp/mdevtest/install.sh \
  || fail "install.sh missing expected flags"
grep -q 'curl -fsSL' /tmp/mdevtest/install.sh || fail "install.sh missing curl fallback"
ok "install.sh served, contains required flags"

# 12) installCommand returned by create-router references this backend
cat /tmp/mdevtest/rr.json | grep -q 'installCommand' || fail "no installCommand in router response"
cat /tmp/mdevtest/rr.json | grep -q "localhost:$HTTP_PORT/install.sh" || fail "installCommand does not reference /install.sh"
ok "create-router installCommand references /install.sh on this host"

# 13) Bad arch is rejected
out=$(curl -s -o /tmp/mdevtest/agent400.txt -w '%{http_code}' "$BASE_URL/agent/bogus")
[ "$out" = "400" ] || fail "agent bogus expected 400 got $out"
grep -q 'Unknown arch' /tmp/mdevtest/agent400.txt || fail "agent bogus message wrong: $(cat /tmp/mdevtest/agent400.txt)"
ok "agent bad arch returns 400 with helpful message"

# 14) Unbuilt arch returns 404 (we don't ship prebuilts in CI)
out=$(curl -s -o /tmp/mdevtest/agent404.txt -w '%{http_code}' "$BASE_URL/agent/mipsel")
[ "$out" = "404" ] || fail "agent/mipsel expected 404 got $out (binary must not exist for this test)"
grep -q 'mDEV_agent-mipsel' /tmp/mdevtest/agent404.txt || fail "404 message wrong: $(cat /tmp/mdevtest/agent404.txt)"
ok "agent missing arch returns 404 with build instructions"

echo
echo "=== E2E PASSED ==="


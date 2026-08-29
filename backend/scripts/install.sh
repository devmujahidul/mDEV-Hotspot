#!/bin/sh
# mDEV Hotspot - one-line agent installer
#
# Usage (run on the OpenWrt/Linux router over SSH):
#
#   curl -fsSL "http://YOUR_BACKEND:4000/install.sh" -o /tmp/mdev_install.sh
#   sh /tmp/mdev_install.sh \
#       --router-id my-router-01 \
#       --token <INSTALL_TOKEN>
#
# Optional flags:
#   --server   ws://host:4000/ws        (default: derived from this script URL)
#   --mac      aa:bb:cc:dd:ee:ff        (default: auto-detect br-lan / eth0 / first non-lo iface)
#   --arch     mipsel|arm|aarch64|x86_64 (default: from uname -m)
#   --no-start                          (write config but don't start the service)
#   --uninstall                         (remove the agent + init script + config)
#   --help

set -e

# ---- Pretty output ----------------------------------------------------------
if [ -t 2 ]; then
  C_RED="\033[31m"; C_YEL="\033[33m"; C_GRN="\033[32m"; C_DIM="\033[2m"; C_RST="\033[0m"
else
  C_RED=""; C_YEL=""; C_GRN=""; C_DIM=""; C_RST=""
fi
log()  { printf "%b[mdev]%b %s\n"  "$C_DIM" "$C_RST" "$*"; }
ok()   { printf "%b[mdev]%b %b%s%b\n" "$C_DIM" "$C_RST" "$C_GRN" "$*" "$C_RST"; }
warn() { printf "%b[mdev]%b %b%s%b\n" "$C_DIM" "$C_RST" "$C_YEL" "$*" "$C_RST" 1>&2; }
err()  { printf "%b[mdev]%b %b%s%b\n" "$C_DIM" "$C_RST" "$C_RED" "$*" "$C_RST" 1>&2; }
die()  { err "$*"; exit 1; }

usage() {
  sed -n '3,20p' "$0" | sed 's/^# \{0,1\}//'
  # NOTE: do NOT `exit 0` here.  The `*)` arm of the arg parser below
  # calls `usage; exit 2` to report an unknown arg; if `usage` itself
  # exits 0 the error is silently swallowed and the script keeps going
  # with whatever half-baked state the parser left behind.  That bug
  # bit a user who pasted a line-wrapped install one-liner: the extra
  # wrapped tokens fell into `*)`, but `usage` exited 0, the rest of
  # the script ran with a truncated --token, and the failure surfaced
  # far away as a "verify" 401.  Returning here lets the caller decide.
  return 0
}

# ---- Defaults ---------------------------------------------------------------
ROUTER_ID=""
TOKEN=""
SERVER=""
MAC=""
ARCH=""
NO_START=0
UNINSTALL=0

while [ $# -gt 0 ]; do
  case "$1" in
    --router-id) ROUTER_ID="$2"; shift 2 ;;
    --router-id=*) ROUTER_ID="${1#*=}"; shift ;;
    --token)      TOKEN="$2"; shift 2 ;;
    --token=*)    TOKEN="${1#*=}"; shift ;;
    --server)     SERVER="$2"; shift 2 ;;
    --server=*)   SERVER="${1#*=}"; shift ;;
    --mac)        MAC="$2"; shift 2 ;;
    --mac=*)      MAC="${1#*=}"; shift ;;
    --arch)       ARCH="$2"; shift 2 ;;
    --arch=*)     ARCH="${1#*=}"; shift ;;
    --no-start)   NO_START=1; shift ;;
    --uninstall)  UNINSTALL=1; shift ;;
    -h|--help)    usage; exit 0 ;;
    *) err "Unknown argument: $1"; usage; exit 2 ;;
  esac
done

# ---- Validate token shape early --------------------------------------------
# Install tokens are 24 random bytes encoded as base64url, which is always
# exactly 32 chars from the alphabet [A-Za-z0-9_-].  Anything shorter,
# longer, or with non-base64url chars means the user almost certainly
# pasted a wrapped/truncated one-liner (terminal/SSH clients will
# hard-wrap a long command at the column boundary and the paste
# introduces a literal newline that splits the token in two).  Failing
# here gives a much clearer error than the downstream "verify" 401
# which only says the token is invalid with no hint about the cause.
#
# An empty token is also caught by the [ -z "$TOKEN" ] preflight check
# below, so this is purely a shape / length guard.
case "$TOKEN" in
  "")
    : # handled below
    ;;
  *[!A-Za-z0-9_-]*|"")
    die "Install token contains illegal characters or wrong length.  Re-copy the install command from the portal and paste it as a single line (your terminal may have wrapped the long command at the column boundary — paste the whole thing onto one line)."
    ;;
esac
if [ -n "$TOKEN" ] && [ "${#TOKEN}" -ne 32 ]; then
  die "Install token is ${#TOKEN} chars, expected 32.  The install one-liner was almost certainly wrapped on paste.  Re-copy from the portal and paste it on a single line."
fi

# ---- Derive backend origin --------------------------------------------------
if [ -z "$SERVER" ]; then
  SERVER="${MDEV_SERVER:-}"
fi
if [ -z "$SERVER" ]; then
  die "Could not determine backend server. Re-run with --server ws://host:4000/ws"
fi
ORIGIN_HTTP="$(printf '%s' "$SERVER" | sed -E 's|^ws://|http://|; s|^wss://|https://|; s|/ws$||')"

# ---- Host environment preflight --------------------------------------------
# This script runs on stock OpenWrt devices, which use BusyBox as the
# /bin/sh and userland.  Most things work, but a few coreutils-isms have
# bitten real installs.  The list below is the *minimum* set the rest of
# the script relies on.  Fail loudly up front if any are missing rather
# than at the bottom of the script (e.g. "install: not found" on the
# last line of a 90-second install).
#
# Note: we deliberately check `cp`/`chmod`/`rm`/`sed`/`tr`/`printf`/
# `cat`/`head`/`uname`/`basename`/`date` here only if the install is
# actually going to write files.  The --uninstall path needs fewer
# tools, so we keep the check focused on what we use *beyond* the
# uninstall branch.
missing=""
for tool in sh sed awk grep tr cp chmod rm cat head uname basename date killall; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    missing="$missing $tool"
  fi
done
if [ -n "$missing" ]; then
  die "Required tools are missing on this device:$missing.  OpenWrt 24.10 ships all of these in BusyBox; if you see this on a minimal image, run: opkg update && opkg install busybox"
fi

# ---- Architecture -----------------------------------------------------------
detect_arch() {
  m="$(uname -m 2>/dev/null || echo unknown)"
  case "$m" in
    mips|mipsel) echo "mipsel" ;;
    armv7l|armv6l|arm) echo "arm" ;;
    aarch64|arm64) echo "aarch64" ;;
    x86_64|amd64) echo "x86_64" ;;
    i386|i686) echo "x86" ;;
    *) echo "$m" ;;
  esac
}

# ---- MAC detection + normalization -----------------------------------------
detect_mac() {
  iface=""
  for cand in br-lan eth0 lan0 wlan0; do
    if [ -e "/sys/class/net/$cand/address" ]; then iface="$cand"; break; fi
  done
  if [ -z "$iface" ]; then
    for d in /sys/class/net/*/; do
      n="$(basename "$d")"
      case "$n" in lo) continue ;; esac
      [ -e "$d/address" ] && iface="$n" && break
    done
  fi
  [ -n "$iface" ] || return 1
  cat "/sys/class/net/$iface/address"
}

norm_mac() {
  s="$(printf '%s' "$1" | tr -d ' \t\r\n:.-' | tr 'A-F' 'a-f')"
  [ "${#s}" = 12 ] || return 1
  printf '%s' "$s" | sed -E 's|(..)(..)(..)(..)(..)(..)|\1:\2:\3:\4:\5:\6|'
}

# ---- Paths -----------------------------------------------------------------
BIN="/usr/bin/mDEV_agent"
CONF="/etc/mdev_agent.conf"
INIT="/etc/init.d/mdev_agent"
TMP_BIN="/tmp/mDEV_agent.$$"

# ---- Uninstall -------------------------------------------------------------
if [ "$UNINSTALL" = 1 ]; then
  log "Uninstalling mDEV agent..."
  [ -x /etc/init.d/mdev_agent ] && /etc/init.d/mdev_agent stop 2>/dev/null || true
  [ -x /etc/init.d/mdev_agent ] && /etc/init.d/mdev_agent disable 2>/dev/null || true
  rm -f "$BIN" "$CONF" "$INIT"
  ok "Uninstalled."
  exit 0
fi

# ---- Preflight -------------------------------------------------------------
[ -z "$ROUTER_ID" ] && die "--router-id is required"
[ -z "$TOKEN" ]      && die "--token is required"

if [ -z "$ARCH" ]; then
  ARCH="$(detect_arch)"
  log "Detected architecture: $ARCH"
fi

if [ -z "$MAC" ]; then
  if MAC_RAW="$(detect_mac 2>/dev/null)"; then
    if MAC="$(norm_mac "$MAC_RAW" 2>/dev/null)"; then
      log "Detected MAC: $MAC"
    else
      warn "Detected MAC ($MAC_RAW) is not a valid MAC; please pass --mac"
    fi
  else
    warn "Could not auto-detect MAC; please pass --mac"
  fi
fi
[ -n "$MAC" ] || die "MAC is required (use --mac aa:bb:cc:dd:ee:ff)"

# ---- Downloader ------------------------------------------------------------
fetch() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$2" "$1"
  else
    die "Neither curl nor wget found. Install one (opkg install curl)."
  fi
}

# Fetch the body of a URL regardless of HTTP status (for error surfacing).
fetch_body() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --max-time 15 "$1" 2>/dev/null
  elif command -v wget >/dev/null 2>&1; then
    wget -qO- --timeout=15 "$1" 2>/dev/null
  else
    echo ""
  fi
}

# ---- Pre-install verification ----------------------------------------------
# Ask the backend to confirm that this router's MAC + arch + install token
# are correct BEFORE we write anything to the device, so a wrong MAC or a
# mangled token can never produce a half-broken install.
verify() {
  log "Verifying install (router, MAC, arch, token) with the backend..."
  VERIFY_URL="$ORIGIN_HTTP/api/install/verify"
  VERIFY_BODY="router_id=$ROUTER_ID&token=$TOKEN&mac=$MAC&arch=$ARCH"

  VRESP=""
  if command -v curl >/dev/null 2>&1; then
    VRESP="$(curl -fsS --max-time 15 -H 'Content-Type: application/x-www-form-urlencoded' \
            -d "$VERIFY_BODY" "$VERIFY_URL" 2>/dev/null)" || VRESP=""
  elif command -v wget >/dev/null 2>&1; then
    VRESP="$(wget -qO- --post-data="$VERIFY_BODY" --header='Content-Type: application/x-www-form-urlencoded' \
            --timeout=15 "$VERIFY_URL" 2>/dev/null)" || VRESP=""
  else
    die "Neither curl nor wget found — cannot verify install."
  fi

  [ -n "$VRESP" ] || die "Verification request to $VERIFY_URL failed. Check --server and connectivity."

  case "$VRESP" in
    *'"code":"mac-mismatch"'*)
      REG=$(printf '%s' "$VRESP" | sed -n 's/.*"registeredMac":"\([^"]*\)".*/\1/p')
      die "MAC mismatch: this device is $MAC, but router '$ROUTER_ID' is registered with MAC $REG. Fix the registered MAC or run on the intended device."
      ;;
    *'"code":"invalid-token"'*)
      die "Invalid install token for router '$ROUTER_ID'.  Copy a fresh install command from the portal (the token may have been rotated, or the one-liner got wrapped on paste and the token arrived truncated — paste it on a single line)."
      ;;
    *'"ok":true'*|*'"ok": true'*)
      ok "Verification OK — proceeding with install."
      ;;
    *)
      MSG=$(printf '%s' "$VRESP" | sed -n 's/.*"message":"\([^"]*\)".*/\1/p')
      [ -n "$MSG" ] || MSG="$VRESP"
      die "Install verification failed: $MSG"
      ;;
  esac
}

# ---- Pre-install verification ----------------------------------------------
verify

# ---- Download + install agent ---------------------------------------------
log "Downloading mDEV_agent ($ARCH)..."
AGENT_URL="$ORIGIN_HTTP/agent/$ARCH"
if ! fetch "$AGENT_URL" "$TMP_BIN"; then
  err "Failed to download $AGENT_URL"
  BODY="$(fetch_body "$AGENT_URL")"
  # Strip a leading HTML tag if the server fell back to a page.
  MSG=$(printf '%s' "$BODY" | sed 's/<[^>]*>//g' | tr -d '\n' | head -c 300)
  [ -n "$MSG" ] && err "Server says: $MSG"
  err "If your arch is different, re-run with --arch mipsel|arm|aarch64|x86_64|x86"
  rm -f "$TMP_BIN"
  exit 1
fi
chmod +x "$TMP_BIN"

# Sanity: if the response is HTML (e.g. 404 page), abort.
if head -c 4 "$TMP_BIN" | grep -qi '<htm'; then
  err "Server returned HTML, not a binary. Check --server."
  rm -f "$TMP_BIN"; exit 1
fi

log "Installing to $BIN ..."
# BusyBox (the default /bin/sh + userland on most OpenWrt devices, including
# all 16 MB ramips targets) does NOT ship GNU coreutils' `install(1)`; it
# only provides `cp`.  An earlier version of this script called
# `install -m 0755 ...` and produced a confusing "install: not found"
# error on the very last line of an otherwise-successful install.  Using
# cp + chmod here is portable across BusyBox, GNU coreutils, BSD, and
# macOS.
cp -f "$TMP_BIN" "$BIN"
chmod 0755 "$BIN"
rm -f "$TMP_BIN"

# ---- Write config ----------------------------------------------------------
log "Writing $CONF ..."
TS="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown)"
# IMPORTANT: the init script sources this file with `. "$cfg"`, so each
# line MUST be a POSIX `name=value` assignment (no spaces around `=`,
# no quoting issues with `:` in the URL).  An earlier version of this
# script used `key  value` (two spaces, like /etc/hosts), which is
# parseable as plain text but NOT as a shell assignment.  /etc/rc.common
# then reported `server_url: not found` on every start and the service
# silently bailed out with "server_url missing".  Use the assignment
# form and quote the URL in case it ever contains shell-special chars.
cat > "$CONF" <<EOF
# mDEV Hotspot agent config - generated $TS
server_url="$SERVER"
router_id="$ROUTER_ID"
mac_address="$MAC"
token="$TOKEN"
EOF
chmod 0600 "$CONF"

# Sanity-check: the file we just wrote MUST be a shell-sourcable config,
# not a space-separated plain-text one.  The init script sources it with
# `. "$cfg"` and a non-assignment line like `server_url  ws://...` would
# silently fail with "server_url: not found" (BusyBox ash does NOT
# accept whitespace-separated `key value` form as a shell assignment).
# We `source` it into a sub-shell and check that every required var is
# non-empty.  This catches the bug *before* the service tries to start
# and prints the actual file contents for the user to inspect.
if ( . "$CONF" ) >/dev/null 2>&1; then
  :
else
  warn "Config file failed a shell-source sanity check.  Contents follow:"
  sed 's/^/    /' "$CONF" 1>&2
  die "Refusing to start with an un-sourceable config.  Please report this to the portal maintainer."
fi
. "$CONF"
missing_conf=""
for v in server_url router_id token; do
  eval "v_val=\$$v"
  [ -n "$v_val" ] || missing_conf="$missing_conf $v"
done
if [ -n "$missing_conf" ]; then
  warn "Config file is missing required values:$missing_conf.  Contents follow:"
  sed 's/^/    /' "$CONF" 1>&2
  die "Config is incomplete.  Please re-run the install one-liner."
fi
log "Config OK (server=$server_url router_id=$router_id mac=$mac_address token=${#token} chars)"
log "Config contents:"
sed 's/^/    /' "$CONF"

# ---- Init script (procd on OpenWrt, sysvinit fallback elsewhere) -----------
log "Writing $INIT ..."
cat > "$INIT" <<'EOS'
#!/bin/sh /etc/rc.common
# mDEV Hotspot agent init script
USE_PROCD=1
START=99
STOP=10

start_service() {
    local cfg="/etc/mdev_agent.conf"
    [ -f "$cfg" ] || { echo "mdev_agent: $cfg missing"; return 1; }

    # Reject configs that are not valid shell assignments.  This catches
    # the "server_url: not found" failure mode where the conf is plain
    # `key  value` text (e.g. /etc/hosts style) instead of POSIX
    # `key="value"` (which /etc/rc.common's `. "$cfg"` can actually
    # source).  We do this by sourcing the conf into a *subshell* and
    # checking the values there - the current shell's vars are not
    # affected, so the test is honest.  Doing it via `eval` against
    # the current shell's namespace (the previous version) was a
    # false-positive trap: it always reported all keys as missing.
    local _bad=0
    local _line _v
    for k in server_url router_id mac_address token; do
        # Run in a subshell with `set -u` so an unset var is loud.
        # The 2>/dev/null silences the noisy `xxx: not found` lines
        # from BusyBox ash when the conf isn't a valid shell script;
        # we re-print a clean per-key error just below.
        _v="$( set -u; . "$cfg" 2>/dev/null; eval "printf '%s' \"\${$k:-__UNSET__}\"" )" \
            || _v="__UNSET__"
        if [ "$_v" = "__UNSET__" ] || [ -z "$_v" ]; then
            echo "mdev_agent: $k missing in $cfg"
            _bad=1
        fi
    done
    [ "$_bad" = 1 ] && {
        echo "mdev_agent: $cfg is not a valid shell-sourceable config."
        echo "  Expected: key=\"value\"  (one per line, no space around =)"
        echo "  Got:"
        sed 's/^/    /' "$cfg"
        return 1
    }

    . "$cfg"
    [ -n "$server_url" ]  || { echo "mdev_agent: server_url missing"; return 1; }
    [ -n "$router_id" ]   || { echo "mdev_agent: router_id missing"; return 1; }
    [ -n "$token" ]       || { echo "mdev_agent: token missing"; return 1; }

    procd_open_instance
    procd_set_param command /usr/bin/mDEV_agent \
        -s "$server_url" \
        -i "$router_id" \
        ${mac_address:+-m "$mac_address"} \
        -t "$token"
    procd_set_param respawn 3600 5 5
    procd_set_param stdout 0
    procd_set_param stderr 1
    procd_set_param user root
    procd_close_instance
}

stop_service() {
    killall mDEV_agent 2>/dev/null || true
}
EOS
chmod +x "$INIT"

# ---- Enable + start --------------------------------------------------------
if [ "$NO_START" = 0 ]; then
  if [ -x /etc/init.d/mdev_agent ]; then
    /etc/init.d/mdev_agent enable 2>/dev/null || true
    if /etc/init.d/mdev_agent start; then
      ok "Service started."
    else
      warn "Service did not start cleanly. Try: /etc/init.d/mdev_agent start"
    fi
  else
    warn "$INIT is not executable; start it manually:"
    warn "  $BIN -s $SERVER -t ... -i $ROUTER_ID -m $MAC"
  fi
else
  log "--no-start given; not enabling or starting the service."
fi

cat <<EOF

${C_GRN}Installation complete.${C_RST}

  Router ID : $ROUTER_ID
  MAC       : $MAC
  Server    : $SERVER
  Binary    : $BIN
  Config    : $CONF
  Init      : $INIT

The agent should now appear as "online" in the mDEV portal.
If it does not, run:  /etc/init.d/mdev_agent status
EOF

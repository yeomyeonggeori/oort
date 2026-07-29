#!/usr/bin/env bash
# Draft `momo host add`: copy a target-compatible momo-workd over SSH and
# install it as a per-user launchd/systemd service. No inbound port is opened.
set -euo pipefail
umask 077

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/../.." && pwd)"

SSH_URL=""
BINARY_PATH="${MOMO_WORKD_BINARY:-}"
SERVER_URL="${MOMO_WORKD_SERVER_URL:-}"
WORKSPACE_ID="${MOMO_WORKD_WORKSPACE_ID:-}"
SCOPE="${MOMO_WORKD_SCOPE:-member}"
# ADR-0142 D1: a BYOC cloud host is a workspace-shared host the owner runs. It
# differs from an ordinary workd only in which register endpoint consumes the
# one-shot token, so it is a flag here rather than a second bootstrap script.
HOST_TYPE="${MOMO_WORKD_HOST_TYPE:-workd}"
DISPLAY_NAME="${MOMO_WORKD_DISPLAY_NAME:-momo workd}"
CHILD_ENV_MODE="${MOMO_WORKD_CHILD_ENV_MODE:-allowlist}"
ENV_PASSTHROUGH="${MOMO_WORKD_ENV_PASSTHROUGH:-}"
ALLOW_PROFILE_LEGACY_ENV="${MOMO_WORKD_ALLOW_PROFILE_LEGACY_ENV:-0}"
TOKEN_FILE="${MOMO_WORKD_REGISTRATION_TOKEN_FILE:-}"
SERVICE_KIND="auto"
DRY_RUN=0

usage() {
  cat <<'EOF'
Usage: infra/workd/bootstrap.sh ssh://user@host [options]

Options:
  --binary FILE             Target-compatible momo-workd binary
  --server-url HTTPS_URL    momo server origin
  --workspace UUID          Workspace to register the host in
  --scope member|workspace  Registry scope (default: member)
  --host-type workd|cloud   cloud = BYOC T3 host (requires --scope workspace)
  --display-name NAME       Host display label
  --token-file FILE         Local 0600 one-time human bearer file
  --service auto|systemd|launchd
  --dry-run                 Validate and print a redacted copy/install plan
  -h, --help                Show this help

The bearer must come from --token-file, MOMO_WORKD_REGISTRATION_TOKEN_FILE,
or MOMO_WORKD_REGISTRATION_TOKEN. It is copied as a mode-0600 one-time file and
deleted by momo-workd only after host registration and local host-id persistence.
The token value is never placed on an ssh/scp command line or printed.
EOF
}

fail() {
  printf '[momo-workd-bootstrap] %s\n' "$*" >&2
  exit 2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    ssh://*) [ -z "$SSH_URL" ] || fail "only one ssh URL is allowed"; SSH_URL="$1"; shift ;;
    --binary) BINARY_PATH="${2:-}"; shift 2 ;;
    --server-url) SERVER_URL="${2:-}"; shift 2 ;;
    --workspace) WORKSPACE_ID="${2:-}"; shift 2 ;;
    --scope) SCOPE="${2:-}"; shift 2 ;;
    --host-type) HOST_TYPE="${2:-}"; shift 2 ;;
    --display-name) DISPLAY_NAME="${2:-}"; shift 2 ;;
    --token-file) TOKEN_FILE="${2:-}"; shift 2 ;;
    --service) SERVICE_KIND="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) fail "unknown argument: $1" ;;
  esac
done

[ -n "$SSH_URL" ] || fail "ssh://user@host is required"
[ -n "$BINARY_PATH" ] || BINARY_PATH="$REPO_ROOT/workers/WorkHostDaemon/.build/release/momo-workd"
[ -f "$BINARY_PATH" ] && [ -x "$BINARY_PATH" ] || fail "target-compatible executable not found: $BINARY_PATH"
[ -n "$SERVER_URL" ] || fail "--server-url is required"
case "$SERVER_URL" in https://*) ;; *) fail "remote workd requires an https server URL" ;; esac
case "$SCOPE" in member|workspace) ;; *) fail "scope must be member or workspace" ;; esac
case "$HOST_TYPE" in workd|cloud) ;; *) fail "host type must be workd or cloud" ;; esac
# The daemon enforces this too; failing here keeps the operator from copying a
# binary and a live token onto a machine that could never register.
if [ "$HOST_TYPE" = "cloud" ] && [ "$SCOPE" != "workspace" ]; then
  fail "a BYOC cloud host is workspace-shared: use --scope workspace"
fi
case "$SERVICE_KIND" in auto|systemd|launchd) ;; *) fail "service must be auto, systemd, or launchd" ;; esac
[ "${#DISPLAY_NAME}" -le 80 ] && [ -n "$DISPLAY_NAME" ] || fail "display name must contain 1...80 characters"

PYTHON_BIN=""
for candidate in python3.13 python3.12 python3.11 python3.10 python3; do
  command -v "$candidate" >/dev/null 2>&1 || continue
  if "$candidate" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' >/dev/null 2>&1; then
    PYTHON_BIN="$candidate"
    break
  fi
done
[ -n "$PYTHON_BIN" ] || fail "Python 3.10+ is required"

parsed="$($PYTHON_BIN - "$SSH_URL" "$WORKSPACE_ID" <<'PY'
import re
import sys
import uuid
from urllib.parse import urlsplit

url = urlsplit(sys.argv[1])
if url.scheme != "ssh" or not url.username or not url.hostname or url.password:
    raise SystemExit(2)
if url.path not in ("", "/") or url.query or url.fragment:
    raise SystemExit(2)
if not re.fullmatch(r"[A-Za-z0-9._-]+", url.username):
    raise SystemExit(2)
if not re.fullmatch(r"[A-Za-z0-9.-]+", url.hostname):
    raise SystemExit(2)
port = url.port or 22
if not 1 <= port <= 65535:
    raise SystemExit(2)
workspace = str(uuid.UUID(sys.argv[2])).lower()
print(f"{url.username}@{url.hostname}")
print(port)
print(workspace)
PY
)" || fail "invalid ssh URL or workspace UUID"
SSH_TARGET="$(printf '%s\n' "$parsed" | sed -n '1p')"
SSH_PORT="$(printf '%s\n' "$parsed" | sed -n '2p')"
WORKSPACE_ID="$(printf '%s\n' "$parsed" | sed -n '3p')"

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/momo-workd-bootstrap.XXXXXX")"
cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  case "$TMP_DIR" in
    "${TMPDIR:-/tmp}"/momo-workd-bootstrap.*) rm -r -- "$TMP_DIR" ;;
    *) printf '[momo-workd-bootstrap] refusing unexpected cleanup path\n' >&2 ;;
  esac
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

LOCAL_TOKEN="$TMP_DIR/registration.token"
if [ -n "$TOKEN_FILE" ]; then
  [ -f "$TOKEN_FILE" ] || fail "registration token file not found"
  token_mode="$(stat -f '%Lp' "$TOKEN_FILE" 2>/dev/null || stat -c '%a' "$TOKEN_FILE" 2>/dev/null || true)"
  case "$token_mode" in 400|600) ;; *) fail "registration token file must be mode 0400 or 0600" ;; esac
  cp "$TOKEN_FILE" "$LOCAL_TOKEN"
elif [ -n "${MOMO_WORKD_REGISTRATION_TOKEN:-}" ]; then
  printf '%s\n' "$MOMO_WORKD_REGISTRATION_TOKEN" >"$LOCAL_TOKEN"
else
  fail "one-time registration token is required"
fi
chmod 600 "$LOCAL_TOKEN"

shell_quote() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

ENV_FILE="$TMP_DIR/workd.env"
{
  printf 'MOMO_WORKD_SERVER_URL=%s\n' "$(shell_quote "$SERVER_URL")"
  printf 'MOMO_WORKD_WORKSPACE_ID=%s\n' "$(shell_quote "$WORKSPACE_ID")"
  printf 'MOMO_WORKD_SCOPE=%s\n' "$(shell_quote "$SCOPE")"
  printf 'MOMO_WORKD_HOST_TYPE=%s\n' "$(shell_quote "$HOST_TYPE")"
  printf 'MOMO_WORKD_DISPLAY_NAME=%s\n' "$(shell_quote "$DISPLAY_NAME")"
  printf 'MOMO_WORKD_CHILD_ENV_MODE=%s\n' "$(shell_quote "$CHILD_ENV_MODE")"
  printf 'MOMO_WORKD_ENV_PASSTHROUGH=%s\n' "$(shell_quote "$ENV_PASSTHROUGH")"
  printf 'MOMO_WORKD_ALLOW_PROFILE_LEGACY_ENV=%s\n' "$(shell_quote "$ALLOW_PROFILE_LEGACY_ENV")"
  printf 'MOMO_WORKD_KEY_PATH=%s\n' "$(shell_quote '@WORKD_HOME@/.local/share/momo/workd.key')"
  printf 'MOMO_WORKD_HOST_ID_PATH=%s\n' "$(shell_quote '@WORKD_HOME@/.local/share/momo/workd.host-id')"
  printf 'MOMO_WORKD_OUTPUT_DIR=%s\n' "$(shell_quote '@WORKD_HOME@/.local/share/momo/workd-output')"
  printf 'MOMO_WORKD_REGISTRATION_TOKEN_FILE=%s\n' "$(shell_quote '@WORKD_HOME@/.config/momo/registration.token')"
} >"$ENV_FILE"
chmod 600 "$ENV_FILE"

REMOTE_STAGE=".momo-workd-bootstrap-$$"
if [ "$DRY_RUN" = "1" ]; then
  printf '[momo-workd-bootstrap] DRY RUN target=%s port=%s service=%s\n' "$SSH_TARGET" "$SSH_PORT" "$SERVICE_KIND"
  printf '[momo-workd-bootstrap] plan: copy binary/templates/private config -> install user service -> start outbound daemon\n'
  exit 0
fi

command -v ssh >/dev/null 2>&1 || fail "ssh is required"
command -v scp >/dev/null 2>&1 || fail "scp is required"
ssh -p "$SSH_PORT" -- "$SSH_TARGET" "umask 077; mkdir -p '$REMOTE_STAGE'"
scp -P "$SSH_PORT" -- \
  "$BINARY_PATH" \
  "$SCRIPT_DIR/momo-workd-run" \
  "$SCRIPT_DIR/momo-workd.service" \
  "$SCRIPT_DIR/app.momo.workd.plist" \
  "$ENV_FILE" \
  "$LOCAL_TOKEN" \
  "$SSH_TARGET:$REMOTE_STAGE/"

ssh -p "$SSH_PORT" -- "$SSH_TARGET" sh -s -- "$REMOTE_STAGE" "$SERVICE_KIND" <<'REMOTE'
set -eu
umask 077
stage="$1"
requested="$2"
cleanup() { rm -rf -- "$stage"; }
trap cleanup EXIT INT TERM

case "$stage" in .momo-workd-bootstrap-[0-9]*) ;; *) exit 2 ;; esac
case "$(uname -s)" in
  Linux) detected=systemd ;;
  Darwin) detected=launchd ;;
  *) echo "unsupported remote OS" >&2; exit 2 ;;
esac
if [ "$requested" != auto ] && [ "$requested" != "$detected" ]; then
  echo "requested service manager does not match remote OS" >&2
  exit 2
fi

home=$HOME
escaped_home=$(printf '%s' "$home" | sed 's/[&|]/\\&/g')
mkdir -p "$home/.local/bin" "$home/.local/libexec" "$home/.local/share/momo" "$home/.config/momo"
chmod 700 "$home/.local/share/momo" "$home/.config/momo"
install -m 755 "$stage/momo-workd" "$home/.local/bin/momo-workd"
install -m 755 "$stage/momo-workd-run" "$home/.local/libexec/momo-workd-run"
sed "s|@WORKD_HOME@|$escaped_home|g" "$stage/workd.env" >"$home/.config/momo/workd.env"
install -m 600 "$stage/registration.token" "$home/.config/momo/registration.token"
chmod 600 "$home/.config/momo/workd.env"

if [ "$detected" = systemd ]; then
  mkdir -p "$home/.config/systemd/user"
  sed "s|@WORKD_HOME@|$escaped_home|g" "$stage/momo-workd.service" >"$home/.config/systemd/user/momo-workd.service"
  systemctl --user daemon-reload
  systemctl --user enable --now momo-workd.service
  echo "momo-workd systemd user service installed"
  echo "For post-logout persistence, an administrator may run: loginctl enable-linger $USER"
else
  mkdir -p "$home/Library/LaunchAgents"
  sed "s|@WORKD_HOME@|$escaped_home|g" "$stage/app.momo.workd.plist" >"$home/Library/LaunchAgents/app.momo.workd.plist"
  launchctl bootout "gui/$UID" "$home/Library/LaunchAgents/app.momo.workd.plist" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$UID" "$home/Library/LaunchAgents/app.momo.workd.plist"
  echo "momo-workd launch agent installed"
fi
REMOTE

printf '[momo-workd-bootstrap] host bootstrap submitted; registration token remains remote only until first successful registration\n'

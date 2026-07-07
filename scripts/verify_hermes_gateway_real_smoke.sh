#!/usr/bin/env bash
# scripts/verify_hermes_gateway_real_smoke.sh — MOMO-326 real Hermes gateway smoke
#
# This verifier is intentionally credential-boundary aware:
# - It may read momo-facing pairing env from ~/.momo/hermes-gateway.env.
# - It never asks for, prints, stores, or forwards Codex/OpenAI provider tokens.
# - Provider OAuth/login must be completed by the user inside Hermes/provider.
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)

REQUIRE_REAL=0
TRIGGER_ROUNDTRIP=0
INSTALL_PLUGIN=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --require-real) REQUIRE_REAL=1 ;;
    --trigger) TRIGGER_ROUNDTRIP=1 ;;
    --install-plugin) INSTALL_PLUGIN=1 ;;
    -h|--help)
      cat <<'EOF'
Usage: scripts/verify_hermes_gateway_real_smoke.sh [--install-plugin] [--trigger] [--require-real]

Default mode records real Hermes readiness evidence without failing if the user
has not installed Hermes or completed provider OAuth yet.

  --install-plugin   Symlink repo adapters/hermes into $HERMES_HOME/plugins/momo.
  --trigger          Send @hermes through momo REST and wait for a gateway result.
  --require-real     Return non-zero unless the requested real path is ready/PASS.
EOF
      exit 0
      ;;
    *) echo "[hermes-gateway-real] unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

require_bin() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[hermes-gateway-real] missing required command: $1" >&2
    exit 1
  fi
}

json_escape() {
  python3 - "$1" <<'PY'
import json
import sys
print(json.dumps(sys.argv[1]))
PY
}

redacted_url() {
  python3 - "$1" <<'PY'
import sys
from urllib.parse import urlsplit, urlunsplit
raw = sys.argv[1]
if not raw:
    print("<missing>")
    raise SystemExit
p = urlsplit(raw)
host = p.hostname or ""
if ":" in host and not host.startswith("["):
    host = f"[{host}]"
netloc = host
if p.port is not None:
    netloc = f"{host}:{p.port}"
print(urlunsplit((p.scheme, netloc, p.path, "", "")))
PY
}

forbidden_provider_env_names() {
  local key
  for key in CODEX_OAUTH_TOKEN CODEX_OAUTH_ACCESS_TOKEN CODEX_OAUTH_REFRESH_TOKEN \
    CODEX_ACCESS_TOKEN CODEX_REFRESH_TOKEN CODEX_API_KEY CODEX_PROVIDER_API_KEY \
    OPENAI_OAUTH_TOKEN OPENAI_OAUTH_ACCESS_TOKEN OPENAI_OAUTH_REFRESH_TOKEN \
    OPENAI_ACCESS_TOKEN OPENAI_REFRESH_TOKEN OPENAI_API_KEY OPENAI_ADMIN_KEY \
    OPENAI_PROVIDER_API_KEY; do
    if [ "${!key+x}" ] && [ "${!key:-}" != "" ]; then
      printf '%s\n' "$key"
    fi
  done
}

EVIDENCE_DIR="${MOMO_HERMES_REAL_EVIDENCE_DIR:-${TMPDIR:-/tmp}/momo-hermes-gateway-real/$(date -u '+%Y%m%dT%H%M%SZ')}"
LOG_DIR="$EVIDENCE_DIR/logs"
SUMMARY="$EVIDENCE_DIR/summary.md"
EVENTS="$EVIDENCE_DIR/events.ndjson"
mkdir -p "$LOG_DIR"

event() {
  python3 - "$1" "$2" "$3" >>"$EVENTS" <<'PY'
import json
import sys
from datetime import datetime, timezone
print(json.dumps({
    "ts": datetime.now(timezone.utc).isoformat(),
    "stage": sys.argv[1],
    "status": sys.argv[2],
    "detail": sys.argv[3],
}, ensure_ascii=False))
PY
}

finish() {
  local result="$1"
  local detail="$2"
  {
    echo "# MOMO-326 real Hermes gateway smoke"
    echo
    echo "- result: \`${result}\`"
    echo "- detail: ${detail}"
    echo "- evidence: \`${EVIDENCE_DIR}\`"
    echo "- env file: \`${GATEWAY_ENV_FILE:-<missing>}\`"
    echo "- Hermes CLI: \`${HERMES_BIN_RESOLVED:-<missing>}\`"
    echo "- Hermes home: \`${HERMES_HOME_DIR}\`"
    echo "- plugin dir: \`${PLUGIN_DIR}\`"
    echo "- momo API: \`$(redacted_url "${MOMO_API_URL:-}")\`"
    echo "- credential boundary: Codex/OpenAI provider tokens are never read by this verifier."
  } >"$SUMMARY"
  echo "[hermes-gateway-real] ${result}: ${detail}"
  echo "[hermes-gateway-real] evidence: $SUMMARY"
  case "$result" in
    PASS|READY_FOR_TRIGGER|NEEDS_USER_INSTALL|NEEDS_PLUGIN_INSTALL|NEEDS_PROVIDER_LOGIN|NEEDS_MOMO_SERVER)
      [ "$REQUIRE_REAL" = "0" ] || [ "$result" = "PASS" ]
      ;;
    *)
      return 1
      ;;
  esac
}

require_bin curl
require_bin jq
require_bin python3

GATEWAY_ENV_FILE="${MOMO_HERMES_GATEWAY_ENV_FILE:-${HOME:-}/.momo/hermes-gateway.env}"
HERMES_HOME_DIR="${HERMES_HOME:-${HOME:-}/.hermes}"
PLUGIN_DIR="${MOMO_HERMES_PLUGIN_DIR:-${HERMES_HOME_DIR}/plugins/momo}"

if [ -f "$GATEWAY_ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$GATEWAY_ENV_FILE"
  set +a
  event env PASS "loaded momo-facing gateway env"
else
  event env NEEDS_PAIRING "missing $GATEWAY_ENV_FILE"
fi

MOMO_API_URL="${MOMO_API_URL:-${BASE_URL:-http://127.0.0.1:28180}}"
MOMO_WORKSPACE_ID="${MOMO_WORKSPACE_ID:-00000000-0000-7000-8000-000000000001}"
MOMO_AGENT_MEMBER_ID="${MOMO_AGENT_MEMBER_ID:-00000000-0000-7000-8000-000000000103}"
MOMO_AGENT_HANDLE="${MOMO_AGENT_HANDLE:-hermes}"
MOMO_DEFAULT_CHANNEL_ID="${MOMO_DEFAULT_CHANNEL_ID:-00000000-0000-7000-8000-000000000202}"
MOMO_AGENT_EMAIL="${MOMO_AGENT_EMAIL:-demo@momo.local}"
MOMO_AGENT_PASSWORD="${MOMO_AGENT_PASSWORD:-dev-password}"

forbidden_count="$(forbidden_provider_env_names | wc -l | tr -d '[:space:]')"
if [ "$forbidden_count" != "0" ]; then
  forbidden_provider_env_names >"$LOG_DIR/forbidden-provider-env.txt"
  event boundary FAIL "provider credential env is visible to momo verifier"
  finish BLOCKED_CREDENTIAL_BOUNDARY "unset provider OAuth/API token env before running momo smoke" || exit 1
  exit 1
fi
event boundary PASS "no known Codex/OpenAI provider credential env is visible"

HERMES_BIN_RESOLVED="${HERMES_BIN:-}"
if [ "$HERMES_BIN_RESOLVED" = "" ] && command -v hermes >/dev/null 2>&1; then
  HERMES_BIN_RESOLVED="$(command -v hermes)"
fi
if [ "$HERMES_BIN_RESOLVED" = "" ] && [ -x "$HERMES_HOME_DIR/bin/hermes" ]; then
  HERMES_BIN_RESOLVED="$HERMES_HOME_DIR/bin/hermes"
fi
if [ "$HERMES_BIN_RESOLVED" = "" ]; then
  event hermes_cli NEEDS_USER_INSTALL "hermes command not found"
  finish NEEDS_USER_INSTALL "install Hermes locally, then run scripts/momo hermes-gateway-install-plugin" || exit 1
  exit 0
fi
"$HERMES_BIN_RESOLVED" --version >"$LOG_DIR/hermes-version.log" 2>&1 || true
event hermes_cli PASS "$HERMES_BIN_RESOLVED"

if [ "$INSTALL_PLUGIN" = "1" ]; then
  mkdir -p "$(dirname "$PLUGIN_DIR")"
  if [ ! -e "$PLUGIN_DIR" ] && [ ! -L "$PLUGIN_DIR" ]; then
    ln -s "$REPO_ROOT/adapters/hermes" "$PLUGIN_DIR"
  fi
fi

if [ ! -f "$PLUGIN_DIR/adapter.py" ] || { [ ! -f "$PLUGIN_DIR/PLUGIN.yaml" ] && [ ! -f "$PLUGIN_DIR/plugin.yaml" ]; }; then
  event plugin NEEDS_PLUGIN_INSTALL "missing adapter.py or plugin manifest in $PLUGIN_DIR"
  finish NEEDS_PLUGIN_INSTALL "run scripts/momo hermes-gateway-install-plugin" || exit 1
  exit 0
fi
event plugin PASS "$PLUGIN_DIR"

"$HERMES_BIN_RESOLVED" gateway status >"$LOG_DIR/hermes-gateway-status.log" 2>&1 || true
event gateway_status RECORDED "wrote logs/hermes-gateway-status.log"

if [ "${MOMO_HERMES_PROVIDER_READY:-}" != "1" ]; then
  event provider_login NEEDS_PROVIDER_LOGIN "user has not marked provider OAuth/login ready"
  finish NEEDS_PROVIDER_LOGIN "complete provider OAuth/login inside Hermes, then rerun with MOMO_HERMES_PROVIDER_READY=1" || exit 1
  exit 0
fi
event provider_login USER_MARKED_READY "operator marked provider login ready"

if ! curl -fsS --max-time 3 "$MOMO_API_URL/health" >"$LOG_DIR/momo-health.json" 2>"$LOG_DIR/momo-health.err"; then
  event momo_server NEEDS_MOMO_SERVER "momo /health is not reachable"
  finish NEEDS_MOMO_SERVER "start momo in gateway mode with AGENT_GATEWAY_MODE=gateway and matching AGENT_GATEWAY_SECRET" || exit 1
  exit 0
fi
event momo_server PASS "$MOMO_API_URL/health"

if [ "$TRIGGER_ROUNDTRIP" != "1" ]; then
  event roundtrip READY_FOR_TRIGGER "real Hermes and momo are ready for user-triggered smoke"
  finish READY_FOR_TRIGGER "rerun with --trigger to send @${MOMO_AGENT_HANDLE}" || exit 1
  exit 0
fi

LOGIN_JSON="$(curl -fsS -X POST "$MOMO_API_URL/v1/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":$(json_escape "$MOMO_AGENT_EMAIL"),\"password\":$(json_escape "$MOMO_AGENT_PASSWORD"),\"workspace\":$(json_escape "$MOMO_WORKSPACE_ID")}")"
ACCESS_TOKEN="$(printf '%s' "$LOGIN_JSON" | jq -r '.accessToken // empty')"
if [ "$ACCESS_TOKEN" = "" ]; then
  event login FAIL "momo login returned no accessToken"
  printf '%s\n' "$LOGIN_JSON" >"$LOG_DIR/login-response.json"
  finish BLOCKED_MOMO_LOGIN "momo demo/operator login failed" || exit 1
  exit 1
fi
event login PASS "$MOMO_AGENT_EMAIL"

CLIENT_MSG_ID="$(uuidgen 2>/dev/null || python3 - <<'PY'
import uuid
print(uuid.uuid4())
PY
)"
BODY="@${MOMO_AGENT_HANDLE} MOMO-326 real Hermes gateway credentialed smoke $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
SEND_JSON="$(curl -fsS -X POST "$MOMO_API_URL/v1/workspaces/${MOMO_WORKSPACE_ID}/channels/${MOMO_DEFAULT_CHANNEL_ID}/messages" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H 'Content-Type: application/json' \
  -d "{\"clientMsgId\":\"${CLIENT_MSG_ID}\",\"type\":\"text\",\"body\":$(json_escape "$BODY"),\"props\":{\"gate\":\"MOMO-326\",\"path\":\"real-hermes-gateway\"}}")"
printf '%s\n' "$SEND_JSON" >"$LOG_DIR/send-response.json"
START_SEQ="$(printf '%s' "$SEND_JSON" | jq -r '.seq // 0')"
event send PASS "client_msg_id=${CLIENT_MSG_ID} seq=${START_SEQ}"

deadline=$(($(date +%s) + ${MOMO_HERMES_REAL_WAIT_SECONDS:-180}))
while [ "$(date +%s)" -lt "$deadline" ]; do
  HISTORY_JSON="$(curl -fsS "$MOMO_API_URL/v1/workspaces/${MOMO_WORKSPACE_ID}/channels/${MOMO_DEFAULT_CHANNEL_ID}/messages?after=${START_SEQ}&limit=50" \
    -H "Authorization: Bearer ${ACCESS_TOKEN}" || true)"
  if [ "$HISTORY_JSON" != "" ]; then
    printf '%s\n' "$HISTORY_JSON" >"$LOG_DIR/latest-history.json"
    FOUND="$(printf '%s' "$HISTORY_JSON" | jq -r --arg agent "$MOMO_AGENT_MEMBER_ID" '
      (.messages // .items // .data // [])[]
      | select((.authorMemberId // .author_member_id // "") == $agent)
      | select((.body // "") != "")
      | [.id, .seq, .body] | @tsv
    ' | head -n 1)"
    if [ "$FOUND" != "" ]; then
      event roundtrip PASS "$FOUND"
      finish PASS "same-channel Hermes gateway response observed" || exit 1
      exit 0
    fi
  fi
  sleep 2
done

event roundtrip FAIL "timed out waiting for Hermes gateway final message"
finish BLOCKED_REAL_ROUNDTRIP "sent @${MOMO_AGENT_HANDLE}, but no same-channel agent response arrived before timeout" || exit 1
exit 1

#!/usr/bin/env bash
# =============================================================================
# scripts/verify_external_agent_provider.sh — external agent provider/runtime gate
#
# Opt-in credentialed smoke for an external OpenAI-compatible agent runtime
# using Hermes as the seeded agent member. With no external credentials it
# exits successfully with explicit
# runtime-unverified evidence so default local/mock gates stay deterministic.
#
# MOMO-234/MOMO-238 boundary: momo never receives Codex/OpenAI OAuth tokens or
# GPT/OpenAI provider API keys. Those credentials belong inside the local Hermes
# runtime. This verifier only accepts a Hermes-facing bearer key for the
# OpenAI-compatible SSE boundary.
# =============================================================================
set -euo pipefail

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)
# shellcheck source=scripts/runtime_process_guard.sh
. "$REPO_ROOT/scripts/runtime_process_guard.sh"

fail() {
  FAILURE_CATEGORY="${1:-runtime}"
  FAILURE_REASON="${2:-external provider verifier failed}"
  RESULT="FAIL"
  write_evidence
  echo "[external-agent] FAIL: ${FAILURE_CATEGORY}: ${FAILURE_REASON}" >&2
  echo "[external-agent] evidence: ${EVIDENCE_FILE}" >&2
  exit 1
}

skip() {
  SKIP_REASON="${1:-external provider credentials are not configured}"
  RESULT="SKIP"
  RUNTIME_NOTE="runtime-unverified(external provider credentials)"
  write_evidence
  cat "$EVIDENCE_FILE"
  echo "[external-agent] SKIP: ${RUNTIME_NOTE} — ${SKIP_REASON}"
  exit 0
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "preflight" "missing required command: $1"
}

load_env_file() {
  local file="$1"
  local mode="${2:-preserve}"
  local line key value
  [ -f "$file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%"${line##*[![:space:]]}"}"
    case "$line" in
      ""|\#*) continue ;;
      export\ *) line="${line#export }" ;;
    esac
    case "$line" in
      *=*) ;;
      *) continue ;;
    esac
    key="${line%%=*}"
    value="${line#*=}"
    case "$key" in
      *[!A-Za-z0-9_]*|"") continue ;;
    esac
    if [ "$mode" = "preserve" ] && [ "${!key+x}" ]; then
      continue
    fi
    case "$value" in
      \"*\") value="${value#\"}"; value="${value%\"}" ;;
      \'*\') value="${value#\'}"; value="${value%\'}" ;;
    esac
    export "$key=$value"
  done < "$file"
}

lower() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}

is_placeholder_secret() {
  local lowered
  lowered="$(lower "$1")"
  case "$lowered" in
    ""|password|secret|token|default|dev|test|staging|prod|production|admin|momo) return 0 ;;
  esac
  case "$lowered" in
    *change-me*|*changeme*|*dev-insecure*|*placeholder*|*example*) return 0 ;;
  esac
  return 1
}

is_local_or_mock_host() {
  local lowered
  lowered="$(lower "$1")"
  case "$lowered" in
    localhost|127.0.0.1|0.0.0.0|::1|*mock*) return 0 ;;
  esac
  return 1
}

is_allowed_loopback_host() {
  local lowered
  lowered="$(lower "$1")"
  case "$lowered" in
    localhost|127.0.0.1|::1) return 0 ;;
  esac
  return 1
}

is_mock_host() {
  case "$(lower "$1")" in
    *mock*) return 0 ;;
  esac
  return 1
}

truthy() {
  case "$(lower "${1:-}")" in
    1|true|yes|on) return 0 ;;
  esac
  return 1
}

redacted_endpoint_label() {
  python3 - "$1" <<'PY'
import sys
from urllib.parse import urlsplit, urlunsplit

raw = sys.argv[1]
if not raw:
    print("not configured")
    raise SystemExit
try:
    parts = urlsplit(raw)
except Exception:
    print("invalid url")
    raise SystemExit
if not parts.scheme or not parts.hostname:
    print("invalid url")
    raise SystemExit
host = parts.hostname
if ":" in host and not host.startswith("["):
    host = f"[{host}]"
netloc = host
if parts.port is not None:
    netloc = f"{netloc}:{parts.port}"
print(urlunsplit((parts.scheme, netloc, parts.path, "", "")))
PY
}

sanitize_file() {
  local src="$1"
  local dst="$2"
  [ -f "$src" ] || return 0
  python3 - "$src" "$dst" "${HERMES_API_KEY:-}" <<'PY'
import re
import sys

src, dst, secret = sys.argv[1], sys.argv[2], sys.argv[3]
with open(src, "r", encoding="utf-8", errors="replace") as f:
    text = f.read()
if secret:
    text = text.replace(secret, "[REDACTED_HERMES_API_KEY]")
text = re.sub(r"Bearer\s+[A-Za-z0-9._~+/=-]+", "Bearer [REDACTED_BEARER]", text)
text = re.sub(r"(postgres(?:ql)?://[^:\s]+:)[^@\s]+(@)", r"\1[REDACTED]\2", text)
text = re.sub(r'("(?:accessToken|refreshToken|apiKey|token|password)"\s*:\s*")[^"]+(")', r"\1[REDACTED]\2", text)
text = re.sub(r"(?i)((?:codex|openai)[A-Z0-9_]*(?:oauth|access|refresh|api)[A-Z0-9_]*(?:token|secret|key)?\s*=\s*)[^\s]+", r"\1[REDACTED_PROVIDER_CREDENTIAL]", text)
with open(dst, "w", encoding="utf-8") as f:
    f.write(text)
PY
}

assert_file_does_not_contain_secret() {
  local file="$1"
  [ -f "$file" ] || return 0
  if [ "${HERMES_API_KEY:-}" != "" ] && grep -Fq -- "$HERMES_API_KEY" "$file"; then
    echo "[external-agent] refusing to keep evidence with raw HERMES_API_KEY: $file" >&2
    exit 1
  fi
}

validate_no_forbidden_codex_oauth_env() {
  local forbidden=()
  local key
  for key in CODEX_OAUTH_TOKEN CODEX_OAUTH_ACCESS_TOKEN CODEX_OAUTH_REFRESH_TOKEN \
    CODEX_ACCESS_TOKEN CODEX_REFRESH_TOKEN CODEX_API_KEY CODEX_PROVIDER_API_KEY \
    OPENAI_OAUTH_TOKEN OPENAI_OAUTH_ACCESS_TOKEN OPENAI_OAUTH_REFRESH_TOKEN \
    OPENAI_ACCESS_TOKEN OPENAI_REFRESH_TOKEN OPENAI_API_KEY OPENAI_ADMIN_KEY \
    OPENAI_PROVIDER_API_KEY; do
    if [ "${!key+x}" ] && [ "${!key:-}" != "" ]; then
      forbidden+=("$key")
    fi
  done
  if [ "${#forbidden[@]}" -gt 0 ]; then
    fail "credential-boundary" "Codex/OpenAI OAuth token or API key env must not be passed to momo verifier: $(IFS=', '; echo "${forbidden[*]}"). Configure provider credentials only inside the external runtime host."
  fi
}

artifact_line() {
  local label="$1"
  local file="$2"
  if [ -f "$file" ]; then
    echo "  - ${label}: \`${file}\`"
  fi
}

json_escape() {
  jq -Rn --arg v "$1" '$v'
}

psql_run() {
  if [ "${DATABASE_URL:-}" != "" ]; then
    "$PSQL_BIN" "$DATABASE_URL" -v ON_ERROR_STOP=1 --no-psqlrc "$@"
  else
    "$PSQL_BIN" -v ON_ERROR_STOP=1 --no-psqlrc "$@"
  fi
}

psql_scalar() {
  psql_run -t -A -c "$1" | tr -d '[:space:]'
}

cleanup() {
  momo_cleanup_tracked_pids "external-agent verifier" "${SERVER_PID:-}" "${WORKER_PID:-}" "${RELAY_PID:-}"
}
trap cleanup EXIT INT TERM

wait_http() {
  local url="$1"
  local name="$2"
  local deadline
  deadline=$(($(date +%s) + 60))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if curl -fsS "$url" >/dev/null 2>&1; then
      echo "[external-agent] ${name} ready"
      return 0
    fi
    sleep 1
  done
  return 1
}

write_evidence() {
  sanitize_file "$PROVIDER_ERR_FILE" "$PROVIDER_ERR_REDACTED_FILE"
  sanitize_file "$PROVIDER_SSE_FILE" "$PROVIDER_SSE_REDACTED_FILE"
  sanitize_file "$SERVER_LOG" "$SERVER_LOG_REDACTED"
  sanitize_file "$WORKER_LOG" "$WORKER_LOG_REDACTED"
  sanitize_file "$RELAY_LOG" "$RELAY_LOG_REDACTED"

  {
    echo "## MOMO-230/MOMO-234/MOMO-242/MOMO-256/MOMO-257 External Agent Runtime Smoke"
    echo "- Result: \`${RESULT:-UNKNOWN}\`"
    echo "- Runtime note: \`${RUNTIME_NOTE:-credentialed external provider path attempted}\`"
    echo "- Mode: \`${AGENT_PROVIDER_MODE:-<unset>}\`"
    echo "- Environment: \`${VERIFY_MOMO_ENV:-<unset>}\`"
    echo "- Model: \`${AGENT_MODEL:-<unset>}\`"
    echo "- Endpoint label: \`${ENDPOINT_LABEL:-not configured}\`"
    echo "- Stack env file: \`${ENV_FILE:-<none>}\`"
    echo "- Credential boundary ADR: \`docs/adr/0004-codex-oauth-hermes-provider-boundary.md\`"
    echo "- Codex/OpenAI credential boundary: momo app/API/DB/verifier receive no Codex/OpenAI OAuth token or API key; the external runtime host owns provider credential storage/refresh."
    echo "- Required credentialed smoke env: \`AGENT_PROVIDER_MODE=external-hermes\`, \`HERMES_BASE_URL=https://.../v1\`, \`HERMES_API_KEY\`, \`AGENT_MODEL\`. For local Codex/OAuth-backed Hermes setup, use \`scripts/verify_local_hermes_credentialed_smoke.sh\` and keep provider credentials in the provider host."
    echo "- Local loopback opt-in: \`MOMO_ENV=local AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK=1 HERMES_BASE_URL=http://127.0.0.1:<port>/v1\` or \`http://localhost:<port>/v1\`; non-loopback HTTP still fails fast."
    if [ "${EXTERNAL_AGENT_PROVIDER_ENV_FILE:-}" != "" ]; then
      echo "- Provider env file: configured (path withheld from summary; contents are not copied)"
    fi
    if [ "${RESULT:-}" = "SKIP" ]; then
      echo "- Skip reason: ${SKIP_REASON:-external provider credentials are not configured}"
      echo "- Internal alpha invite precondition: expected seeded/admin contract is Hermes as active agent member \`hermes\` in \`#agent-lab\`; runtime DB evidence is not run without external credentials."
      echo "- Coverage: default local/internal-alpha mock gates remain deterministic; Codex/OpenAI credentials remain provider-owned and unobserved by momo."
      echo "- Not covered: real external runtime side effect remains \`runtime-unverified(external provider credentials)\`."
    elif [ "${RESULT:-}" = "PASS" ]; then
      echo "- Internal alpha invite precondition: \`${INVITE_PRECONDITION_STATUS:-not-run}\` (active agent member + channel membership verified before send)."
      echo "- Provider preflight: OpenAI-compatible SSE \`/chat/completions\` returned stream data."
      echo "- Agent runtime status: \`/v1/agent-runtime/status\` reported external mode with redacted endpoint label, no provider key, and no degraded reason."
      echo "- Momo roundtrip: trigger_message_id=\`${AGENT_TRIGGER_MESSAGE_ID:-unknown}\`, run_id=\`${AGENT_RUN_ID:-unknown}\`, final_message_id=\`${FINAL_MESSAGE_ID:-unknown}\`, final_seq=\`${FINAL_MESSAGE_SEQ:-unknown}\`."
      echo "- Relay publish: Centrifugo history contained final \`message.new\` for the external-provider run."
      echo "- Provider response bytes: \`${PROVIDER_BYTES:-0}\` (content stored only in redacted artifact path below)."
      echo "- Coverage: local Docker stack + MomoServer + AgentWorker + OutboxRelay + external agent runtime SSE. Codex/OpenAI provider credentials, if used by the provider host, stayed outside momo."
    else
      echo "- Failure category: \`${FAILURE_CATEGORY:-unknown}\`"
      echo "- Failure reason: ${FAILURE_REASON:-unknown}"
      echo "- Coverage before failure: provider preflight status=\`${PROVIDER_PREFLIGHT_STATUS:-not-run}\`, runtime status=\`${RUNTIME_STATUS:-not-run}\`, momo roundtrip=\`${ROUNDTRIP_STATUS:-not-run}\`."
      if [ -f "$AGENT_STATUS_FILE" ]; then
        echo "- Degraded reason: \`$(jq -r '.degradedReason // "<none>"' "$AGENT_STATUS_FILE" 2>/dev/null || printf '<unavailable>')\`"
      fi
    fi
    echo "- Evidence artifacts:"
    echo "  - evidence: \`${EVIDENCE_FILE}\`"
    artifact_line "internal alpha invite precondition" "$INVITE_PRECONDITION_FILE"
    artifact_line "provider SSE redacted" "$PROVIDER_SSE_REDACTED_FILE"
    artifact_line "provider stderr redacted" "$PROVIDER_ERR_REDACTED_FILE"
    artifact_line "agent runtime status" "$AGENT_STATUS_FILE"
    artifact_line "channel history" "$CHANNEL_HISTORY_FILE"
    artifact_line "server log redacted" "$SERVER_LOG_REDACTED"
    artifact_line "worker log redacted" "$WORKER_LOG_REDACTED"
    artifact_line "relay log redacted" "$RELAY_LOG_REDACTED"
    echo "- Secret handling: \`HERMES_API_KEY\`, bearer tokens, DB passwords, auth tokens, and Codex/OpenAI OAuth/API key-shaped values are redacted from generated evidence."
  } > "$EVIDENCE_FILE"

  for file in "$EVIDENCE_FILE" "$PROVIDER_SSE_REDACTED_FILE" "$PROVIDER_ERR_REDACTED_FILE" \
    "$SERVER_LOG_REDACTED" "$WORKER_LOG_REDACTED" "$RELAY_LOG_REDACTED" "$AGENT_STATUS_FILE" "$CHANNEL_HISTORY_FILE" \
    "$INVITE_PRECONDITION_FILE"; do
    assert_file_does_not_contain_secret "$file"
  done
  rm -f "$PROVIDER_SSE_FILE" "$PROVIDER_ERR_FILE" "$SERVER_LOG" "$WORKER_LOG" "$RELAY_LOG"
}

validate_external_provider_env() {
  local errors=()
  local raw_url scheme authority host port local_loopback_allowed

  if [ "${AGENT_PROVIDER_MODE:-}" != "external-hermes" ]; then
    if [ "${EXTERNAL_AGENT_PROVIDER_REQUIRE_CREDENTIALS:-0}" = "1" ]; then
      fail "config" "AGENT_PROVIDER_MODE must be external-hermes"
    fi
    skip "AGENT_PROVIDER_MODE is not external-hermes; set external credentials to enable this opt-in smoke"
  fi

  raw_url="${HERMES_BASE_URL:-}"
  if [ "$raw_url" = "" ]; then
    errors+=("HERMES_BASE_URL is missing")
  elif [[ "$raw_url" != *://* ]]; then
    errors+=("HERMES_BASE_URL must be an absolute HTTP(S) URL")
  else
    scheme="${raw_url%%://*}"
    authority="${raw_url#*://}"
    authority="${authority%%/*}"
    host="${authority##*@}"
    host="${host%%:*}"
    port=""
    if [[ "$authority" == *":"* ]]; then
      port="${authority##*:}"
    fi
    local_loopback_allowed=0
    if truthy "${AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK:-0}" \
      && [ "$(lower "$VERIFY_MOMO_ENV")" = "local" ] \
      && is_allowed_loopback_host "$host"; then
      local_loopback_allowed=1
    fi
    if [[ "$authority" == *"@"* ]]; then
      errors+=("HERMES_BASE_URL must not include userinfo")
    fi
    if [[ "$raw_url" == *"?"* || "$raw_url" == *"#"* ]]; then
      errors+=("HERMES_BASE_URL must not include query or fragment")
    fi
    if [ "$host" = "" ]; then
      errors+=("HERMES_BASE_URL must include a host")
    elif is_mock_host "$host"; then
      errors+=("HERMES_BASE_URL must not point at mock-hermes for external-hermes")
    elif is_local_or_mock_host "$host" && [ "$local_loopback_allowed" != "1" ]; then
      errors+=("HERMES_BASE_URL must not point at localhost for external-hermes unless MOMO_ENV=local and AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK=1")
    fi
    case "$(lower "$scheme")" in
      https) ;;
      http)
        if [ "$local_loopback_allowed" != "1" ]; then
          errors+=("HERMES_BASE_URL must use https:// unless it is an explicit local-only loopback opt-in")
        elif [ "$port" = "" ] || [ "$port" = "$authority" ]; then
          errors+=("loopback HERMES_BASE_URL must include an explicit port")
        fi
        ;;
      *)
        errors+=("HERMES_BASE_URL must use http:// or https://")
        ;;
    esac
  fi

  if [ "${HERMES_API_KEY:-}" = "" ]; then
    errors+=("HERMES_API_KEY is missing")
  elif is_placeholder_secret "$HERMES_API_KEY"; then
    errors+=("HERMES_API_KEY uses a placeholder/dev value")
  fi

  if [ "${AGENT_MODEL:-}" = "" ]; then
    errors+=("AGENT_MODEL must not be empty")
  fi

  if [ "${#errors[@]}" -gt 0 ]; then
    fail "config" "$(IFS='; '; echo "${errors[*]}")"
  fi
}

provider_preflight() {
  local provider_url curl_code data_count
  provider_url="${HERMES_BASE_URL%/}/chat/completions"

  jq -cn \
    --arg model "$AGENT_MODEL" \
    --arg prompt "MOMO-257 credentialed external provider smoke. Reply with one short sentence." \
    '{model:$model,messages:[{role:"user",content:$prompt}],stream:true,stream_options:{include_usage:true},max_tokens:64}' \
    > "$PROVIDER_REQUEST_FILE"

  echo "[external-agent] checking external OpenAI-compatible SSE provider at ${ENDPOINT_LABEL}"
  set +e
  curl -fsS -N \
    --max-time "${EXTERNAL_AGENT_PROVIDER_DIRECT_TIMEOUT_SECONDS:-90}" \
    -H "Content-Type: application/json" \
    -H "Accept: text/event-stream" \
    -H "Authorization: Bearer ${HERMES_API_KEY}" \
    --data-binary "@${PROVIDER_REQUEST_FILE}" \
    "$provider_url" \
    > "$PROVIDER_SSE_FILE" 2> "$PROVIDER_ERR_FILE"
  curl_code=$?
  set -e
  sanitize_file "$PROVIDER_ERR_FILE" "$PROVIDER_ERR_REDACTED_FILE"
  sanitize_file "$PROVIDER_SSE_FILE" "$PROVIDER_SSE_REDACTED_FILE"
  if [ "$curl_code" -ne 0 ]; then
    PROVIDER_PREFLIGHT_STATUS="fail"
    fail "provider/network" "external provider SSE request failed with curl exit ${curl_code}"
  fi
  PROVIDER_BYTES="$(wc -c < "$PROVIDER_SSE_FILE" | tr -d '[:space:]')"
  data_count="$(grep -Ec '^data:[[:space:]]*' "$PROVIDER_SSE_FILE" || true)"
  if [ "$data_count" = "0" ]; then
    PROVIDER_PREFLIGHT_STATUS="fail"
    fail "provider/protocol" "external provider did not return SSE data lines"
  fi
  assert_file_does_not_contain_secret "$PROVIDER_SSE_REDACTED_FILE"
  PROVIDER_PREFLIGHT_STATUS="pass"
}

start_server() {
  if curl -fsS "$BASE_URL/health" >/dev/null 2>&1; then
    fail "runtime" "$BASE_URL is already serving /health; stop the existing server before running external provider smoke"
  fi
  echo "[external-agent] starting MomoServer with external provider mode"
  (
    cd "$REPO_ROOT"
    swift build --package-path server --product MomoServer >/dev/null
    SERVER_BIN="$(swift build --package-path server --show-bin-path)/MomoServer"
    exec env \
      MOMO_ENV="$VERIFY_MOMO_ENV" \
      DATABASE_URL="postgres://momo_app:momo_app_dev_pw@${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DB}" \
      PORT="$PORT" \
      CENT_API_URL="$CENT_API_URL" \
      CENT_API_KEY="$CENT_API_KEY" \
      JWT_HMAC="${JWT_HMAC:-change-me-jwt-hmac}" \
      AGENT_PROVIDER_MODE="external-hermes" \
      AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK="${AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK:-0}" \
      AGENT_MODEL="$AGENT_MODEL" \
      AGENT_HANDLE="${AGENT_HANDLE:-hermes}" \
      AGENT_DISPLAY_NAME="${AGENT_DISPLAY_NAME:-Hermes}" \
      HERMES_BASE_URL="$HERMES_BASE_URL" \
      HERMES_API_KEY="$HERMES_API_KEY" \
      "$SERVER_BIN"
  ) > "$SERVER_LOG" 2>&1 &
  SERVER_PID=$!

  local deadline
  deadline=$(($(date +%s) + 90))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
      sanitize_file "$SERVER_LOG" "$SERVER_LOG_REDACTED"
      fail "runtime/server" "MomoServer exited before /health became ready"
    fi
    if curl -fsS "$BASE_URL/health" >/dev/null 2>&1; then
      echo "[external-agent] MomoServer health is green"
      return 0
    fi
    sleep 1
  done
  sanitize_file "$SERVER_LOG" "$SERVER_LOG_REDACTED"
  fail "runtime/server" "timed out waiting for MomoServer /health"
}

start_relay() {
  echo "[external-agent] starting OutboxRelay"
  (
    cd "$REPO_ROOT"
    swift build --package-path relay/OutboxRelay --product OutboxRelay >/dev/null
    RELAY_BIN="$(swift build --package-path relay/OutboxRelay --show-bin-path)/OutboxRelay"
    exec env \
      RELAY_DATABASE_URL="postgres://momo_relay:momo_relay_dev_pw@${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DB}" \
      CENT_API_URL="$CENT_API_URL" \
      CENT_API_KEY="$CENT_API_KEY" \
      RELAY_POLL_INTERVAL_MS=100 \
      "$RELAY_BIN"
  ) > "$RELAY_LOG" 2>&1 &
  RELAY_PID=$!
}

start_worker() {
  echo "[external-agent] starting AgentWorker against external provider"
  (
    cd "$REPO_ROOT"
    swift build --package-path workers/AgentWorker --product AgentWorker >/dev/null
    WORKER_BIN="$(swift build --package-path workers/AgentWorker --show-bin-path)/AgentWorker"
    exec env \
      MOMO_ENV="$VERIFY_MOMO_ENV" \
      RELAY_DATABASE_URL="postgres://momo_worker:momo_worker_dev_pw@${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DB}" \
      CENT_API_URL="$CENT_API_URL" \
      CENT_API_KEY="$CENT_API_KEY" \
      AGENT_PROVIDER_MODE="external-hermes" \
      AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK="${AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK:-0}" \
      AGENT_MODEL="$AGENT_MODEL" \
      HERMES_BASE_URL="$HERMES_BASE_URL" \
      HERMES_API_KEY="$HERMES_API_KEY" \
      WORKER_POLL_INTERVAL_MS="${WORKER_POLL_INTERVAL_MS:-100}" \
      WORKER_MAX_ATTEMPTS="${WORKER_MAX_ATTEMPTS:-2}" \
      MAX_CONSECUTIVE_AUTO="${MAX_CONSECUTIVE_AUTO:-3}" \
      MAX_STEPS="${MAX_STEPS:-12}" \
      MAX_DEPTH="${MAX_DEPTH:-4}" \
      MAX_CONCURRENT_RUNS="${MAX_CONCURRENT_RUNS:-1}" \
      "$WORKER_BIN"
  ) > "$WORKER_LOG" 2>&1 &
  WORKER_PID=$!
}

verify_agent_runtime_status() {
  curl -fsS "$BASE_URL/v1/agent-runtime/status" > "$AGENT_STATUS_FILE"
  if ! jq -e --arg endpoint "$ENDPOINT_LABEL" --arg model "$AGENT_MODEL" '
      .schema == "momo.agent_runtime.status.v0"
      and .mode == "external-hermes"
      and .availability == "available"
      and .model == $model
      and .endpointLabel == $endpoint
      and .keyConfigured == true
      and ((.degradedReason // "") == "")
      and (.diagnostics | length == 0)
    ' "$AGENT_STATUS_FILE" >/dev/null; then
    RUNTIME_STATUS="fail"
    fail "runtime/status" "agent runtime status did not report available external-hermes with redacted endpoint label"
  fi
  assert_file_does_not_contain_secret "$AGENT_STATUS_FILE"
  RUNTIME_STATUS="pass"
}

verify_internal_alpha_invite_precondition() {
  echo "[external-agent] verifying local Hermes invite precondition"
  psql_run -t -A -c "
    SELECT jsonb_build_object(
             'schema', 'momo.internal_alpha.agent_invite_precondition.v0',
             'workspace_id', w.id,
             'workspace_slug', w.slug,
             'agent_member_id', m.id,
             'member_kind', m.kind::text,
             'member_status', m.status::text,
             'display_name', m.display_name,
             'handle', m.handle,
             'agent_model', a.model,
             'channel_id', c.id,
             'channel_name', c.name,
             'channel_membership_active', (ms.member_id IS NOT NULL AND ms.left_at IS NULL),
             'membership_role', ms.role::text
           )::text
      FROM workspace w
      JOIN member m
        ON m.workspace_id = w.id
       AND m.id = '${AGENT_ID}'
      JOIN agent a
        ON a.workspace_id = w.id
       AND a.member_id = m.id
      JOIN channel c
        ON c.workspace_id = w.id
       AND c.id = '${CHANNEL_ID}'
      LEFT JOIN membership ms
        ON ms.workspace_id = w.id
       AND ms.channel_id = c.id
       AND ms.member_id = m.id
     WHERE w.id = '${WORKSPACE_ID}';
  " > "$INVITE_PRECONDITION_FILE"

  if ! jq -e \
    --arg workspace "$WORKSPACE_ID" \
    --arg agent "$AGENT_ID" \
    --arg display "$AGENT_DISPLAY_NAME" \
    --arg handle "$AGENT_HANDLE" \
    --arg model "$AGENT_MODEL" \
    --arg channel "$CHANNEL_ID" '
      .schema == "momo.internal_alpha.agent_invite_precondition.v0"
      and .workspace_id == $workspace
      and .agent_member_id == $agent
      and .member_kind == "agent"
      and .member_status == "active"
      and .display_name == $display
      and .handle == $handle
      and .agent_model == $model
      and .channel_id == $channel
      and .channel_name == "agent-lab"
      and .channel_membership_active == true
    ' "$INVITE_PRECONDITION_FILE" >/dev/null; then
    INVITE_PRECONDITION_STATUS="fail"
    fail "runtime/invite-precondition" "Hermes is not an active invited member of #agent-lab"
  fi
  INVITE_PRECONDITION_STATUS="pass"
}

verify_roundtrip() {
  local login_json access_token send_payload send_json message_id deadline run_status final_ok live_ok
  login_json="$(curl -fsS \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"demo@momo.local\",\"password\":\"dev-password\",\"workspace\":\"${WORKSPACE_ID}\"}" \
    "$BASE_URL/v1/auth/login")"
  access_token="$(printf '%s' "$login_json" | jq -r '.accessToken // empty')"
  [ "$access_token" != "" ] || fail "runtime/auth" "demo login did not return access token"

  send_payload="$(jq -cn \
    --arg client "$CLIENT_MSG_ID" \
    --arg body "@${AGENT_HANDLE} MOMO-257 credentialed local Hermes provider smoke. Please reply briefly." \
    --arg agent "$AGENT_HANDLE" \
    '{clientMsgId:$client,type:"text",body:$body,props:{gate:"MOMO-257",provider:"external-hermes",agent_handle:$agent}}')"
  send_json="$(curl -fsS \
    -H "Authorization: Bearer ${access_token}" \
    -H "Content-Type: application/json" \
    -d "$send_payload" \
    "$BASE_URL/v1/workspaces/$WORKSPACE_ID/channels/$CHANNEL_ID/messages")"
  message_id="$(printf '%s' "$send_json" | jq -r '.id // empty')"
  [ "$message_id" != "" ] || fail "runtime/send" "agent mention send response did not include message id"
  AGENT_TRIGGER_MESSAGE_ID="$message_id"

  echo "[external-agent] waiting for AgentWorker external provider roundtrip"
  deadline=$(($(date +%s) + ${EXTERNAL_AGENT_PROVIDER_ROUNDTRIP_TIMEOUT_SECONDS:-180}))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if ! kill -0 "$WORKER_PID" 2>/dev/null; then
      sanitize_file "$WORKER_LOG" "$WORKER_LOG_REDACTED"
      ROUNDTRIP_STATUS="fail"
      fail "runtime/worker" "AgentWorker exited before completing external provider roundtrip"
    fi
    AGENT_RUN_ID="$(psql_scalar "SELECT id::text FROM agent_run WHERE workspace_id='${WORKSPACE_ID}' AND trigger_message_id='${AGENT_TRIGGER_MESSAGE_ID}' ORDER BY created_at DESC LIMIT 1;" || true)"
    if [ "$AGENT_RUN_ID" != "" ]; then
      run_status="$(psql_scalar "SELECT status FROM agent_run WHERE id='${AGENT_RUN_ID}';" || true)"
      FINAL_MESSAGE_ID="$(psql_scalar "SELECT id::text FROM message WHERE workspace_id='${WORKSPACE_ID}' AND channel_id='${CHANNEL_ID}' AND run_id='${AGENT_RUN_ID}' AND author_member_id='${AGENT_ID}' AND type='text' AND length(body) > 0 ORDER BY seq DESC LIMIT 1;" || true)"
      if [ "$FINAL_MESSAGE_ID" != "" ]; then
        FINAL_MESSAGE_SEQ="$(psql_scalar "SELECT seq::text FROM message WHERE id='${FINAL_MESSAGE_ID}';" || true)"
      fi
      final_ok=0
      [ "$run_status" = "succeeded" ] && [ "${FINAL_MESSAGE_ID:-}" != "" ] && final_ok=1
      curl -fsS \
        -H "X-API-Key: $CENT_API_KEY" \
        -H "Content-Type: application/json" \
        -d "{\"channel\":\"$CENT_CHANNEL\",\"limit\":100}" \
        "$CENT_API_URL/history" > "$CHANNEL_HISTORY_FILE" 2>/dev/null || true
      live_ok="$(jq -r --arg run "$AGENT_RUN_ID" '
        [.result.publications[]?.data
          | select(.type == "message.new")
          | select(((.payload.run_id // .payload.runId // "") | ascii_downcase) == ($run | ascii_downcase))
          | select(.payload.type == "text")
          | select((.payload.body // "") | length > 0)
          | select(.seq == .payload.seq)
        ] | length
      ' "$CHANNEL_HISTORY_FILE" 2>/dev/null || printf '0')"
      if [ "$final_ok" = "1" ] && [ "$live_ok" != "0" ]; then
        ROUNDTRIP_STATUS="pass"
        return 0
      fi
      if [ "$run_status" = "failed" ] || [ "$run_status" = "cancelled" ]; then
        ROUNDTRIP_STATUS="fail"
        fail "runtime/provider" "agent_run ended with status ${run_status}"
      fi
    fi
    sleep 2
  done
  ROUNDTRIP_STATUS="fail"
  fail "runtime/timeout" "timed out waiting for external provider @${AGENT_HANDLE} roundtrip"
}

if ! REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"; then
  echo "[external-agent] must run inside a git repository" >&2
  exit 1
fi
cd "$REPO_ROOT"

ENV_FILE="${ENV_FILE:-}"
if [ "$ENV_FILE" = "" ]; then
  for candidate in "$REPO_ROOT/.env.worktree" "$REPO_ROOT/.env" "$REPO_ROOT/infra/.env.example"; do
    if [ -f "$candidate" ]; then
      ENV_FILE="$candidate"
      break
    fi
  done
fi

[ "${ENV_FILE:-}" = "" ] || load_env_file "$ENV_FILE" preserve
if [ "${EXTERNAL_AGENT_PROVIDER_ENV_FILE:-}" != "" ]; then
  load_env_file "$EXTERNAL_AGENT_PROVIDER_ENV_FILE" override
fi

need curl
need jq
need python3
need swift

if command -v psql >/dev/null 2>&1; then
  PSQL_BIN="$(command -v psql)"
elif [ -x /opt/homebrew/opt/libpq/bin/psql ]; then
  PSQL_BIN=/opt/homebrew/opt/libpq/bin/psql
elif [ -x /usr/local/opt/libpq/bin/psql ]; then
  PSQL_BIN=/usr/local/opt/libpq/bin/psql
else
  PSQL_BIN=""
fi

AGENT_PROVIDER_MODE="${AGENT_PROVIDER_MODE:-}"
HERMES_BASE_URL="${HERMES_BASE_URL:-}"
HERMES_API_KEY="${HERMES_API_KEY:-}"
AGENT_MODEL="${AGENT_MODEL:-hermes-agent}"
AGENT_HANDLE="${AGENT_HANDLE:-hermes}"
AGENT_DISPLAY_NAME="${AGENT_DISPLAY_NAME:-Hermes}"
VERIFY_MOMO_ENV="${MOMO_ENV:-staging}"
AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK="${AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK:-0}"
ENDPOINT_LABEL="$(redacted_endpoint_label "$HERMES_BASE_URL")"

TMP_ROOT="${EXTERNAL_AGENT_PROVIDER_OUT_DIR:-${LOCAL_GATE_OUTPUT_DIR:-${TMPDIR:-/tmp}/momo-external-agent-provider}}"
RUN_SLUG="$(date -u +%Y%m%dT%H%M%SZ)-$$"
mkdir -p "$TMP_ROOT"
EVIDENCE_FILE="$TMP_ROOT/external-agent-provider-evidence-${RUN_SLUG}.md"
PROVIDER_REQUEST_FILE="$TMP_ROOT/external-agent-provider-request-${RUN_SLUG}.json"
PROVIDER_SSE_FILE="$TMP_ROOT/external-agent-provider-sse-${RUN_SLUG}.raw"
PROVIDER_SSE_REDACTED_FILE="$TMP_ROOT/external-agent-provider-sse-${RUN_SLUG}.redacted.log"
PROVIDER_ERR_FILE="$TMP_ROOT/external-agent-provider-curl-${RUN_SLUG}.raw"
PROVIDER_ERR_REDACTED_FILE="$TMP_ROOT/external-agent-provider-curl-${RUN_SLUG}.redacted.log"
AGENT_STATUS_FILE="$TMP_ROOT/external-agent-provider-status-${RUN_SLUG}.json"
CHANNEL_HISTORY_FILE="$TMP_ROOT/external-agent-provider-channel-history-${RUN_SLUG}.json"
SERVER_LOG="$TMP_ROOT/external-agent-provider-server-${RUN_SLUG}.raw.log"
SERVER_LOG_REDACTED="$TMP_ROOT/external-agent-provider-server-${RUN_SLUG}.redacted.log"
WORKER_LOG="$TMP_ROOT/external-agent-provider-worker-${RUN_SLUG}.raw.log"
WORKER_LOG_REDACTED="$TMP_ROOT/external-agent-provider-worker-${RUN_SLUG}.redacted.log"
RELAY_LOG="$TMP_ROOT/external-agent-provider-relay-${RUN_SLUG}.raw.log"
RELAY_LOG_REDACTED="$TMP_ROOT/external-agent-provider-relay-${RUN_SLUG}.redacted.log"
INVITE_PRECONDITION_FILE="$TMP_ROOT/external-agent-provider-invite-precondition-${RUN_SLUG}.json"

RESULT="UNKNOWN"
RUNTIME_NOTE="credentialed external provider path attempted"
PROVIDER_PREFLIGHT_STATUS="not-run"
RUNTIME_STATUS="not-run"
ROUNDTRIP_STATUS="not-run"
INVITE_PRECONDITION_STATUS="not-run"

validate_no_forbidden_codex_oauth_env
validate_external_provider_env

need docker
if [ "$PSQL_BIN" = "" ]; then
  fail "preflight" "psql not found; install PostgreSQL client/libpq and retry"
fi

POSTGRES_PORT="${POSTGRES_PORT:-5432}"
POSTGRES_HOST="${POSTGRES_HOST:-localhost}"
POSTGRES_DB="${POSTGRES_DB:-momo}"
PORT="${PORT:-8080}"
BASE_URL="${BASE_URL:-http://127.0.0.1:${PORT}}"
CENT_PORT="${CENT_PORT:-8000}"
CENT_API_KEY="${CENT_API_KEY:-dev-insecure-cent-api-key}"
CENT_API_URL="${CENT_API_URL:-http://localhost:${CENT_PORT}/api}"
case "$CENT_API_URL" in
  *centrifugo*) CENT_API_URL="http://localhost:${CENT_PORT}/api" ;;
esac

WORKSPACE_ID=00000000-0000-7000-8000-000000000001
HUMAN_ID=00000000-0000-7000-8000-000000000101
AGENT_ID=00000000-0000-7000-8000-000000000103
CHANNEL_ID=00000000-0000-7000-8000-000000000202
CENT_CHANNEL="ch:ws${WORKSPACE_ID}.${CHANNEL_ID}"
CLIENT_MSG_ID="${EXTERNAL_AGENT_PROVIDER_CLIENT_MSG_ID:-00000000-0000-7000-8000-000000257107}"

momo_cleanup_port_listener "$PORT" "external-agent API preflight" || {
  fail "preflight" "API port ${PORT} is occupied by a non-momo process; stop it or choose PORT override"
}

provider_preflight

echo "[external-agent] bootstrapping local Postgres/Centrifugo stack"
make ENV_FILE="$ENV_FILE" up
make ENV_FILE="$ENV_FILE" migrate

echo "[external-agent] ensuring runtime DB roles exist"
"$REPO_ROOT/scripts/verify_rls.sh" >/dev/null
verify_internal_alpha_invite_precondition

psql_run <<SQL
BEGIN;
SET LOCAL row_security = off;
SET LOCAL app.workspace_id = '$WORKSPACE_ID';
-- Repeatability is scoped to this verifier's deterministic client_msg_id. Do
-- not neutralize the seeded Hermes member/channel's whole queue because that
-- can cancel user-owned local dogfood work.
DELETE FROM outbox
 WHERE workspace_id = '$WORKSPACE_ID'
   AND (
     payload->>'client_msg_id' = '$CLIENT_MSG_ID'
     OR payload->'data'->'payload'->>'client_msg_id' = '$CLIENT_MSG_ID'
     OR payload->>'trigger_message_id' IN (
       SELECT id::text FROM message
        WHERE workspace_id = '$WORKSPACE_ID'
          AND client_msg_id = '$CLIENT_MSG_ID'
     )
   );
DELETE FROM usage_ledger
 WHERE run_id IN (
   SELECT id FROM agent_run
    WHERE workspace_id = '$WORKSPACE_ID'
      AND trigger_message_id IN (
        SELECT id FROM message
         WHERE workspace_id = '$WORKSPACE_ID'
           AND client_msg_id = '$CLIENT_MSG_ID'
      )
 );
DELETE FROM audit_log
 WHERE workspace_id = '$WORKSPACE_ID'
   AND target_id IN (
     SELECT id FROM message
      WHERE workspace_id = '$WORKSPACE_ID'
        AND client_msg_id = '$CLIENT_MSG_ID'
   );
DELETE FROM budget_window
 WHERE workspace_id = '$WORKSPACE_ID'
   AND budget_id IN (
     SELECT id FROM budget
      WHERE workspace_id = '$WORKSPACE_ID'
        AND agent_member_id = '$AGENT_ID'
        AND (channel_id IS NULL OR channel_id = '$CHANNEL_ID')
   );
DELETE FROM budget
 WHERE workspace_id = '$WORKSPACE_ID'
   AND agent_member_id = '$AGENT_ID'
   AND (channel_id IS NULL OR channel_id = '$CHANNEL_ID');
DELETE FROM message
 WHERE workspace_id = '$WORKSPACE_ID'
   AND run_id IN (
     SELECT id FROM agent_run
      WHERE workspace_id = '$WORKSPACE_ID'
        AND trigger_message_id IN (
          SELECT id FROM message
           WHERE workspace_id = '$WORKSPACE_ID'
             AND client_msg_id = '$CLIENT_MSG_ID'
        )
   );
DELETE FROM agent_run
 WHERE workspace_id = '$WORKSPACE_ID'
   AND trigger_message_id IN (
     SELECT id FROM message
      WHERE workspace_id = '$WORKSPACE_ID'
        AND client_msg_id = '$CLIENT_MSG_ID'
   );
DELETE FROM message
 WHERE workspace_id = '$WORKSPACE_ID'
   AND client_msg_id = '$CLIENT_MSG_ID';
COMMIT;
SQL

start_server
start_relay
start_worker
verify_agent_runtime_status
verify_roundtrip

RESULT="PASS"
write_evidence
cat "$EVIDENCE_FILE"
echo "[external-agent] MOMO-257 external provider smoke PASS"

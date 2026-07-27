#!/usr/bin/env bash
# =============================================================================
# scripts/verify_openapi_contract.sh — MOMO-389/MOMO-459 OpenAPI contract drift gate
#
# Verifies that the live server's response shapes (required keys + types)
# match docs/api/openapi.yaml — the canonical web v0 + plugin contract
# (ADR-0119 D4-A, ADR-0113, ADR-0115). Every documented operation is sampled against
# a running MomoServer and validated by scripts/openapi_shape_check.py with a
# closed-world policy: undeclared response keys, missing required keys, type
# mismatches, and unexpected nulls all FAIL (non-zero exit).
#
# Default mode boots its OWN isolated e2e compose stack
# (infra/docker-compose.e2e.yml) under a dedicated COMPOSE_PROJECT_NAME with
# non-default host ports, and tears it down afterwards. It never touches
# containers from other compose projects.
#
# Environment:
#   BASE_URL                       Verify an already-running server instead of
#                                  booting compose. Requires
#                                  OPENAPI_GATE_DATABASE_URL (superuser/owner)
#                                  for fixture install. Target must be a
#                                  DISPOSABLE gate stack seeded from
#                                  server/Migrations (fixtures write rows).
#   OPENAPI_GATE_DATABASE_URL      psql URL for fixture install in BASE_URL mode.
#   OPENAPI_GATE_COMPOSE_PROJECT   Compose project name (default: momo389gate).
#   OPENAPI_GATE_PORT              API host port      (default: 18980).
#   OPENAPI_GATE_POSTGRES_PORT     Postgres host port (default: 18981).
#   OPENAPI_GATE_CENT_PORT         Centrifugo port    (default: 18982).
#   OPENAPI_GATE_HERMES_PORT       mock-hermes port   (default: 18983).
#   OPENAPI_GATE_BOOT_TIMEOUT      Seconds to wait for /health (default: 2400 —
#                                  the api container cold-builds Swift).
#   OPENAPI_GATE_LIVEKIT_*         Optional API_KEY/API_SECRET/URL overrides.
#                                  BASE_URL mode must configure the target API.
#   OPENAPI_GATE_KEEP=1            Keep the compose stack up after the run.
#   OPENAPI_SPEC                   Spec path (default: docs/api/openapi.yaml).
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "[openapi] missing required command: $1" >&2
    exit 1
  }
}

need curl
need jq
need uuidgen

# Login shells on macOS can resolve /usr/bin/openssl (LibreSSL) before
# Homebrew OpenSSL 3. Pick a binary that actually supports Ed25519.
find_openssl() {
  local candidate probe
  probe="$(mktemp "${TMPDIR:-/tmp}/momo-openapi-openssl.XXXXXX")"
  for candidate in openssl /opt/homebrew/bin/openssl /usr/local/bin/openssl /usr/bin/openssl; do
    command -v "$candidate" >/dev/null 2>&1 || continue
    if "$candidate" genpkey -algorithm ED25519 -out "$probe" >/dev/null 2>&1; then
      rm -f "$probe"
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  rm -f "$probe"
  echo "[openapi] no OpenSSL with Ed25519 genpkey support found" >&2
  return 1
}
OPENSSL_BIN="$(find_openssl)"
# openapi_shape_check uses modern Python syntax/contracts. The gate PATH may
# prefer Xcode's Python 3.9, so select Python >= 3.10 explicitly (MOMO-458).
PYTHON_BIN=""
for cand in python3.13 python3.12 python3.11 python3.10 python3; do
  if command -v "$cand" >/dev/null 2>&1 && "$cand" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then
    PYTHON_BIN="$cand"; break
  fi
done
[ -n "$PYTHON_BIN" ] || { echo "[openapi] missing python >= 3.10" >&2; exit 1; }

SPEC_YAML="${OPENAPI_SPEC:-$REPO_ROOT/docs/api/openapi.yaml}"
[ -f "$SPEC_YAML" ] || { echo "[openapi] spec not found: $SPEC_YAML" >&2; exit 1; }

COMPOSE_FILE="$REPO_ROOT/infra/docker-compose.e2e.yml"
PROJECT="${OPENAPI_GATE_COMPOSE_PROJECT:-momo389gate}"
GATE_PORT="${OPENAPI_GATE_PORT:-18980}"
GATE_POSTGRES_PORT="${OPENAPI_GATE_POSTGRES_PORT:-18981}"
GATE_CENT_PORT="${OPENAPI_GATE_CENT_PORT:-18982}"
GATE_HERMES_PORT="${OPENAPI_GATE_HERMES_PORT:-18983}"
BOOT_TIMEOUT="${OPENAPI_GATE_BOOT_TIMEOUT:-2400}"
EXTERNAL_BASE_URL="${BASE_URL:-}"
MANAGED_STACK=0

RUN_EPOCH="$(date -u +%s)"
RUN_ID="${RUN_EPOCH}-$$"
TMP_DIR="${TMPDIR:-/tmp}/momo-openapi-gate-$RUN_ID"
mkdir -p "$TMP_DIR"
COMPOSE_OVERRIDE="$TMP_DIR/livekit-env.yml"
LIVEKIT_API_KEY="${OPENAPI_GATE_LIVEKIT_API_KEY:-openapi-gate-key}"
LIVEKIT_API_SECRET="${OPENAPI_GATE_LIVEKIT_API_SECRET:-openapi-gate-secret-$RUN_ID}"
LIVEKIT_URL="${OPENAPI_GATE_LIVEKIT_URL:-ws://127.0.0.1:7880}"
cat >"$COMPOSE_OVERRIDE" <<YAML
services:
  api:
    environment:
      MOMO_LIVEKIT_API_KEY: "$LIVEKIT_API_KEY"
      MOMO_LIVEKIT_API_SECRET: "$LIVEKIT_API_SECRET"
      MOMO_LIVEKIT_URL: "$LIVEKIT_URL"
      MOMO_TRANSCRIPTION_MODEL: small
      MOMO_DRIVE_ARCHIVE_BACKEND: stub
      MOMO_DRIVE_ARCHIVE_STUB_BASE_URL: "http://127.0.0.1:$GATE_PORT"
YAML
SPEC_JSON="$TMP_DIR/openapi.json"
MANIFEST="$TMP_DIR/manifest.jsonl"
: >"$MANIFEST"

DEMO_WORKSPACE_ID="00000000-0000-7000-8000-000000000001"
GENERAL_CHANNEL_ID="00000000-0000-7000-8000-000000000201"
KIM_INTERN_MEMBER_ID="00000000-0000-7000-8000-000000000102"
GATE_MEMBER_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
GATE_AGENT_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
GATE_EMAIL="gate-$RUN_ID@momo.local"
# Random per run: in BASE_URL(external stack) mode the fixture member row can
# outlive the gate, so it must never carry a well-known password (PR #404
# review Low-1). Override only for deterministic debugging.
GATE_PASSWORD="${OPENAPI_GATE_PASSWORD:-gate-$(uuidgen | tr '[:upper:]' '[:lower:]')}"
GATE_HANDLE="gate-$RUN_EPOCH"
JOIN_EMAIL="gate-join-$RUN_ID@momo.local"
INVITE_CODE="gate-invite-$(uuidgen | tr '[:upper:]' '[:lower:]')"
RUN_UUID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
APPROVAL_UUID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
CONTROL_RUN_UUID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
CANCEL_RUN_UUID="$(uuidgen | tr '[:upper:]' '[:lower:]')"

compose() {
  PORT="$GATE_PORT" \
  POSTGRES_PORT="$GATE_POSTGRES_PORT" \
  CENT_PORT="$GATE_CENT_PORT" \
  HERMES_PORT="$GATE_HERMES_PORT" \
  docker compose -p "$PROJECT" -f "$COMPOSE_FILE" -f "$COMPOSE_OVERRIDE" "$@"
}

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if [ "$MANAGED_STACK" -eq 1 ]; then
    if [ "${OPENAPI_GATE_KEEP:-0}" = "1" ]; then
      echo "[openapi] OPENAPI_GATE_KEEP=1 — leaving compose project '$PROJECT' up"
    else
      echo "[openapi] tearing down compose project '$PROJECT'"
      compose down -v --remove-orphans >/dev/null 2>&1 || true
    fi
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# ---- 1) Spec YAML -> JSON (ruby is a docs-gate dependency; python-yaml fallback)
convert_spec() {
  if command -v ruby >/dev/null 2>&1; then
    if ruby -ryaml -rjson -e \
      'puts JSON.generate(YAML.load_file(ARGV[0], aliases: true))' \
      "$SPEC_YAML" >"$SPEC_JSON" 2>/dev/null; then
      return 0
    fi
    if ruby -ryaml -rjson -e \
      'puts JSON.generate(YAML.load_file(ARGV[0]))' \
      "$SPEC_YAML" >"$SPEC_JSON" 2>/dev/null; then
      return 0
    fi
  fi
  if "$PYTHON_BIN" -c "import yaml" >/dev/null 2>&1; then
    "$PYTHON_BIN" -c \
      'import json,sys,yaml; json.dump(yaml.safe_load(open(sys.argv[1])), sys.stdout)' \
      "$SPEC_YAML" >"$SPEC_JSON"
    return 0
  fi
  echo "[openapi] need ruby (with yaml/json) or python3+PyYAML to parse the spec" >&2
  exit 1
}
convert_spec
jq -e '.openapi and .paths' "$SPEC_JSON" >/dev/null || {
  echo "[openapi] spec did not parse into an OpenAPI document" >&2
  exit 1
}
echo "[openapi] spec parsed: $SPEC_YAML"

port_in_use() {
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null && { exec 3>&- 3<&-; return 0; }
  return 1
}

# ---- 2) Server: external BASE_URL or self-managed e2e compose stack ---------
if [ -n "$EXTERNAL_BASE_URL" ]; then
  BASE_URL="$EXTERNAL_BASE_URL"
  [ -n "${OPENAPI_GATE_DATABASE_URL:-}" ] || {
    echo "[openapi] BASE_URL mode requires OPENAPI_GATE_DATABASE_URL for fixture install" >&2
    exit 1
  }
  need psql
  echo "[openapi] using external server: $BASE_URL"
else
  need docker
  for p in "$GATE_PORT" "$GATE_POSTGRES_PORT" "$GATE_CENT_PORT" "$GATE_HERMES_PORT"; do
    if port_in_use "$p"; then
      # A stale run of THIS project may legitimately hold the port; reuse it.
      if [ -z "$(compose ps -q --status running 2>/dev/null)" ]; then
        echo "[openapi] host port $p is busy and not owned by compose project '$PROJECT'." >&2
        echo "[openapi] Override with OPENAPI_GATE_PORT/OPENAPI_GATE_POSTGRES_PORT/OPENAPI_GATE_CENT_PORT/OPENAPI_GATE_HERMES_PORT." >&2
        exit 1
      fi
    fi
  done
  BASE_URL="http://127.0.0.1:$GATE_PORT"
  MANAGED_STACK=1
  echo "[openapi] booting e2e compose project '$PROJECT' (api on $BASE_URL)"
  compose up -d api

  echo "[openapi] waiting for $BASE_URL/health (timeout ${BOOT_TIMEOUT}s; cold Swift build can take many minutes)"
  deadline=$(( $(date -u +%s) + BOOT_TIMEOUT ))
  until curl -fsS "$BASE_URL/health" >/dev/null 2>&1; do
    if [ "$(date -u +%s)" -ge "$deadline" ]; then
      echo "[openapi] timed out waiting for server health" >&2
      compose logs --tail 80 api >&2 || true
      exit 1
    fi
    if [ -n "$(compose ps -aq --status exited api 2>/dev/null)" ]; then
      echo "[openapi] api container exited before health became green" >&2
      compose logs --tail 120 api >&2 || true
      exit 1
    fi
    sleep 3
  done
  echo "[openapi] server health is green"
fi

# ---- 3) Fixtures (dedicated gate member; seed rows untouched) ----------------
run_sql() {
  if [ -n "$EXTERNAL_BASE_URL" ]; then
    psql "$OPENAPI_GATE_DATABASE_URL" -v ON_ERROR_STOP=1 --no-psqlrc -q
  else
    compose exec -T postgres psql -U "${POSTGRES_USER:-momo}" -d "${POSTGRES_DB:-momo}" \
      -v ON_ERROR_STOP=1 --no-psqlrc -q
  fi
}

echo "[openapi] installing gate fixtures (member/agent/invite/approval)"
run_sql <<SQL
BEGIN;
SET LOCAL app.workspace_id = '$DEMO_WORKSPACE_ID';
SET LOCAL row_security = off;

DO \$\$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM agent WHERE member_id = '$KIM_INTERN_MEMBER_ID'
  ) THEN
    RAISE EXCEPTION
      'agent seed missing — run the e2e stack with MOMO_AGENT_SEED_MODE=e2e (002_seed.sql)';
  END IF;
END \$\$;

-- Dedicated gate human with workspace-admin channel role in #general.
INSERT INTO member (id, workspace_id, kind, status, display_name, handle)
VALUES ('$GATE_MEMBER_ID', '$DEMO_WORKSPACE_ID', 'human', 'active',
        'OpenAPI Gate', '$GATE_HANDLE'),
       ('$GATE_AGENT_ID', '$DEMO_WORKSPACE_ID', 'agent', 'active',
        'OpenAPI Gate Agent', 'gate-agent-$RUN_EPOCH');

INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash, tz)
VALUES ('$GATE_MEMBER_ID', '$DEMO_WORKSPACE_ID', '$GATE_EMAIL', true,
        momo_password_hash('$GATE_PASSWORD'), 'UTC');

INSERT INTO membership (workspace_id, channel_id, member_id, role)
VALUES ('$DEMO_WORKSPACE_ID', '$GENERAL_CHANNEL_ID', '$GATE_MEMBER_ID', 'admin'),
       ('$DEMO_WORKSPACE_ID', '$GENERAL_CHANNEL_ID', '$GATE_AGENT_ID', 'member');

INSERT INTO workspace_membership (workspace_id, member_id, role)
VALUES ('$DEMO_WORKSPACE_ID', '$GATE_MEMBER_ID', 'admin'),
       ('$DEMO_WORKSPACE_ID', '$GATE_AGENT_ID', 'member');

INSERT INTO agent (member_id, workspace_id, model, base_url, system_prompt, owner_human_id)
VALUES ('$GATE_AGENT_ID', '$DEMO_WORKSPACE_ID', 'openapi-gate',
        'http://localhost:8088/v1', 'MOMO-459 OpenAPI gate', '$GATE_MEMBER_ID');

-- Invite code for the /v1/join sample (raw code known only to this run).
INSERT INTO invite_code
  (workspace_id, code_hash, code_preview, role, max_uses, expires_at, created_by)
VALUES ('$DEMO_WORKSPACE_ID', momo_invite_code_hash('$INVITE_CODE'), '',
        'member', 50, now() + interval '1 day', '$GATE_MEMBER_ID');

-- Pending approval fixture for list/decision samples (agent = seeded 김인턴).
INSERT INTO agent_run
  (id, workspace_id, agent_member_id, channel_id, status, input, idempotency_key)
VALUES ('$RUN_UUID', '$DEMO_WORKSPACE_ID', '$KIM_INTERN_MEMBER_ID',
        '$GENERAL_CHANNEL_ID', 'awaiting_approval',
        '{"prompt":"openapi drift gate"}'::jsonb, 'openapi-gate-$RUN_ID'),
       ('$CONTROL_RUN_UUID', '$DEMO_WORKSPACE_ID', '$GATE_AGENT_ID',
        '$GENERAL_CHANNEL_ID', 'running',
        '{"prompt":"work control contract gate"}'::jsonb,
        'openapi-work-control-$RUN_ID'),
       ('$CANCEL_RUN_UUID', '$DEMO_WORKSPACE_ID', '$KIM_INTERN_MEMBER_ID',
        '$GENERAL_CHANNEL_ID', 'queued',
        '{"prompt":"agent cancel contract gate"}'::jsonb,
        'openapi-agent-cancel-$RUN_ID');

INSERT INTO approval
  (id, workspace_id, run_id, channel_id, requested_by, action_type, payload,
   status, expires_at)
VALUES ('$APPROVAL_UUID', '$DEMO_WORKSPACE_ID', '$RUN_UUID',
        '$GENERAL_CHANNEL_ID', '$KIM_INTERN_MEMBER_ID', 'tool_call',
        '{"tool_call":{"call_id":"gate-1","name":"github.search_issues","arguments":{}},"estimated_micro_usd":4200,"is_reversible":true,"on_behalf_of":"$GATE_MEMBER_ID"}'::jsonb,
        'pending', now() + interval '1 hour');

COMMIT;
SQL

# ---- 4) Sample every documented operation ------------------------------------
RESPONSE_BODY=""
RESPONSE_STATUS=""
SAMPLE_INDEX=0

api() {
  local method="$1" path="$2" body="${3:-}" token="${4:-}"
  local out="$TMP_DIR/last-response.json"
  local verb
  verb="$(printf '%s' "$method" | tr '[:lower:]' '[:upper:]')"
  local -a args=(-sS -o "$out" -w "%{http_code}" -X "$verb" -H "Content-Type: application/json")
  [ -n "$token" ] && args+=(-H "Authorization: Bearer $token")
  [ -n "$body" ] && args+=(--data "$body")
  RESPONSE_STATUS="$(curl "${args[@]}" "$BASE_URL$path")"
  RESPONSE_BODY="$(cat "$out")"
}

# api + status assert + record the body as a drift sample against spec
# (method, TEMPLATE path, expected status).
sample() {
  local name="$1" method="$2" template="$3" path="$4" expected="$5" body="${6:-}" token="${7:-}"
  api "$method" "$path" "$body" "$token"
  if [ "$RESPONSE_STATUS" != "$expected" ]; then
    echo "[openapi] FAIL $name: expected HTTP $expected, got $RESPONSE_STATUS" >&2
    echo "$RESPONSE_BODY" >&2
    exit 1
  fi
  SAMPLE_INDEX=$((SAMPLE_INDEX + 1))
  local file
  file="$(printf '%s/sample-%02d-%s.json' "$TMP_DIR" "$SAMPLE_INDEX" "$name")"
  printf '%s' "$RESPONSE_BODY" >"$file"
  jq -cn --arg name "$name" --arg method "$method" --arg path "$template" \
    --arg status "$expected" --arg body_file "$file" \
    '{name:$name, method:$method, path:$path, status:$status, body_file:$body_file}' \
    >>"$MANIFEST"
  echo "[openapi] SAMPLE $name -> $expected"
}

record_sample() {
  local name="$1" method="$2" template="$3" expected="$4"
  if [ "$RESPONSE_STATUS" != "$expected" ]; then
    echo "[openapi] FAIL $name: expected HTTP $expected, got $RESPONSE_STATUS" >&2
    echo "$RESPONSE_BODY" >&2
    exit 1
  fi
  SAMPLE_INDEX=$((SAMPLE_INDEX + 1))
  local file
  file="$(printf '%s/sample-%02d-%s.json' "$TMP_DIR" "$SAMPLE_INDEX" "$name")"
  printf '%s' "$RESPONSE_BODY" >"$file"
  jq -cn --arg name "$name" --arg method "$method" --arg path "$template" \
    --arg status "$expected" --arg body_file "$file" \
    '{name:$name, method:$method, path:$path, status:$status, body_file:$body_file}' \
    >>"$MANIFEST"
  echo "[openapi] SAMPLE $name -> $expected"
}

record_binary_sample() {
  local name="$1" method="$2" template="$3" expected="$4" body_file="$5" media_type="$6"
  [ "$RESPONSE_STATUS" = "$expected" ] || {
    echo "[openapi] FAIL $name: expected HTTP $expected, got $RESPONSE_STATUS" >&2
    exit 1
  }
  SAMPLE_INDEX=$((SAMPLE_INDEX + 1))
  jq -cn --arg name "$name" --arg method "$method" --arg path "$template" \
    --arg status "$expected" --arg body_file "$body_file" --arg media_type "$media_type" \
    '{name:$name, method:$method, path:$path, status:$status,
      body_file:$body_file, media_type:$media_type}' >>"$MANIFEST"
  echo "[openapi] SAMPLE $name -> $expected ($media_type)"
}

native_webhook_sample() {
  local name="$1" template="$2" path="$3" body="$4" key_id="$5" secret="$6" delivery_id="$7"
  local timestamp body_hash signature_base signature out="$TMP_DIR/last-response.json"
  timestamp="$(date -u +%s)"
  body_hash="$(printf '%s' "$body" | "$OPENSSL_BIN" dgst -sha256 | awk '{print $NF}')"
  signature_base="$(printf 'v1\nPOST\n%s\n%s\n%s\n%s\n%s' \
    "$path" "${path##*/}" "$timestamp" "$delivery_id" "$body_hash")"
  signature="$(printf '%s' "$signature_base" | "$OPENSSL_BIN" dgst -sha256 -hmac "$secret" | awk '{print $NF}')"
  RESPONSE_STATUS="$(curl -sS -o "$out" -w "%{http_code}" -X POST "$BASE_URL$path" \
    -H 'Content-Type: application/json' \
    -H 'X-Momo-Signature-Version: v1' \
    -H "X-Momo-Key-Id: $key_id" \
    -H "X-Momo-Timestamp: $timestamp" \
    -H "X-Momo-Delivery-Id: $delivery_id" \
    -H "X-Momo-Signature: v1=$signature" \
    --data-binary "$body")"
  RESPONSE_BODY="$(cat "$out")"
  record_sample "$name" post "$template" 201
}

work_host_signed_sample() {
  local name="$1" method="$2" template="$3" path="$4" expected="$5"
  local host_id="$6" private_key="$7" body="${8:-}"
  local sent_at payload signature out="$TMP_DIR/last-response.json" verb
  sent_at="$($PYTHON_BIN -c 'import time; print(time.time_ns() // 1_000_000)')"
  verb="$(printf '%s' "$method" | tr '[:lower:]' '[:upper:]')"
  payload="$TMP_DIR/work-host-request-$name.txt"
  printf 'momo.work_host.request.v1\n%s\n%s\n%s\n%s\n%s' \
    "$verb" "$path" \
    "$(printf '%s' "$WS" | tr '[:upper:]' '[:lower:]')" \
    "$(printf '%s' "$host_id" | tr '[:upper:]' '[:lower:]')" \
    "$sent_at" >"$payload"
  signature="$("$OPENSSL_BIN" pkeyutl -sign -rawin -inkey "$private_key" \
    -in "$payload" | "$OPENSSL_BIN" base64 -A)"
  local -a args=(-sS -o "$out" -w "%{http_code}" -X "$verb"
    -H 'Content-Type: application/json'
    -H "Authorization: MomoHost $host_id"
    -H "X-Momo-Work-Host-Sent-At: $sent_at"
    -H "X-Momo-Work-Host-Signature: $signature")
  [ -n "$body" ] && args+=(--data "$body")
  RESPONSE_STATUS="$(curl "${args[@]}" "$BASE_URL$path")"
  RESPONSE_BODY="$(cat "$out")"
  record_sample "$name" "$method" "$template" "$expected"
}

guard_jq() {
  local label="${*: -1}"
  set -- "${@:1:$(($# - 1))}"
  printf '%s' "$RESPONSE_BODY" | jq -e "$@" >/dev/null || {
    echo "[openapi] FAIL guard: $label" >&2
    echo "$RESPONSE_BODY" >&2
    exit 1
  }
}

WS="$DEMO_WORKSPACE_ID"

WORK_HOST_PRIVATE_KEY="$TMP_DIR/work-host-private.pem"
WORK_HOST_PUBLIC_DER="$TMP_DIR/work-host-public.der"
"$OPENSSL_BIN" genpkey -algorithm ED25519 -out "$WORK_HOST_PRIVATE_KEY" >/dev/null 2>&1
"$OPENSSL_BIN" pkey -in "$WORK_HOST_PRIVATE_KEY" -pubout -outform DER \
  -out "$WORK_HOST_PUBLIC_DER" >/dev/null 2>&1
WORK_HOST_PUBLIC_KEY="$(tail -c 32 "$WORK_HOST_PUBLIC_DER" | "$OPENSSL_BIN" base64 -A)"

# auth: login -> refresh (rotation) -> realtime-token
sample login post "/v1/auth/login" "/v1/auth/login" 200 \
  "$(jq -cn --arg e "$GATE_EMAIL" --arg p "$GATE_PASSWORD" --arg w "$WS" \
      '{email:$e,password:$p,workspace:$w}')"
ACCESS="$(printf '%s' "$RESPONSE_BODY" | jq -r '.accessToken')"
REFRESH="$(printf '%s' "$RESPONSE_BODY" | jq -r '.refreshToken')"

sample refresh post "/v1/auth/refresh" "/v1/auth/refresh" 200 \
  "$(jq -cn --arg r "$REFRESH" '{refreshToken:$r}')"
ACCESS="$(printf '%s' "$RESPONSE_BODY" | jq -r '.accessToken')"
REFRESH="$(printf '%s' "$RESPONSE_BODY" | jq -r '.refreshToken')"

sample realtime-token post "/v1/auth/realtime-token" "/v1/auth/realtime-token" 200 "" "$ACCESS"

sample agent-create post "/v1/workspaces/{workspaceId}/agents" \
  "/v1/workspaces/$WS/agents" 201 \
  "$(jq -cn --arg handle "openapi-agent-$RUN_EPOCH" \
      '{displayName:"OpenAPI Created Agent",handle:$handle,model:"openapi-gate",
        baseUrl:"https://hermes.openapi.example.test/v1",
        systemPrompt:"OpenAPI drift gate",config:{temperature:0.2,max_tokens:2048}}')" \
  "$ACCESS"
guard_jq --arg handle "openapi-agent-$RUN_EPOCH" \
  '.agent.handle == $handle and .agent.displayName == "OpenAPI Created Agent"
   and (.agent.id | type == "string")' \
  "agent creation returns only the created member identity"

# roster + compat alias
sample roster get "/v1/workspaces/{workspaceId}/roster" "/v1/workspaces/$WS/roster" 200 "" "$ACCESS"
guard_jq '(.members | length) >= 1' "roster returns at least one member"
sample members-alias get "/v1/workspaces/{workspaceId}/members" "/v1/workspaces/$WS/members" 200 "" "$ACCESS"

# channels: list + create
sample channels-list get "/v1/workspaces/{workspaceId}/channels" "/v1/workspaces/$WS/channels" 200 "" "$ACCESS"
guard_jq '(.channels | length) >= 1' "channel list is non-empty"
GENERAL_ID="$(printf '%s' "$RESPONSE_BODY" | jq -r '.channels[] | select(.name == "general") | .id' | head -1)"
[ -n "$GENERAL_ID" ] || { echo "[openapi] FAIL: #general channel not found" >&2; exit 1; }

sample notification-pref put \
  "/v1/workspaces/{workspaceId}/channels/{channelId}/notification-pref" \
  "/v1/workspaces/$WS/channels/$GENERAL_ID/notification-pref" 200 \
  '{"muted":true}' "$ACCESS"
guard_jq '.muted == true' "notification preference returns the effective mute state"

sample channel-create post "/v1/workspaces/{workspaceId}/channels" "/v1/workspaces/$WS/channels" 201 \
  "$(jq -cn --arg n "gate-$RUN_EPOCH" '{kind:"public",name:$n,topic:"openapi drift gate"}')" "$ACCESS"

sample work-pool-get get "/v1/workspaces/{workspaceId}/work-pool" \
  "/v1/workspaces/$WS/work-pool" 200 "" "$ACCESS"
sample work-pool-put put "/v1/workspaces/{workspaceId}/work-pool" \
  "/v1/workspaces/$WS/work-pool" 200 \
  '{"maxActive":5,"includedActiveHours":120,"perMemberSoftLimit":5}' "$ACCESS"

# work hosts: register -> signed heartbeat -> polling list. Revoke is sampled
# after the work-control operations have consumed the same registered host.
sample work-host-register post "/v1/workspaces/{workspaceId}/work-hosts" \
  "/v1/workspaces/$WS/work-hosts" 201 \
  "$(jq -cn --arg key "$WORK_HOST_PUBLIC_KEY" \
      '{scope:"member",type:"app",displayName:"OpenAPI gate host",publicKey:$key,
        capabilities:{"tool.codex":true,"terminal_attach":true}}')" "$ACCESS"
WORK_HOST_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.workHost.id')"
WORK_HOST_SENT_AT_MS="$($PYTHON_BIN -c 'import time; print(time.time_ns() // 1_000_000)')"
WORK_HOST_SIGNING_PAYLOAD="$TMP_DIR/work-host-heartbeat.txt"
printf 'momo.work_host.heartbeat.v1\n%s\n%s\n%s' \
  "$(printf '%s' "$WS" | tr '[:upper:]' '[:lower:]')" \
  "$(printf '%s' "$WORK_HOST_ID" | tr '[:upper:]' '[:lower:]')" \
  "$WORK_HOST_SENT_AT_MS" >"$WORK_HOST_SIGNING_PAYLOAD"
WORK_HOST_SIGNATURE="$("$OPENSSL_BIN" pkeyutl -sign -rawin -inkey "$WORK_HOST_PRIVATE_KEY" \
  -in "$WORK_HOST_SIGNING_PAYLOAD" | "$OPENSSL_BIN" base64 -A)"
sample work-host-heartbeat post \
  "/v1/workspaces/{workspaceId}/work-hosts/{workHostId}/heartbeat" \
  "/v1/workspaces/$WS/work-hosts/$WORK_HOST_ID/heartbeat" 200 \
  "$(jq -cn --argjson sent "$WORK_HOST_SENT_AT_MS" --arg signature "$WORK_HOST_SIGNATURE" \
      '{sentAtMs:$sent,signature:$signature}')"
guard_jq '.workHost.online == true and (.workHost.lastSeenAtMs | type == "number")' \
  "signed work host heartbeat marks the host online"
sample work-host-list get "/v1/workspaces/{workspaceId}/work-hosts" \
  "/v1/workspaces/$WS/work-hosts" 200 "" "$ACCESS"
guard_jq --arg host "$(printf '%s' "$WORK_HOST_ID" | tr '[:upper:]' '[:lower:]')" \
  'any(.workHosts[]; (.id | ascii_downcase) == $host and .online == true)' \
  "work host polling list contains the signed-online host"
work_host_signed_sample work-host-pending-controls get \
  "/v1/workspaces/{workspaceId}/work-hosts/{workHostId}/pending-controls" \
  "/v1/workspaces/$WS/work-hosts/$WORK_HOST_ID/pending-controls" 200 \
  "$WORK_HOST_ID" "$WORK_HOST_PRIVATE_KEY"
guard_jq '.workControls == []' "new host has no dispatched controls"

# work sessions: create card/root -> active list -> owner end
sample work-session-create post "/v1/workspaces/{workspaceId}/work-sessions" \
  "/v1/workspaces/$WS/work-sessions" 201 \
  "$(jq -cn --arg ch "$GENERAL_ID" --arg host "$WORK_HOST_ID" \
      '{channelId:$ch,hostId:$host,tool:"codex",label:"OpenAPI drift gate"}')" "$ACCESS"
WORK_SESSION_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.workSession.id')"
sample work-session-list get "/v1/workspaces/{workspaceId}/work-sessions" \
  "/v1/workspaces/$WS/work-sessions?active=1" 200 "" "$ACCESS"
guard_jq --arg id "$(printf '%s' "$WORK_SESSION_ID" | tr '[:upper:]' '[:lower:]')" \
  'any(.workSessions[]; (.id | ascii_downcase) == $id and .status == "running")' \
  "active work session list contains the created session"
sample work-session-end patch "/v1/workspaces/{workspaceId}/work-sessions/{workSessionId}" \
  "/v1/workspaces/$WS/work-sessions/$WORK_SESSION_ID" 200 \
  '{"status":"ended","exitCode":0}' "$ACCESS"
guard_jq '.workSession.status == "ended" and .workSession.exitCode == 0 and (.workSession.endedAtMs | type == "number")' \
  "work session ends with exit status"

# huddles: start -> active badge -> join grant -> last leave/end
sample huddle-start post "/v1/workspaces/{workspaceId}/channels/{channelId}/huddles" \
  "/v1/workspaces/$WS/channels/$GENERAL_ID/huddles" 201 "" "$ACCESS"
HUDDLE_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.huddle.id')"
sample huddle-active get "/v1/workspaces/{workspaceId}/channels/{channelId}/huddles/active" \
  "/v1/workspaces/$WS/channels/$GENERAL_ID/huddles/active" 200 "" "$ACCESS"
sample huddle-join post "/v1/workspaces/{workspaceId}/huddles/{huddleId}/join" \
  "/v1/workspaces/$WS/huddles/$HUDDLE_ID/join" 200 "" "$ACCESS"
guard_jq '.ttlSeconds == 600 and (.token | type == "string")' "huddle join returns a 10-minute grant"
sample huddle-recording-without-consent post \
  "/v1/workspaces/{workspaceId}/huddles/{huddleId}/recordings" \
  "/v1/workspaces/$WS/huddles/$HUDDLE_ID/recordings" 409 "" "$ACCESS"
sample huddle-recording-consent post \
  "/v1/workspaces/{workspaceId}/huddles/{huddleId}/recording-consent" \
  "/v1/workspaces/$WS/huddles/$HUDDLE_ID/recording-consent" 200 "" "$ACCESS"
guard_jq '.noticeVersion == 1 and (.consentedAtMs | type == "number")' \
  "huddle recording consent returns a durable receipt"
sample huddle-recording-start post \
  "/v1/workspaces/{workspaceId}/huddles/{huddleId}/recordings" \
  "/v1/workspaces/$WS/huddles/$HUDDLE_ID/recordings" 201 "" "$ACCESS"
guard_jq '.status == "requested" and .model == "small"' \
  "huddle recording starts only after explicit consent"
sample huddle-leave post "/v1/workspaces/{workspaceId}/huddles/{huddleId}/leave" \
  "/v1/workspaces/$WS/huddles/$HUDDLE_ID/leave" 200 "" "$ACCESS"
guard_jq '.ended == true and (.huddle.endedAtMs | type == "number")' \
  "last huddle participant ends the room"

# attachments: resumable session -> direct stub PUT -> complete -> content.
ATTACHMENT_PAYLOAD="$TMP_DIR/openapi-attachment.txt"
printf '%s' 'OpenAPI attachment bytes' >"$ATTACHMENT_PAYLOAD"
ATTACHMENT_SIZE="$(wc -c <"$ATTACHMENT_PAYLOAD" | tr -d '[:space:]')"
ATTACHMENT_UPLOADS="/v1/workspaces/$WS/channels/$GENERAL_ID/attachments/uploads"
sample attachment-upload post \
  "/v1/workspaces/{workspaceId}/channels/{channelId}/attachments/uploads" \
  "$ATTACHMENT_UPLOADS" 201 \
  "$(jq -cn --argjson s "$ATTACHMENT_SIZE" '{name:"openapi.txt",mime:"text/plain",size:$s}')" "$ACCESS"
ATTACHMENT_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.id')"
ATTACHMENT_UPLOAD_URL="$(printf '%s' "$RESPONSE_BODY" | jq -er '.uploadUrl')"
status="$(curl -sS -o "$TMP_DIR/attachment-put" -w '%{http_code}' -X PUT \
  -H 'Content-Type: text/plain' --data-binary "@$ATTACHMENT_PAYLOAD" "$ATTACHMENT_UPLOAD_URL")"
[ "$status" = "200" ] || { echo "[openapi] FAIL attachment PUT: HTTP $status" >&2; exit 1; }
sample attachment-complete post \
  "/v1/workspaces/{workspaceId}/channels/{channelId}/attachments/{attachmentId}/complete" \
  "/v1/workspaces/$WS/channels/$GENERAL_ID/attachments/$ATTACHMENT_ID/complete" 200 "" "$ACCESS"

ATTACHMENT_CONTENT_FILE="$TMP_DIR/attachment-content.bin"
RESPONSE_STATUS="$(curl -sS -o "$ATTACHMENT_CONTENT_FILE" -w '%{http_code}' \
  -H "Authorization: Bearer $ACCESS" \
  "$BASE_URL/v1/workspaces/$WS/channels/$GENERAL_ID/attachments/$ATTACHMENT_ID/content")"
cmp -s "$ATTACHMENT_PAYLOAD" "$ATTACHMENT_CONTENT_FILE" || {
  echo "[openapi] FAIL attachment content bytes" >&2; exit 1;
}
record_binary_sample attachment-content get \
  "/v1/workspaces/{workspaceId}/channels/{channelId}/attachments/{attachmentId}/content" \
  200 "$ATTACHMENT_CONTENT_FILE" "*/*"

# messages: send + attachment binding + history (head + after-backfill)
sample message-send post \
  "/v1/workspaces/{workspaceId}/channels/{channelId}/messages" \
  "/v1/workspaces/$WS/channels/$GENERAL_ID/messages" 201 \
  "$(jq -cn --arg c "$(uuidgen)" --arg a "$ATTACHMENT_ID" \
      '{clientMsgId:$c,body:"openapi drift gate sample",attachmentIds:[$a]}')" "$ACCESS"
SENT_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.id')"
SENT_SEQ="$(printf '%s' "$RESPONSE_BODY" | jq -r '.seq')"

sample message-history get \
  "/v1/workspaces/{workspaceId}/channels/{channelId}/messages" \
  "/v1/workspaces/$WS/channels/$GENERAL_ID/messages?limit=50" 200 "" "$ACCESS"
guard_jq '(.messages | length) >= 1' "history returns the sent message"

sample message-backfill get \
  "/v1/workspaces/{workspaceId}/channels/{channelId}/messages" \
  "/v1/workspaces/$WS/channels/$GENERAL_ID/messages?after=0&limit=50" 200 "" "$ACCESS"
guard_jq '(.messages | length) >= 1 and (.messages | map(.seq) == (map(.seq) | sort))' \
  "after-backfill is ascending and non-empty"

sample workspace-message-search get \
  "/v1/workspaces/{workspaceId}/search/messages" \
  "/v1/workspaces/$WS/search/messages?q=openapi%20drift&limit=20" 200 "" "$ACCESS"
guard_jq '(.hits | length) >= 1 and all(.hits[]; .matchOffset >= 0)' \
  "workspace search returns the sent message with a match offset"

# read-state: cursor advance + bulk read
sample read-state-put put \
  "/v1/workspaces/{workspaceId}/channels/{channelId}/read-state" \
  "/v1/workspaces/$WS/channels/$GENERAL_ID/read-state" 200 \
  "$(jq -cn --argjson s "$SENT_SEQ" '{last_read_seq:$s}')" "$ACCESS"

sample read-state-list get "/v1/workspaces/{workspaceId}/read-state" "/v1/workspaces/$WS/read-state" 200 "" "$ACCESS"
guard_jq '(.read_states | length) >= 1' "bulk read-state is non-empty"

# message interactions: edit -> reaction add/snapshot/remove -> tombstone.
sample message-edit patch "/v1/workspaces/{workspaceId}/messages/{messageId}" \
  "/v1/workspaces/$WS/messages/$SENT_ID" 200 \
  '{"body":"openapi drift gate sample edited"}' "$ACCESS"
guard_jq --argjson seq "$SENT_SEQ" \
  '.state == "edited" and .seq == $seq and (.editedAtMs > 0)' \
  "message edit preserves seq and returns edited state"

sample reaction-add put "/v1/workspaces/{workspaceId}/messages/{messageId}/reactions/{emoji}" \
  "/v1/workspaces/$WS/messages/$SENT_ID/reactions/%F0%9F%91%8D" 200 "" "$ACCESS"
guard_jq '.action == "added" and .emoji == "👍"' "reaction add delta"

sample reaction-snapshot get "/v1/workspaces/{workspaceId}/channels/{channelId}/reactions" \
  "/v1/workspaces/$WS/channels/$GENERAL_ID/reactions" 200 "" "$ACCESS"
guard_jq --arg id "$(printf '%s' "$SENT_ID" | tr '[:upper:]' '[:lower:]')" \
  'any(to_entries[]; (.key | ascii_downcase) == $id and (.value["👍"] | length) == 1)' \
  "reaction snapshot contains the edited message"

sample reaction-remove delete "/v1/workspaces/{workspaceId}/messages/{messageId}/reactions/{emoji}" \
  "/v1/workspaces/$WS/messages/$SENT_ID/reactions/%F0%9F%91%8D" 200 "" "$ACCESS"
guard_jq '.action == "removed" and .emoji == "👍"' "reaction removal delta"

sample message-delete delete "/v1/workspaces/{workspaceId}/messages/{messageId}" \
  "/v1/workspaces/$WS/messages/$SENT_ID" 200 "" "$ACCESS"
guard_jq --argjson seq "$SENT_SEQ" \
  '.state == "deleted" and .seq == $seq and (.deletedAtMs > 0) and (has("body") | not)' \
  "message delete returns a body-free tombstone with the original seq"

# public join (201 created + 200 existing-member re-join shape)
sample join post "/v1/join" "/v1/join" 201 \
  "$(jq -cn --arg c "$INVITE_CODE" --arg e "$JOIN_EMAIL" \
      '{code:$c,email:$e,displayName:"Gate Join",password:"gate-join-pw"}')"
JOINED_MEMBER_ID="$(printf '%s' "$RESPONSE_BODY" | jq -r '.member.id')"

# dms: open (created) + reopen (existing) + list
sample dm-open post "/v1/workspaces/{workspaceId}/dms" "/v1/workspaces/$WS/dms" 201 \
  "$(jq -cn --arg m "$JOINED_MEMBER_ID" '{memberId:$m}')" "$ACCESS"
guard_jq '.created == true' "first dm open reports created=true"

sample dm-reopen post "/v1/workspaces/{workspaceId}/dms" "/v1/workspaces/$WS/dms" 200 \
  "$(jq -cn --arg m "$JOINED_MEMBER_ID" '{memberId:$m}')" "$ACCESS"
guard_jq '.created == false' "second dm open reports created=false"

sample dms-list get "/v1/workspaces/{workspaceId}/dms" "/v1/workspaces/$WS/dms" 200 "" "$ACCESS"
guard_jq '(.channels | length) >= 1' "dm list is non-empty"

# approvals: pending projection + decision receipt
sample approvals-list get "/v1/workspaces/{workspaceId}/approvals" \
  "/v1/workspaces/$WS/approvals?status=pending" 200 "" "$ACCESS"
guard_jq --arg id "$APPROVAL_UUID" '.approvals | map(select(.id == $id)) | length == 1' \
  "pending approvals include the gate fixture"

sample approval-decision post \
  "/v1/workspaces/{workspaceId}/approvals/{approvalId}/decision" \
  "/v1/workspaces/$WS/approvals/$APPROVAL_UUID/decision" 200 \
  "$(jq -cn --arg a "$APPROVAL_UUID" --arg d "$(uuidgen)" \
      '{approval_id:$a,approve:true,reason:"openapi drift gate",client_decision_id:$d}')" "$ACCESS"
guard_jq '.status == "approved"' "decision receipt reports approved"

sample agent-pause put \
  "/v1/workspaces/{workspaceId}/agents/{agentId}/pause" \
  "/v1/workspaces/$WS/agents/$KIM_INTERN_MEMBER_ID/pause" 200 \
  '{"paused":true}' "$ACCESS"
guard_jq '.profile.paused == true' "agent pause projects the durable paused state"

sample agent-resume put \
  "/v1/workspaces/{workspaceId}/agents/{agentId}/pause" \
  "/v1/workspaces/$WS/agents/$KIM_INTERN_MEMBER_ID/pause" 200 \
  '{"paused":false}' "$ACCESS"
guard_jq '.profile.paused == false' "agent resume clears the durable paused state"

sample agent-profile-put put \
  "/v1/workspaces/{workspaceId}/agents/{agentId}/profile" \
  "/v1/workspaces/$WS/agents/$KIM_INTERN_MEMBER_ID/profile" 200 \
  '{"instructions":"OpenAPI contract profile","modelPref":null,"enabledTools":[],"triggers":{"mention":true}}' "$ACCESS"
guard_jq '.profile.instructions == "OpenAPI contract profile" and .profile.paused == false' \
  "profile replacement preserves the independent pause state"

sample agent-profile-get get \
  "/v1/workspaces/{workspaceId}/agents/{agentId}/profile" \
  "/v1/workspaces/$WS/agents/$KIM_INTERN_MEMBER_ID/profile" 200 "" "$ACCESS"
guard_jq '.profile.instructions == "OpenAPI contract profile" and .profile.paused == false' \
  "profile read includes the pause projection"

sample agent-allowed-models get \
  "/v1/workspaces/{workspaceId}/agents/{agentId}/allowed-models" \
  "/v1/workspaces/$WS/agents/$KIM_INTERN_MEMBER_ID/allowed-models" 200 "" "$ACCESS"
guard_jq 'keys == ["allowedAgentModels"] and (.allowedAgentModels | type == "array" and length > 0)' \
  "agent allowed-models is a credential-free non-empty projection"

sample agent-run-cancel post \
  "/v1/workspaces/{workspaceId}/agent-runs/{runId}/cancel" \
  "/v1/workspaces/$WS/agent-runs/$CANCEL_RUN_UUID/cancel" 200 "" "$ACCESS"
guard_jq --arg run "$(printf '%s' "$CANCEL_RUN_UUID" | tr '[:upper:]' '[:lower:]')" \
  '(.runId | ascii_downcase) == $run and .status == "cancelled" and
   .linkedWorkSessionIds == [] and .workSessionsTerminated == false' \
  "agent cancel exposes the no-implicit-work-session-kill boundary"

# plugins: catalog/detail -> install/grant -> delegated agent policy
DRIVE_PLUGIN="com.momo.plugins.drive"
DRIVE_PATH="/v1/workspaces/$WS/plugins/$DRIVE_PLUGIN"
sample plugins-list get "/v1/workspaces/{workspaceId}/plugins" \
  "/v1/workspaces/$WS/plugins" 200 "" "$ACCESS"
guard_jq '(.plugins | map(select(.pluginId == "com.momo.plugins.drive")) | length) == 1' \
  "Drive is present in the plugin catalog"

sample plugin-detail get "/v1/workspaces/{workspaceId}/plugins/{pluginId}" \
  "$DRIVE_PATH" 200 "" "$ACCESS"
api post "$DRIVE_PATH/install" '{"enabled":true}' "$ACCESS"
case "$RESPONSE_STATUS" in
  200|201) record_sample plugin-install post "/v1/workspaces/{workspaceId}/plugins/{pluginId}/install" "$RESPONSE_STATUS" ;;
  *) echo "[openapi] FAIL plugin-install: expected HTTP 200/201, got $RESPONSE_STATUS" >&2; exit 1 ;;
esac
sample plugin-grant post "/v1/workspaces/{workspaceId}/plugins/{pluginId}/grants" \
  "$DRIVE_PATH/grants" 201 '{"scope":"drive:read"}' "$ACCESS"

api post "/v1/workspaces/$WS/agents/$GATE_AGENT_ID/credentials" \
  '{"label":"MOMO-459 OpenAPI gate"}' "$ACCESS"
[ "$RESPONSE_STATUS" = "201" ] || {
  echo "[openapi] FAIL agent credential issue: expected 201, got $RESPONSE_STATUS" >&2
  exit 1
}
AGENT_ACCESS="$(printf '%s' "$RESPONSE_BODY" | jq -er '.token')"

# Work controls + terminal attach: dispatch -> MomoHost remote PTY binding ->
# owner capability -> signed host validation -> ack -> revoke.
sample work-tool-profile-list get \
  "/v1/workspaces/{workspaceId}/work-tool-profiles" \
  "/v1/workspaces/$WS/work-tool-profiles" 200 "" "$ACCESS"
guard_jq '([.workToolProfiles[].toolKey] | index("codex")) != null' \
  "work tool profile catalog contains the codex default"

sample work-tool-profile-create post \
  "/v1/workspaces/{workspaceId}/work-tool-profiles" \
  "/v1/workspaces/$WS/work-tool-profiles" 201 \
  '{"toolKey":"openapi-cli","displayName":"OpenAPI CLI","launchTemplate":{"command":"openapi-cli","arguments":[]}}' \
  "$ACCESS"
sample work-tool-profile-update put \
  "/v1/workspaces/{workspaceId}/work-tool-profiles/{tool}" \
  "/v1/workspaces/$WS/work-tool-profiles/openapi-cli" 200 \
  '{"enabled":false}' "$ACCESS"
guard_jq '.workToolProfile.enabled == false' "work tool profile update disables projection"
sample work-tool-profile-delete delete \
  "/v1/workspaces/{workspaceId}/work-tool-profiles/{tool}" \
  "/v1/workspaces/$WS/work-tool-profiles/openapi-cli" 200 "" "$ACCESS"

sample work-auto-approval-enable put \
  "/v1/workspaces/{workspaceId}/work-auto-approvals/{tool}" \
  "/v1/workspaces/$WS/work-auto-approvals/codex" 200 "" "$ACCESS"
guard_jq '.tool == "codex" and .enabled == true' "work auto-approval enables codex"

sample work-auto-approvals-list get \
  "/v1/workspaces/{workspaceId}/work-auto-approvals" \
  "/v1/workspaces/$WS/work-auto-approvals" 200 "" "$ACCESS"
guard_jq '.tools == ["codex"]' "work auto-approval snapshot contains only codex"

sample work-control-create post "/v1/workspaces/{workspaceId}/work-controls" \
  "/v1/workspaces/$WS/work-controls" 201 \
  "$(jq -cn --arg ch "$GENERAL_ID" --arg run "$CONTROL_RUN_UUID" \
      --arg host "$WORK_HOST_ID" \
      '{channelId:$ch,runId:$run,targetHostId:$host,kind:"spawn",payload:{tool:"codex",label:"OpenAPI control"}}')" \
  "$AGENT_ACCESS"
WORK_CONTROL_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.workControl.id')"
guard_jq '.workControl.kind == "spawn" and .workControl.status == "dispatched"' \
  "whitelisted spawn dispatches immediately"

REMOTE_PTY_ID="openapi-pty-$RUN_EPOCH"
REMOTE_ATTACH_ENDPOINT="wss://workd.momo.test/v1/terminal"
work_host_signed_sample work-session-remote-create post \
  "/v1/workspaces/{workspaceId}/work-sessions" \
  "/v1/workspaces/$WS/work-sessions" 201 \
  "$WORK_HOST_ID" "$WORK_HOST_PRIVATE_KEY" \
  "$(jq -cn --arg ch "$GENERAL_ID" --arg host "$WORK_HOST_ID" \
      --arg control "$WORK_CONTROL_ID" --arg pty "$REMOTE_PTY_ID" \
      --arg endpoint "$REMOTE_ATTACH_ENDPOINT" \
      '{channelId:$ch,hostId:$host,tool:"codex",label:"OpenAPI remote PTY",
        controlId:$control,ptyId:$pty,attachEndpoint:$endpoint}')"
WORK_CONTROL_SESSION_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.workSession.id')"

sample terminal-attach-issue post \
  "/v1/workspaces/{workspaceId}/work-sessions/{workSessionId}/terminal-attach" \
  "/v1/workspaces/$WS/work-sessions/$WORK_CONTROL_SESSION_ID/terminal-attach" 200 \
  "" "$ACCESS"
TERMINAL_ATTACH_TOKEN="$(printf '%s' "$RESPONSE_BODY" | jq -er '.capability_token')"
guard_jq --arg endpoint "$REMOTE_ATTACH_ENDPOINT" --arg pty "$REMOTE_PTY_ID" \
  '.attach_endpoint == $endpoint and .pty_id == $pty and
   ((keys | sort) == ["attach_endpoint","capability_token","pty_id"])' \
  "owner receives the exact direct attach grant without embedded token URL"

work_host_signed_sample terminal-attach-validate post \
  "/v1/workspaces/{workspaceId}/work-hosts/{workHostId}/terminal-attach/validate" \
  "/v1/workspaces/$WS/work-hosts/$WORK_HOST_ID/terminal-attach/validate" 200 \
  "$WORK_HOST_ID" "$WORK_HOST_PRIVATE_KEY" \
  "$(jq -cn --arg token "$TERMINAL_ATTACH_TOKEN" '{capability_token:$token}')"
guard_jq --arg session "$(printf '%s' "$WORK_CONTROL_SESSION_ID" | tr '[:upper:]' '[:lower:]')" \
  --arg pty "$REMOTE_PTY_ID" \
  '(.work_session_id | ascii_downcase) == $session and .pty_id == $pty and
   (.expires_at | type == "string")' \
  "signed target host validates the live PTY binding"

sample work-control-ack post \
  "/v1/workspaces/{workspaceId}/work-controls/{workControlId}/ack" \
  "/v1/workspaces/$WS/work-controls/$WORK_CONTROL_ID/ack" 200 \
  "$(jq -cn --arg session "$WORK_CONTROL_SESSION_ID" '{ok:true,sessionId:$session}')" "$ACCESS"
guard_jq --arg session "$(printf '%s' "$WORK_CONTROL_SESSION_ID" | tr '[:upper:]' '[:lower:]')" \
  '.workControl.status == "acked" and (.workControl.sessionId | ascii_downcase) == $session' \
  "spawn ack binds the running work session"

sample work-auto-approval-disable delete \
  "/v1/workspaces/{workspaceId}/work-auto-approvals/{tool}" \
  "/v1/workspaces/$WS/work-auto-approvals/codex" 200 "" "$ACCESS"
guard_jq '.tool == "codex" and .enabled == false' "work auto-approval disables codex"

sample work-host-revoke delete "/v1/workspaces/{workspaceId}/work-hosts/{workHostId}" \
  "/v1/workspaces/$WS/work-hosts/$WORK_HOST_ID" 200 "" "$ACCESS"
guard_jq '.workHost.online == false and (.workHost.revokedAtMs | type == "number")' \
  "revoked work host is durably offline"

DELEGATION_QUERY="delegatedMemberId=$GATE_MEMBER_ID&channelId=$GENERAL_ID"
sample plugins-agent-policy get "/v1/workspaces/{workspaceId}/plugins" \
  "/v1/workspaces/$WS/plugins?$DELEGATION_QUERY" 200 "" "$AGENT_ACCESS"
guard_jq '(.toolPolicy.plugins | map(select(.pluginId == "com.momo.plugins.drive")) | length) == 1' \
  "agent policy contains the delegated Drive grant"

# Drive MCP: one HTTP operation, sampled across all implemented JSON-RPC
# methods and protocol/application error codes.
MCP_PATH="/v1/mcp/drive?$DELEGATION_QUERY"
sample drive-mcp-initialize post "/v1/mcp/drive" "$MCP_PATH" 200 \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' "$AGENT_ACCESS"
sample drive-mcp-tools-list post "/v1/mcp/drive" "$MCP_PATH" 200 \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' "$AGENT_ACCESS"
sample drive-mcp-tools-call post "/v1/mcp/drive" "$MCP_PATH" 200 \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"drive.search_files","arguments":{"query":"handbook"}}}' "$AGENT_ACCESS"
sample drive-mcp-parse-error post "/v1/mcp/drive" "$MCP_PATH" 200 \
  '{"jsonrpc":' "$AGENT_ACCESS"
guard_jq '.error.code == -32700' "Drive MCP parse error code"
sample drive-mcp-invalid-request post "/v1/mcp/drive" "$MCP_PATH" 200 \
  '{"jsonrpc":"1.0","method":"initialize"}' "$AGENT_ACCESS"
guard_jq '.error.code == -32600' "Drive MCP invalid request code"
sample drive-mcp-method-not-found post "/v1/mcp/drive" "$MCP_PATH" 200 \
  '{"jsonrpc":"2.0","id":4,"method":"unknown"}' "$AGENT_ACCESS"
guard_jq '.error.code == -32601' "Drive MCP method-not-found code"
sample drive-mcp-invalid-params post "/v1/mcp/drive" "$MCP_PATH" 200 \
  '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{}}' "$AGENT_ACCESS"
guard_jq '.error.code == -32602' "Drive MCP invalid-params code"

sample plugin-grant-revoke delete \
  "/v1/workspaces/{workspaceId}/plugins/{pluginId}/grants/{scope}" \
  "$DRIVE_PATH/grants/drive:read" 200 "" "$ACCESS"
sample drive-mcp-grant-required post "/v1/mcp/drive" "$MCP_PATH" 200 \
  '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"drive.search_files","arguments":{}}}' "$AGENT_ACCESS"
guard_jq '.error.code == -32003 and .error.data.code == "momo.drive.grant_required"' \
  "Drive MCP grant-required code"
sample plugin-install-revoke delete "/v1/workspaces/{workspaceId}/plugins/{pluginId}/install" \
  "$DRIVE_PATH/install" 200 "" "$ACCESS"

# Workspace membership lifecycle: role hierarchy, status transitions, removal,
# and the durable ban ledger. The disposable gate agent is no longer needed by
# later samples, so removal cannot invalidate another operation's fixture.
MEMBERSHIP_PATH="/v1/workspaces/$WS/members/$GATE_AGENT_ID"
sample workspace-member-role patch \
  "/v1/workspaces/{workspaceId}/members/{memberId}/role" \
  "$MEMBERSHIP_PATH/role" 200 '{"role":"guest"}' "$ACCESS"
sample channel-member-role patch \
  "/v1/workspaces/{workspaceId}/channels/{channelId}/members/{memberId}/role" \
  "/v1/workspaces/$WS/channels/$GENERAL_ID/members/$GATE_AGENT_ID/role" \
  200 '{"role":"guest"}' "$ACCESS"
sample workspace-member-suspend post \
  "/v1/workspaces/{workspaceId}/members/{memberId}/suspend" \
  "$MEMBERSHIP_PATH/suspend" 200 "" "$ACCESS"
sample workspace-member-reinstate post \
  "/v1/workspaces/{workspaceId}/members/{memberId}/reinstate" \
  "$MEMBERSHIP_PATH/reinstate" 200 "" "$ACCESS"
sample workspace-member-remove delete \
  "/v1/workspaces/{workspaceId}/members/{memberId}" \
  "$MEMBERSHIP_PATH" 200 '{}' "$ACCESS"

BAN_PATH="/v1/workspaces/$WS/bans"
sample workspace-ban-create post "/v1/workspaces/{workspaceId}/bans" \
  "$BAN_PATH" 201 '{"email":"openapi-ban@momo.local","reason":"contract sample"}' "$ACCESS"
BAN_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.ban.id' | tr '[:upper:]' '[:lower:]')"
sample workspace-ban-list get "/v1/workspaces/{workspaceId}/bans" \
  "$BAN_PATH" 200 "" "$ACCESS"
sample workspace-ban-delete delete "/v1/workspaces/{workspaceId}/bans/{banId}" \
  "$BAN_PATH/$BAN_ID" 200 "" "$ACCESS"

# webhooks: management, native signed ingress, Slack-compatible ingress.
WEBHOOKS_PATH="/v1/workspaces/$WS/webhooks"
sample webhook-create post "/v1/workspaces/{workspaceId}/webhooks" "$WEBHOOKS_PATH" 201 \
  "$(jq -cn --arg ch "$GENERAL_ID" '{channelId:$ch,mode:"native",label:"OpenAPI Native"}')" "$ACCESS"
NATIVE_INSTALL="$(printf '%s' "$RESPONSE_BODY" | jq -er '.installation.id' | tr '[:upper:]' '[:lower:]')"
NATIVE_KEY="$(printf '%s' "$RESPONSE_BODY" | jq -er '.keyId' | tr '[:upper:]' '[:lower:]')"
NATIVE_SECRET="$(printf '%s' "$RESPONSE_BODY" | jq -er '.secret')"
NATIVE_URL="$(printf '%s' "$RESPONSE_BODY" | jq -er '.url')"

sample webhook-rotate post "/v1/workspaces/{workspaceId}/webhooks/{installationId}/rotate" \
  "$WEBHOOKS_PATH/$NATIVE_INSTALL/rotate" 200 '{"overlapSeconds":0}' "$ACCESS"
NATIVE_KEY="$(printf '%s' "$RESPONSE_BODY" | jq -er '.keyId' | tr '[:upper:]' '[:lower:]')"
NATIVE_SECRET="$(printf '%s' "$RESPONSE_BODY" | jq -er '.secret')"

sample webhooks-list get "/v1/workspaces/{workspaceId}/webhooks" "$WEBHOOKS_PATH" 200 "" "$ACCESS"
guard_jq 'all(.installations[]; has("secret") | not)' "webhook list omits one-time secrets"
native_webhook_sample native-webhook "/v1/webhooks/{workspaceId}/{installationId}" \
  "$NATIVE_URL" '{"text":"OpenAPI native delivery","event_type":"contract"}' \
  "$NATIVE_KEY" "$NATIVE_SECRET" "openapi-$RUN_ID"

api post "$WEBHOOKS_PATH" \
  "$(jq -cn --arg ch "$GENERAL_ID" '{channelId:$ch,mode:"slack_compatible",label:"OpenAPI Slack"}')" "$ACCESS"
[ "$RESPONSE_STATUS" = "201" ] || {
  echo "[openapi] FAIL Slack-compatible webhook issue: expected 201, got $RESPONSE_STATUS" >&2
  exit 1
}
SLACK_URL="$(printf '%s' "$RESPONSE_BODY" | jq -er '.url')"
sample slack-webhook post "/hooks/{token}" "$SLACK_URL" 201 \
  '{"text":"OpenAPI Slack-compatible delivery"}'

sample webhook-revoke delete "/v1/workspaces/{workspaceId}/webhooks/{installationId}" \
  "$WEBHOOKS_PATH/$NATIVE_INSTALL" 200 "" "$ACCESS"

# error envelope + logout (last: revokes the session)
sample unauthorized get "/v1/workspaces/{workspaceId}/roster" "/v1/workspaces/$WS/roster" 401 ""
sample logout post "/v1/auth/logout" "/v1/auth/logout" 200 \
  "$(jq -cn --arg r "$REFRESH" '{refreshToken:$r}')" "$ACCESS"
guard_jq '.revokedAccess == true and .revokedRefresh == true' "logout revoked both tokens"

# ---- 5) Validate every sample against the spec (+ full operation coverage) ---
jq -s '{samples: .}' "$MANIFEST" >"$TMP_DIR/manifest.json"
echo "[openapi] validating $(jq '.samples | length' "$TMP_DIR/manifest.json") samples against the spec"
# 역방향(서버 -> 스펙) 커버리지. 기존 검사는 스펙에 있는 것만 훑으므로 서버에만
# 있는 경로는 구조적으로 보이지 않았다(MOMO-633). 매니페스트는 소스에서 유도한다 —
# 손으로 쓴 목록은 이미 고친 것의 체크리스트일 뿐 다음 드리프트를 못 잡는다.
"$PYTHON_BIN" "$SCRIPT_DIR/openapi_server_routes.py" \
  --routes-dir "$REPO_ROOT/server/Sources/MomoServer/Routes" \
  --allowlist "$REPO_ROOT/docs/api/openapi.undocumented-allowlist.json" \
  >"$TMP_DIR/server-routes.json"

"$PYTHON_BIN" "$SCRIPT_DIR/openapi_shape_check.py" \
  --spec "$SPEC_JSON" \
  --manifest "$TMP_DIR/manifest.json" \
  --server-route-manifest "$TMP_DIR/server-routes.json" \
  --require-operation-coverage

echo "[openapi] PASS OpenAPI contract drift gate (evidence: $TMP_DIR)"

#!/usr/bin/env bash
# =============================================================================
# scripts/verify_openapi_contract.sh — MOMO-389 OpenAPI contract drift gate
#
# Verifies that the live server's response shapes (required keys + types)
# match docs/api/openapi.yaml — the canonical web v0 client contract
# (ADR-0119 D4-A). Every operation documented in the spec is sampled against
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
need python3
need uuidgen

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
SPEC_JSON="$TMP_DIR/openapi.json"
MANIFEST="$TMP_DIR/manifest.jsonl"
: >"$MANIFEST"

DEMO_WORKSPACE_ID="00000000-0000-7000-8000-000000000001"
GENERAL_CHANNEL_ID="00000000-0000-7000-8000-000000000201"
KIM_INTERN_MEMBER_ID="00000000-0000-7000-8000-000000000102"
GATE_MEMBER_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
GATE_EMAIL="gate-$RUN_ID@momo.local"
GATE_PASSWORD="openapi-gate-pw"
GATE_HANDLE="gate-$RUN_EPOCH"
JOIN_EMAIL="gate-join-$RUN_ID@momo.local"
INVITE_CODE="gate-invite-$(uuidgen | tr '[:upper:]' '[:lower:]')"
RUN_UUID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
APPROVAL_UUID="$(uuidgen | tr '[:upper:]' '[:lower:]')"

compose() {
  PORT="$GATE_PORT" \
  POSTGRES_PORT="$GATE_POSTGRES_PORT" \
  CENT_PORT="$GATE_CENT_PORT" \
  HERMES_PORT="$GATE_HERMES_PORT" \
  docker compose -p "$PROJECT" -f "$COMPOSE_FILE" "$@"
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
  if python3 -c "import yaml" >/dev/null 2>&1; then
    python3 -c \
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

echo "[openapi] installing gate fixtures (member/invite/approval)"
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
        'OpenAPI Gate', '$GATE_HANDLE');

INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash, tz)
VALUES ('$GATE_MEMBER_ID', '$DEMO_WORKSPACE_ID', '$GATE_EMAIL', true,
        momo_password_hash('$GATE_PASSWORD'), 'UTC');

INSERT INTO membership (workspace_id, channel_id, member_id, role)
VALUES ('$DEMO_WORKSPACE_ID', '$GENERAL_CHANNEL_ID', '$GATE_MEMBER_ID', 'admin');

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
        '{"prompt":"openapi drift gate"}'::jsonb, 'openapi-gate-$RUN_ID');

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

# roster + compat alias
sample roster get "/v1/workspaces/{workspaceId}/roster" "/v1/workspaces/$WS/roster" 200 "" "$ACCESS"
guard_jq '(.members | length) >= 1' "roster returns at least one member"
sample members-alias get "/v1/workspaces/{workspaceId}/members" "/v1/workspaces/$WS/members" 200 "" "$ACCESS"

# channels: list + create
sample channels-list get "/v1/workspaces/{workspaceId}/channels" "/v1/workspaces/$WS/channels" 200 "" "$ACCESS"
guard_jq '(.channels | length) >= 1' "channel list is non-empty"
GENERAL_ID="$(printf '%s' "$RESPONSE_BODY" | jq -r '.channels[] | select(.name == "general") | .id' | head -1)"
[ -n "$GENERAL_ID" ] || { echo "[openapi] FAIL: #general channel not found" >&2; exit 1; }

sample channel-create post "/v1/workspaces/{workspaceId}/channels" "/v1/workspaces/$WS/channels" 201 \
  "$(jq -cn --arg n "gate-$RUN_EPOCH" '{kind:"public",name:$n,topic:"openapi drift gate"}')" "$ACCESS"

# messages: send + history (head + after-backfill)
sample message-send post \
  "/v1/workspaces/{workspaceId}/channels/{channelId}/messages" \
  "/v1/workspaces/$WS/channels/$GENERAL_ID/messages" 201 \
  "$(jq -cn --arg c "$(uuidgen)" '{clientMsgId:$c,body:"openapi drift gate sample"}')" "$ACCESS"
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

# read-state: cursor advance + bulk read
sample read-state-put put \
  "/v1/workspaces/{workspaceId}/channels/{channelId}/read-state" \
  "/v1/workspaces/$WS/channels/$GENERAL_ID/read-state" 200 \
  "$(jq -cn --argjson s "$SENT_SEQ" '{last_read_seq:$s}')" "$ACCESS"

sample read-state-list get "/v1/workspaces/{workspaceId}/read-state" "/v1/workspaces/$WS/read-state" 200 "" "$ACCESS"
guard_jq '(.read_states | length) >= 1' "bulk read-state is non-empty"

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

# error envelope + logout (last: revokes the session)
sample unauthorized get "/v1/workspaces/{workspaceId}/roster" "/v1/workspaces/$WS/roster" 401 ""
sample logout post "/v1/auth/logout" "/v1/auth/logout" 200 \
  "$(jq -cn --arg r "$REFRESH" '{refreshToken:$r}')" "$ACCESS"
guard_jq '.revokedAccess == true and .revokedRefresh == true' "logout revoked both tokens"

# ---- 5) Validate every sample against the spec (+ full operation coverage) ---
jq -s '{samples: .}' "$MANIFEST" >"$TMP_DIR/manifest.json"
echo "[openapi] validating $(jq '.samples | length' "$TMP_DIR/manifest.json") samples against the spec"
python3 "$SCRIPT_DIR/openapi_shape_check.py" \
  --spec "$SPEC_JSON" \
  --manifest "$TMP_DIR/manifest.json" \
  --require-operation-coverage

echo "[openapi] PASS OpenAPI contract drift gate (evidence: $TMP_DIR)"

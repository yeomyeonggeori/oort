#!/usr/bin/env bash
# =============================================================================
# scripts/verify_run_routing.sh — MOMO-621 / ADR-0134 D1·D2·D3 runtime gate
#
# Request-level model/effort routing against a real Postgres 18 + MomoServer
# stack (infra/docker-compose.e2e.yml, api forced into AGENT_GATEWAY_MODE=gateway
# because work runs require an enabled BYOA gateway).
#
# Layers, all measured — nothing is asserted from source text:
#   1. migration 041: usage_ledger.effort + agent_profile.effort_pref exist with
#      the length CHECKs, both tables still ENABLE+FORCE row level security, and
#      schema_v0.sql is untouched in the working tree.
#   2. GET /v1/provider/effort-table: 401 unauthenticated, 200 for a member, the
#      provider×model shape, and no credential-shaped field (ADR-0004).
#   3. routing gates on POST .../agent-runs:
#        * routing.model inside workspace.settings.allowed_agent_models -> 201
#          and the agent_job payload carries the RESOLVED model+effort
#        * routing.model outside the allow-list                      -> 400
#        * routing.effort the resolved model does not support        -> 400
#        * unknown key inside routing / at the top level             -> 400
#        * input.routing disagreeing with the top-level routing      -> 400
#   4. inheritance (D3): no routing -> agent_profile model_pref/effort_pref are
#      applied silently, and an effort_pref the resolved model cannot honour is
#      dropped (never a 400) — audited as ignored_effort_pref.
#   5. usage_ledger.effort: a full gateway roundtrip (agent bearer -> claim the
#      pending job -> POST .../gateway/complete) writes the effort column, and
#      the adapter-reported effort wins over the requested one.
#
# Ports default to the worktree compose env (.env.worktree -> .conductor/local.env)
# so parallel worktrees never collide. The stack is torn down with `down -v`.
#
# Environment:
#   RUN_ROUTING_PROJECT        compose project name (default: momo621routing)
#   RUN_ROUTING_API_PORT       API host port       (default: $PORT or 24660)
#   RUN_ROUTING_POSTGRES_PORT  Postgres host port  (default: $POSTGRES_PORT or 24662)
#   RUN_ROUTING_CENT_PORT      Centrifugo port     (default: $CENT_PORT or 24661)
#   RUN_ROUTING_HERMES_PORT    mock-hermes port    (default: $HERMES_PORT or 24663)
#   RUN_ROUTING_BOOT_TIMEOUT   seconds to wait for /health (default: 2400 — the
#                              api container cold-builds Swift)
#   RUN_ROUTING_KEEP=1         keep the stack up after the run
#   RUN_ROUTING_REUSE=1        reuse an already-running stack (skip `up`)
# =============================================================================
set -euo pipefail
umask 077

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

for tool in docker curl jq python3; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "[run-routing] missing required command: $tool" >&2
    exit 1
  }
done

fail() { echo "[run-routing] FAIL $*" >&2; exit 1; }
pass() { echo "[run-routing] PASS $*"; }
uuid() { python3 -c 'import uuid; print(uuid.uuid4())'; }

# ---- 1a. schema_v0.sql must stay untouched (hard rule) ----------------------
if git -C "$REPO_ROOT" diff --name-only HEAD 2>/dev/null | grep -qx "schema_v0.sql"; then
  fail "schema_v0.sql must not be modified (migration-only)"
fi
MIGRATION="server/Migrations/041_run_routing_effort.sql"
test -f "$MIGRATION" || fail "missing migration $MIGRATION"
sh "$REPO_ROOT/scripts/check_migration_numbers.sh" >/dev/null \
  || fail "duplicate migration number prefix"
pass "migration 041 present with a unique prefix; schema_v0.sql untouched"

# Worktree compose env: ports + credentials live in .conductor/local.env.
for candidate in "$REPO_ROOT/.env.worktree" "$REPO_ROOT/.conductor/local.env" "$REPO_ROOT/.env"; do
  if [ -f "$candidate" ]; then
    set -a
    # shellcheck disable=SC1090
    . "$candidate"
    set +a
    echo "[run-routing] compose env: $candidate"
    break
  fi
done

COMPOSE_FILE="$REPO_ROOT/infra/docker-compose.e2e.yml"
PROJECT="${RUN_ROUTING_PROJECT:-momo621routing}"
API_PORT="${RUN_ROUTING_API_PORT:-${PORT:-24660}}"
CENT_PORT_HOST="${RUN_ROUTING_CENT_PORT:-${CENT_PORT:-24661}}"
PG_PORT="${RUN_ROUTING_POSTGRES_PORT:-${POSTGRES_PORT:-24662}}"
HERMES_PORT_HOST="${RUN_ROUTING_HERMES_PORT:-${HERMES_PORT:-24663}}"
BOOT_TIMEOUT="${RUN_ROUTING_BOOT_TIMEOUT:-2400}"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/momo-run-routing.XXXXXX")"
BASE_URL="http://127.0.0.1:$API_PORT"
OVERRIDE_FILE="$TMP_DIR/run-routing.override.yml"

# Work runs are refused with 409 unless the BYOA gateway is enabled, and the
# gateway callback surface (used by layer 5) is mounted only in gateway mode.
cat >"$OVERRIDE_FILE" <<'YAML'
services:
  api:
    environment:
      AGENT_GATEWAY_MODE: gateway
      MEMORY_EXTRACTION_ENABLED: "0"
      MEMORY_EMBEDDING_ENABLED: "0"
YAML

compose() {
  PORT="$API_PORT" CENT_PORT="$CENT_PORT_HOST" POSTGRES_PORT="$PG_PORT" \
    HERMES_PORT="$HERMES_PORT_HOST" \
    docker compose -p "$PROJECT" -f "$COMPOSE_FILE" -f "$OVERRIDE_FILE" "$@"
}

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if [ "${RUN_ROUTING_KEEP:-0}" = "1" ]; then
    echo "[run-routing] leaving compose project '$PROJECT' up; evidence $TMP_DIR"
  else
    compose down -v --remove-orphans >/dev/null 2>&1 || true
    case "$TMP_DIR" in
      "${TMPDIR:-/tmp}"/momo-run-routing.*) rm -r -- "$TMP_DIR" ;;
      *) echo "[run-routing] refusing unexpected cleanup path: $TMP_DIR" >&2 ;;
    esac
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

run_sql() {
  compose exec -T postgres psql -U "${POSTGRES_USER:-momo}" -d "${POSTGRES_DB:-momo}" \
    -v ON_ERROR_STOP=1 --no-psqlrc -q "$@"
}
sql_value() { run_sql -tA | tr -d '[:space:]'; }

if [ "${RUN_ROUTING_REUSE:-0}" = "1" ]; then
  echo "[run-routing] reusing running stack $PROJECT on $BASE_URL"
else
  python3 - "$API_PORT" "$CENT_PORT_HOST" "$PG_PORT" "$HERMES_PORT_HOST" <<'PY'
import socket, sys
ports = [int(value) for value in sys.argv[1:]]
if len(ports) != len(set(ports)):
    raise SystemExit(f"[run-routing] reserved ports must be distinct: {ports}")
PY
  echo "[run-routing] booting isolated API stack $PROJECT (api cold build can take minutes)"
  compose up -d api
  # Force-recreate so the api always rebuilds the current worktree source; a warm
  # container from an earlier run would serve pre-0134 code.
  compose up -d --force-recreate --no-deps api
fi

deadline=$(( $(date -u +%s) + BOOT_TIMEOUT ))
until curl -fsS "$BASE_URL/health" >/dev/null 2>&1; do
  if [ "$(date -u +%s)" -ge "$deadline" ]; then
    compose logs --tail 200 api migrate db-roles >&2 || true
    fail "api health timeout on $BASE_URL"
  fi
  sleep 3
done
echo "[run-routing] api health green on $BASE_URL"

# =============================================================================
# 1b. Migration 041 applied: columns, CHECKs, and untouched FORCE RLS.
# =============================================================================
COLUMNS="$(sql_value <<'SQL'
SELECT string_agg(table_name || '.' || column_name || ':' || is_nullable, ',' ORDER BY table_name)
  FROM information_schema.columns
 WHERE (table_name, column_name) IN (('usage_ledger','effort'), ('agent_profile','effort_pref'));
SQL
)"
[ "$COLUMNS" = "agent_profile.effort_pref:YES,usage_ledger.effort:YES" ] \
  || fail "migration 041 columns missing or not nullable: '$COLUMNS'"

CHECKS="$(sql_value <<'SQL'
SELECT count(*) FROM pg_constraint
 WHERE conname IN ('usage_ledger_effort_ck','agent_profile_effort_pref_ck') AND contype='c';
SQL
)"
[ "$CHECKS" = "2" ] || fail "migration 041 length CHECKs missing (found $CHECKS)"

RLS="$(sql_value <<'SQL'
SELECT string_agg(relname || ':' || relrowsecurity::text || relforcerowsecurity::text, ',' ORDER BY relname)
  FROM pg_class WHERE relname IN ('usage_ledger','agent_profile');
SQL
)"
[ "$RLS" = "agent_profile:truetrue,usage_ledger:truetrue" ] \
  || fail "FORCE RLS regressed on the altered tables: '$RLS'"

OVERLONG="$(run_sql -tA <<'SQL' 2>&1 || true
INSERT INTO agent_profile (agent_member_id, workspace_id, updated_by, effort_pref)
VALUES ('00000000-0000-7000-8000-0000000009ff','00000000-0000-7000-8000-000000000001',
        '00000000-0000-7000-8000-000000000101', repeat('x', 33));
SQL
)"
printf '%s' "$OVERLONG" | grep -q "agent_profile_effort_pref_ck" \
  || fail "33-char effort_pref was not rejected by the CHECK: $OVERLONG"
pass "migration 041: nullable effort columns + length CHECKs, FORCE RLS intact on both tables"

# =============================================================================
# Fixture: demo workspace/channel/agent + admin login + allow-list.
# =============================================================================
WS_ID="00000000-0000-7000-8000-000000000001"
OTHER_WS_ID="00000000-0000-7000-8000-000000000002"
CHANNEL_ID="00000000-0000-7000-8000-000000000202"
RUN_TAG="$(date -u +%s)-$$"
ADMIN_PASSWORD="routing-admin-$(uuid)"

ADMIN_ID="$(sql_value <<SQL
SELECT lower(member_id::text) FROM human WHERE workspace_id='$WS_ID' AND email='demo@momo.local';
SQL
)"
AGENT_ID="$(sql_value <<SQL
SELECT lower(m.id::text)
  FROM member m
  JOIN agent a ON a.workspace_id=m.workspace_id AND a.member_id=m.id
  JOIN membership ms ON ms.workspace_id=m.workspace_id AND ms.member_id=m.id
 WHERE m.workspace_id='$WS_ID' AND ms.channel_id='$CHANNEL_ID' AND ms.left_at IS NULL
 ORDER BY m.id LIMIT 1;
SQL
)"
[ -n "$ADMIN_ID" ] && [ -n "$AGENT_ID" ] || fail "seed admin/agent missing"
BASE_MODEL="$(sql_value <<SQL
SELECT model FROM agent WHERE workspace_id='$WS_ID' AND member_id='$AGENT_ID';
SQL
)"
[ "$BASE_MODEL" = "hermes-agent" ] || fail "unexpected seeded agent model: '$BASE_MODEL'"

run_sql >/dev/null <<SQL
UPDATE human SET password_hash=momo_password_hash('$ADMIN_PASSWORD')
 WHERE workspace_id='$WS_ID' AND email='demo@momo.local';
-- The seed pins max_concurrent_runs=1 (loop safety); this gate deliberately
-- keeps several queued runs alive at once to compare their routing.
UPDATE agent SET max_concurrent_runs=20 WHERE workspace_id='$WS_ID' AND member_id='$AGENT_ID';
-- Issuing the agent bearer (layer 5) needs a workspace owner/admin; the base
-- seed only creates channel membership.
INSERT INTO workspace_membership (workspace_id, member_id, role)
VALUES ('$WS_ID','$ADMIN_ID','owner')
ON CONFLICT (workspace_id, member_id) DO UPDATE SET role='owner';
-- ADR-0131 D2 allow-list: the request tier is gated against exactly this set
-- (plus the agent's own model).
UPDATE workspace
   SET settings = COALESCE(settings, '{}'::jsonb)
       || jsonb_build_object('allowed_agent_models', jsonb_build_array('hermes-fast','hermes-lite'))
 WHERE id='$WS_ID';
SQL

login() {
  curl -fsS -X POST "$BASE_URL/v1/auth/login" -H 'Content-Type: application/json' \
    --data "$(jq -cn --arg e "$1" --arg p "$2" --arg w "$WS_ID" \
      '{email:$e,password:$p,workspace:$w}')" | jq -er '.accessToken'
}
ADMIN_TOKEN="$(login demo@momo.local "$ADMIN_PASSWORD")"
[ -n "$ADMIN_TOKEN" ] || fail "admin login returned no token"

STATUS=""
BODY=""
api() { # <method> <path> <token> [body]
  local method="$1" path="$2" token="$3" body="${4:-}" out="$TMP_DIR/response.json"
  local args=(-sS -o "$out" -w '%{http_code}' --max-time 60 -X "$method")
  [ -n "$token" ] && args+=(-H "Authorization: Bearer $token")
  if [ -n "$body" ]; then
    args+=(-H 'Content-Type: application/json' --data "$body")
  fi
  STATUS="$(curl "${args[@]}" "$BASE_URL$path")"
  BODY="$(cat "$out")"
}
expect() { # <expected> <label>
  [ "$STATUS" = "$1" ] || { echo "[run-routing] response: $BODY" >&2
    fail "$2: expected HTTP $1, got $STATUS"; }
  pass "$2 ($1)"
}

# =============================================================================
# 2. GET /v1/provider/effort-table
# =============================================================================
api GET /v1/provider/effort-table ""
expect 401 "effort-table refuses an unauthenticated read"

api GET /v1/provider/effort-table "$ADMIN_TOKEN"
expect 200 "effort-table read"
printf '%s' "$BODY" | jq -e '
  .schema == "momo.provider.effort_table.v0"
  and .levels == ["low","medium","high","xhigh","max"]
  and (.providers | length) >= 1
  and (.providers[0].provider == "hermes")
  and ([.providers[].models[] | select(.model=="hermes-agent") | .efforts] | first
       == ["low","medium","high","xhigh","max"])
  and ([.providers[].models[] | select(.model=="hermes-fast") | .efforts] | first
       == ["low","medium"])
  and (.fallback.efforts == ["low","medium","high"])
' >/dev/null || { echo "$BODY" >&2; fail "effort-table shape"; }
printf '%s' "$BODY" | jq -e '(keys - ["schema","levels","fallback","providers"]) | length == 0' \
  >/dev/null || { echo "$BODY" >&2; fail "effort-table exposes an unexpected top-level field"; }
printf '%s' "$BODY" | grep -Eiq 'api[_-]?key|bearer|token|secret|base_url' \
  && fail "ADR-0004: effort-table response leaked a credential-shaped field"
pass "effort-table: provider×model shape, per-model xhigh/max difference, no credential field"

# =============================================================================
# 3. routing gates on run creation
# =============================================================================
create_run() { # <routing-json-or-empty> [input-extra-json]
  local routing="$1" extra="${2:-}"
  local input body
  input="$(jq -cn --arg t "MOMO-621 $RUN_TAG" --arg b "verify run routing" \
    '{type:"work",title:$t,brief:$b}')"
  if [ -n "$extra" ]; then
    input="$(jq -c --argjson e "$extra" '. + $e' <<<"$input")"
  fi
  body="$(jq -cn --arg a "$AGENT_ID" --arg c "$(uuid)" --argjson i "$input" \
    '{agentMemberId:$a,clientRunId:$c,input:$i}')"
  if [ -n "$routing" ]; then
    body="$(jq -c --argjson r "$routing" '. + {routing:$r}' <<<"$body")"
  fi
  api POST "/v1/workspaces/$WS_ID/channels/$CHANNEL_ID/agent-runs" "$ADMIN_TOKEN" "$body"
}

job_payload_for_run() { # <run-id>
  run_sql -tA <<SQL | head -n 1
SELECT payload::text FROM outbox
 WHERE workspace_id='$WS_ID' AND kind='agent_job'
   AND lower(payload->>'run_id')=lower('$1')
 ORDER BY id DESC LIMIT 1;
SQL
}

# 3a. allowed model + supported effort -> 201, resolved values on the job payload
create_run '{"model":"hermes-fast","effort":"low"}'
expect 201 "explicit allowed routing creates the run"
EXPLICIT_RUN_ID="$(printf '%s' "$BODY" | jq -er '.id | ascii_downcase')"
printf '%s' "$BODY" | jq -e '.input.routing == {model:"hermes-fast",effort:"low"}' >/dev/null \
  || { echo "$BODY" >&2; fail "agent_run.input did not echo the requested routing"; }
PAYLOAD="$(job_payload_for_run "$EXPLICIT_RUN_ID")"
printf '%s' "$PAYLOAD" | jq -e '.model == "hermes-fast" and .effort == "low"' >/dev/null \
  || { echo "$PAYLOAD" >&2; fail "agent_job payload does not carry the resolved model/effort"; }
pass "routing{model,effort} -> 201, echoed on input.routing, resolved onto the agent_job payload (gateway→adapter)"

# 3b. model outside the allow-list -> 400 (never a silent downgrade)
create_run '{"model":"external-premium"}'
expect 400 "routing.model outside allowed_agent_models"
DENIED_RUNS="$(sql_value <<SQL
SELECT count(*) FROM agent_run
 WHERE workspace_id='$WS_ID' AND input->'routing'->>'model'='external-premium';
SQL
)"
[ "$DENIED_RUNS" = "0" ] || fail "a rejected routing still wrote an agent_run row"
pass "disallowed model is refused and rolls back (no agent_run row)"

# 3c. effort the resolved model cannot support -> 400
create_run '{"model":"hermes-fast","effort":"max"}'
expect 400 "routing.effort unsupported by the requested model"
create_run '{"effort":"ultra"}'
expect 400 "routing.effort outside the canonical level set"

# 3d. closed-world violations -> 400
create_run '{"model":"hermes-fast","temperature":0.7}'
expect 400 "unknown field inside routing"
UNKNOWN_TOP="$(jq -cn --arg a "$AGENT_ID" --arg c "$(uuid)" --arg t "MOMO-621 $RUN_TAG" \
  '{agentMemberId:$a,clientRunId:$c,input:{type:"work",title:$t,brief:"b"},model:"hermes-fast"}')"
api POST "/v1/workspaces/$WS_ID/channels/$CHANNEL_ID/agent-runs" "$ADMIN_TOKEN" "$UNKNOWN_TOP"
expect 400 "unknown top-level field on the run request"

# 3e. input.routing is accepted, and it must agree with the top-level block
create_run '' '{"routing":{"model":"hermes-lite","effort":"medium"}}'
expect 201 "input.routing alone is accepted"
INPUT_RUN_ID="$(printf '%s' "$BODY" | jq -er '.id | ascii_downcase')"
printf '%s' "$(job_payload_for_run "$INPUT_RUN_ID")" \
  | jq -e '.model == "hermes-lite" and .effort == "medium"' >/dev/null \
  || fail "input.routing did not resolve onto the job payload"
create_run '{"model":"hermes-fast"}' '{"routing":{"model":"hermes-lite"}}'
expect 400 "conflicting top-level routing vs input.routing"
pass "closed-world routing gates: unknown keys, unsupported effort, conflicting blocks all 400"

# =============================================================================
# 4. Inheritance (ADR-0134 D3): agent profile tier, silently applied/ignored
# =============================================================================
run_sql >/dev/null <<SQL
INSERT INTO agent_profile (agent_member_id, workspace_id, instructions, model_pref,
                           effort_pref, updated_by)
VALUES ('$AGENT_ID','$WS_ID','', 'hermes-fast', 'low', '$ADMIN_ID')
ON CONFLICT (agent_member_id) DO UPDATE
  SET model_pref = EXCLUDED.model_pref, effort_pref = EXCLUDED.effort_pref;
SQL
create_run ''
expect 201 "run without routing inherits the agent profile"
INHERIT_RUN_ID="$(printf '%s' "$BODY" | jq -er '.id | ascii_downcase')"
printf '%s' "$BODY" | jq -e '.input | has("routing") | not' >/dev/null \
  || fail "inherited routing must not be echoed as if the client had asked for it"
printf '%s' "$(job_payload_for_run "$INHERIT_RUN_ID")" \
  | jq -e '.model == "hermes-fast" and .effort == "low"' >/dev/null \
  || fail "profile model_pref/effort_pref were not inherited onto the job payload"
pass "no routing -> model_pref+effort_pref inherited (hermes-fast/low)"

# effort_pref the resolved model cannot honour -> dropped, audited, NOT a 400.
run_sql >/dev/null <<SQL
UPDATE agent_profile SET effort_pref='max' WHERE agent_member_id='$AGENT_ID';
SQL
create_run ''
expect 201 "unusable effort_pref does not fail the request"
IGNORED_RUN_ID="$(printf '%s' "$BODY" | jq -er '.id | ascii_downcase')"
printf '%s' "$(job_payload_for_run "$IGNORED_RUN_ID")" \
  | jq -e 'has("effort") | not' >/dev/null \
  || fail "an unsupported effort_pref leaked onto the job payload"
IGNORED_AUDIT="$(sql_value <<SQL
SELECT count(*) FROM audit_log
 WHERE workspace_id='$WS_ID' AND action='agent.work.queued'
   AND lower(run_id::text)='$IGNORED_RUN_ID'
   AND detail->>'ignored_effort_pref'='max'
   AND detail->>'resolved_model'='hermes-fast';
SQL
)"
[ "$IGNORED_AUDIT" = "1" ] || fail "ignored effort_pref was not audited ($IGNORED_AUDIT)"
pass "unusable effort_pref is silently dropped + audited (ignored_effort_pref), request still 201"

# An explicit request still overrides the profile.
create_run '{"effort":"medium"}'
expect 201 "explicit effort overrides the profile preference"
OVERRIDE_RUN_ID="$(printf '%s' "$BODY" | jq -er '.id | ascii_downcase')"
printf '%s' "$(job_payload_for_run "$OVERRIDE_RUN_ID")" \
  | jq -e '.model == "hermes-fast" and .effort == "medium"' >/dev/null \
  || fail "explicit routing.effort did not win over effort_pref"
run_sql >/dev/null <<SQL
UPDATE agent_profile SET effort_pref='low' WHERE agent_member_id='$AGENT_ID';
SQL
pass "request tier overrides the agent tier (D3 chain order)"

# =============================================================================
# 5. usage_ledger.effort via the real gateway completion callback
# =============================================================================
CREDENTIAL="$(curl -fsS -X POST \
  "$BASE_URL/v1/workspaces/$WS_ID/agents/$AGENT_ID/credentials" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  --data '{"label":"MOMO-621 run routing verifier"}')"
AGENT_TOKEN="$(printf '%s' "$CREDENTIAL" | jq -er '.token')"
[ -n "$AGENT_TOKEN" ] || fail "agent bearer was not issued"

# One claim for every pending job: a claim hands out 30s leases, so re-claiming
# per run would find its own still-live leases and return nothing. All three
# completions below run well inside that window.
api GET "/v1/workspaces/$WS_ID/agents/$AGENT_ID/gateway/jobs/pending?limit=50" "$AGENT_TOKEN"
expect 200 "agent bearer claims the pending gateway jobs"
printf '%s' "$BODY" >"$TMP_DIR/jobs.json"
CLAIMED="$(jq -r '.jobs | length' "$TMP_DIR/jobs.json")"
[ "$CLAIMED" -ge 3 ] || { cat "$TMP_DIR/jobs.json" >&2; fail "expected >=3 claimed jobs, got $CLAIMED"; }
jq -e '[.jobs[] | select(.payload.effort != null)] | length >= 2' "$TMP_DIR/jobs.json" \
  >/dev/null || fail "claimed gateway jobs do not expose the effort axis to the adapter"
pass "gateway pending claim delivers $CLAIMED jobs carrying model+effort to the adapter (ADR-0130)"

complete_run() { # <run-id> <usage-json>
  local job complete
  job="$(jq -c --arg r "$1" '.jobs[] | select((.runId|ascii_downcase)==$r)' "$TMP_DIR/jobs.json")"
  [ -n "$job" ] || { cat "$TMP_DIR/jobs.json" >&2; fail "no claimed gateway job for run $1"; }
  complete="$(jq -cn --argjson j "$(jq -r '.id' <<<"$job")" \
    --arg l "$(jq -r '.leaseId' <<<"$job")" --argjson u "$2" \
    '{job_id:$j,lease_id:$l,status:"succeeded",body:"MOMO-621 gateway completion",usage:$u}')"
  api POST "/v1/workspaces/$WS_ID/agent-runs/$1/gateway/complete" "$AGENT_TOKEN" "$complete"
}

# 5a. adapter reports the effort it actually ran with -> that value is recorded.
complete_run "$EXPLICIT_RUN_ID" \
  '{"model":"hermes-fast","effort":"medium","prompt_tokens":120,"completion_tokens":30,"cost_micro_usd":4200,"was_estimated":false}'
expect 200 "gateway completion with a reported effort"
LEDGER="$(sql_value <<SQL
SELECT coalesce(model,'-') || '|' || coalesce(effort,'NULL') || '|' || cost_micro_usd::text
  FROM usage_ledger WHERE workspace_id='$WS_ID' AND lower(run_id::text)='$EXPLICIT_RUN_ID';
SQL
)"
[ "$LEDGER" = "hermes-fast|medium|4200" ] \
  || fail "usage_ledger did not record the adapter-reported effort: '$LEDGER'"
pass "usage_ledger.effort records the adapter-reported effort (hermes-fast|medium)"

# 5b. adapter omits effort -> the run's requested effort is the fallback.
complete_run "$INPUT_RUN_ID" \
  '{"model":"hermes-lite","prompt_tokens":10,"completion_tokens":5,"cost_micro_usd":90,"was_estimated":true}'
expect 200 "gateway completion without a reported effort"
LEDGER_FALLBACK="$(sql_value <<SQL
SELECT coalesce(effort,'NULL') FROM usage_ledger
 WHERE workspace_id='$WS_ID' AND lower(run_id::text)='$INPUT_RUN_ID';
SQL
)"
[ "$LEDGER_FALLBACK" = "medium" ] \
  || fail "ledger fallback to the requested effort failed: '$LEDGER_FALLBACK'"
pass "no reported effort -> the run's requested effort is recorded (medium)"

# 5c. nothing requested and an unusable preference -> NULL, never a wrong axis.
run_sql >/dev/null <<SQL
UPDATE agent_profile SET effort_pref='max' WHERE agent_member_id='$AGENT_ID';
SQL
complete_run "$IGNORED_RUN_ID" \
  '{"model":"hermes-fast","prompt_tokens":7,"completion_tokens":3,"cost_micro_usd":40,"was_estimated":true}'
expect 200 "gateway completion for the inherited-but-unusable run"
LEDGER_NULL="$(sql_value <<SQL
SELECT coalesce(effort,'NULL') FROM usage_ledger
 WHERE workspace_id='$WS_ID' AND lower(run_id::text)='$IGNORED_RUN_ID';
SQL
)"
[ "$LEDGER_NULL" = "NULL" ] \
  || fail "an unsupported preference was written to the ledger: '$LEDGER_NULL'"
pass "unsupported inherited effort is NOT recorded (NULL), so the analysis axis stays honest"

# ---- cross-tenant isolation of the new columns ------------------------------
FOREIGN_ROWS="$(compose exec -T -e PGPASSWORD=momo_app_dev_pw postgres \
  psql -U momo_app -d "${POSTGRES_DB:-momo}" -v ON_ERROR_STOP=1 --no-psqlrc -q -tA <<SQL | tr -d '[:space:]'
BEGIN;
SET LOCAL app.workspace_id='$OTHER_WS_ID';
SELECT count(*) FROM usage_ledger WHERE effort IS NOT NULL;
COMMIT;
SQL
)"
[ "$FOREIGN_ROWS" = "0" ] || fail "cross-tenant read exposed effort rows ($FOREIGN_ROWS)"
OWN_ROWS="$(compose exec -T -e PGPASSWORD=momo_app_dev_pw postgres \
  psql -U momo_app -d "${POSTGRES_DB:-momo}" -v ON_ERROR_STOP=1 --no-psqlrc -q -tA <<SQL | tr -d '[:space:]'
BEGIN;
SET LOCAL app.workspace_id='$WS_ID';
SELECT count(*) FROM usage_ledger WHERE effort IS NOT NULL;
COMMIT;
SQL
)"
[ "$OWN_ROWS" = "2" ] || fail "own-workspace effort rows expected 2, got $OWN_ROWS"
pass "usage_ledger.effort stays FORCE-RLS isolated (own=2, foreign=0)"

echo "[run-routing] PASS request-level model/effort routing runtime gate (MOMO-621 / ADR-0134 D1·D2·D3)"

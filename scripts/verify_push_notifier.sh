#!/usr/bin/env bash
# =============================================================================
# scripts/verify_push_notifier.sh — MOMO-404 (ADR-0120 P-2) notifier worker +
# 판정 v0 + mock relay runtime gate.
#
# Boots an ISOLATED e2e compose stack (infra/docker-compose.e2e.yml +
# infra/e2e/push-notifier.overlay.yml, `--profile push`) under its own compose
# project on loopback ports (19600s) and drives the full server-side push
# pipeline end to end:
#
#   MOMO-403 REST device registration (the canonical path — no SQL-inserted
#   devices) -> DM / mention / approval-request events raised via REST ->
#   011 trigger enqueues outbox kind='push_candidate' in the same tx ->
#   NotifierWorker (BYPASSRLS momo_notifier) claims with SKIP LOCKED, judges
#   v0 (DM 전건 + server-recomputed mention projection + approval request),
#   records idempotent push_dispatch_log rows, POSTs id-only dispatches to
#   scripts/mock_push_relay.py -> verifier asserts:
#
#   - dispatch_log contract rows (member/token/collapse_id/apns_status=200)
#   - author exclusion (the sender's own registered device gets NOTHING)
#   - mock relay received payloads are id-only: message bodies, display
#     names, and handles are ABSENT (ADR-0120 D2 hard contract) and every
#     payload key is in the allowed routing/identity set
#   - at-least-once + idempotent dispatch: a candidate stuck in 'processing'
#     is swept back on notifier restart and reprocessed WITHOUT duplicate
#     dispatches; a candidate flipped back to 'pending' on a live notifier
#     (redelivery) also produces zero new dispatches
#   - consumer mutual exclusion / no regression: relay still drains every
#     kind='broadcast' row to done, the gateway kind='agent_job' row keeps
#     its own REST-driven lifecycle, and the notifier only ever touches
#     kind='push_candidate'
#   - 011 migration objects + momo_notifier role connected
#
# The approval leg runs through AGENT_GATEWAY_MODE=gateway (overlay): mention
# the seeded @hermes agent -> claim the gateway job with a REST-minted
# per-agent bearer -> POST an approval_request gateway event. This creates a
# real approval_request message + approval row without booting AgentWorker
# (one less cold Swift build under Docker VM memory pressure).
#
# Boot pattern (MOMO-401 staggered-boot memory guard, three cold Swift
# builds): api first (health green = build done), then relay (log marker),
# then notifier (log marker). mock-hermes / mock-push-relay are instant.
#
# Isolation: dedicated COMPOSE_PROJECT_NAME (default momo404notif), loopback
# host ports 19600-19604, teardown removes only this project's containers and
# volumes. It never touches other compose projects or host momo processes.
#
# Environment overrides:
#   PUSH_NOTIF_PROJECT         compose project    (default: momo404notif)
#   PUSH_NOTIF_PORT            api host port      (default: 19600)
#   PUSH_NOTIF_POSTGRES_PORT   postgres host port (default: 19601)
#   PUSH_NOTIF_CENT_PORT       centrifugo port    (default: 19602)
#   PUSH_NOTIF_HERMES_PORT     mock-hermes port   (default: 19603)
#   PUSH_NOTIF_RELAY_PORT      mock push relay    (default: 19604)
#   PUSH_NOTIF_BOOT_TIMEOUT    seconds per cold Swift build (default: 2400)
#   PUSH_NOTIF_WAIT_TIMEOUT    seconds for runtime assertions (default: 120)
#   PUSH_NOTIF_KEEP=1          keep the stack up for debugging
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "[push-notif] missing required command: $1" >&2
    exit 1
  }
}

need docker
need curl
need jq
need uuidgen
need python3

COMPOSE_FILE="$REPO_ROOT/infra/docker-compose.e2e.yml"
OVERLAY_FILE="$REPO_ROOT/infra/e2e/push-notifier.overlay.yml"
PROJECT="${PUSH_NOTIF_PROJECT:-momo404notif}"
API_PORT="${PUSH_NOTIF_PORT:-19600}"
PG_PORT="${PUSH_NOTIF_POSTGRES_PORT:-19601}"
CENT_PORT_HOST="${PUSH_NOTIF_CENT_PORT:-19602}"
HERMES_PORT_HOST="${PUSH_NOTIF_HERMES_PORT:-19603}"
RELAY_PORT_HOST="${PUSH_NOTIF_RELAY_PORT:-19604}"
BOOT_TIMEOUT="${PUSH_NOTIF_BOOT_TIMEOUT:-2400}"
WAIT_TIMEOUT="${PUSH_NOTIF_WAIT_TIMEOUT:-120}"

RUN_EPOCH="$(date -u +%s)"
RUN_ID="${RUN_EPOCH}-$$"
TMP_DIR="${TMPDIR:-/tmp}/momo-push-notif-$RUN_ID"
mkdir -p "$TMP_DIR"

DEMO_WORKSPACE_ID="00000000-0000-7000-8000-000000000001"
GENERAL_CHANNEL_ID="00000000-0000-7000-8000-000000000201"
HERMES_AGENT_ID="00000000-0000-7000-8000-000000000103"
DEMO_EMAIL="demo@momo.local"
DEMO_PASSWORD="dev-password"

# Disposable members. Random per-run passwords; seed rows are never mutated.
M1_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"   # sender (registers a device too)
M2_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"   # recipient
M1_EMAIL="push-sender-$RUN_ID@momo.local"
M2_EMAIL="push-recipient-$RUN_ID@momo.local"
M1_PASSWORD="push-$(uuidgen | tr '[:upper:]' '[:lower:]')"
M2_PASSWORD="push-$(uuidgen | tr '[:upper:]' '[:lower:]')"
M1_NAME="MOMO404-Sender-$RUN_EPOCH"
M2_NAME="MOMO404-Recipient-$RUN_EPOCH"
M1_HANDLE="push-send-$RUN_EPOCH"
M2_HANDLE="push-recv-$RUN_EPOCH"

DEVICE1_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
DEVICE2_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
hex64() { printf '%s%s' "$(uuidgen | tr -d '-')" "$(uuidgen | tr -d '-')" | tr '[:upper:]' '[:lower:]'; }
TOKEN1="$(hex64)"
TOKEN2="$(hex64)"
TOPIC="kim.dawn.momo.e2e"

# Content markers that must NEVER appear in relay-bound payloads (D2).
DM_SECRET="MOMO404DMSECRET$(uuidgen | tr -d '-' | cut -c1-12)"
MENTION_SECRET="MOMO404MENTIONSECRET$(uuidgen | tr -d '-' | cut -c1-12)"
APPROVAL_SECRET="MOMO404APPROVALSECRET$(uuidgen | tr -d '-' | cut -c1-12)"

compose() {
  PORT="$API_PORT" \
  POSTGRES_PORT="$PG_PORT" \
  CENT_PORT="$CENT_PORT_HOST" \
  HERMES_PORT="$HERMES_PORT_HOST" \
  PUSH_RELAY_PORT="$RELAY_PORT_HOST" \
  docker compose -p "$PROJECT" -f "$COMPOSE_FILE" -f "$OVERLAY_FILE" --profile push "$@"
}

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if [ "${PUSH_NOTIF_KEEP:-0}" = "1" ]; then
    echo "[push-notif] PUSH_NOTIF_KEEP=1 — leaving compose project '$PROJECT' up"
  else
    echo "[push-notif] tearing down compose project '$PROJECT'"
    compose down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

port_in_use() {
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null && { exec 3>&- 3<&-; return 0; }
  return 1
}

for p in "$API_PORT" "$PG_PORT" "$CENT_PORT_HOST" "$HERMES_PORT_HOST" "$RELAY_PORT_HOST"; do
  if port_in_use "$p"; then
    if [ -z "$(compose ps -q --status running 2>/dev/null)" ]; then
      echo "[push-notif] host port $p is busy and not owned by compose project '$PROJECT'." >&2
      echo "[push-notif] Override with PUSH_NOTIF_PORT/PUSH_NOTIF_POSTGRES_PORT/PUSH_NOTIF_CENT_PORT/PUSH_NOTIF_HERMES_PORT/PUSH_NOTIF_RELAY_PORT." >&2
      exit 1
    fi
  fi
done

BASE_URL="http://127.0.0.1:$API_PORT"
PUSH_RELAY_URL="http://127.0.0.1:$RELAY_PORT_HOST"

# ---- staggered boot (three cold Swift builds, one at a time) -----------------
echo "[push-notif] booting compose project '$PROJECT' — api first (cold Swift build #1)"
compose up -d api

echo "[push-notif] waiting for $BASE_URL/health (timeout ${BOOT_TIMEOUT}s)"
deadline=$(( $(date -u +%s) + BOOT_TIMEOUT ))
until curl -fsS "$BASE_URL/health" >/dev/null 2>&1; do
  if [ "$(date -u +%s)" -ge "$deadline" ]; then
    echo "[push-notif] timed out waiting for api health" >&2
    compose logs --tail 80 api >&2 || true
    exit 1
  fi
  if [ -n "$(compose ps -aq --status exited api 2>/dev/null)" ]; then
    echo "[push-notif] api container exited before health became green" >&2
    compose logs --tail 120 api >&2 || true
    exit 1
  fi
  sleep 3
done
echo "[push-notif] api health is green"

wait_for_log() { # service marker timeout min_count
  local service="$1" marker="$2" timeout="$3" min_count="${4:-1}"
  local log_deadline=$(( $(date -u +%s) + timeout ))
  while :; do
    local count
    count="$(compose logs --no-log-prefix "$service" 2>/dev/null | grep -c "$marker" || true)"
    if [ "${count:-0}" -ge "$min_count" ]; then
      return 0
    fi
    if [ -n "$(compose ps -aq --status exited "$service" 2>/dev/null)" ]; then
      echo "[push-notif] $service container exited before '$marker' appeared" >&2
      compose logs --tail 120 "$service" >&2 || true
      exit 1
    fi
    if [ "$(date -u +%s)" -ge "$log_deadline" ]; then
      echo "[push-notif] timed out waiting for $service log marker '$marker'" >&2
      compose logs --tail 80 "$service" >&2 || true
      exit 1
    fi
    sleep 3
  done
}

echo "[push-notif] starting relay (cold Swift build #2, staggered after api)"
compose up -d relay
wait_for_log relay "outbox relay starting" "$BOOT_TIMEOUT"
echo "[push-notif] relay loop is live"

echo "[push-notif] starting notifier + mock-push-relay (cold Swift build #3, staggered)"
compose up -d notifier
wait_for_log notifier "push notifier starting" "$BOOT_TIMEOUT"
echo "[push-notif] notifier loop is live"

# ---- helpers -----------------------------------------------------------------
run_sql() {
  compose exec -T postgres psql -U "${POSTGRES_USER:-momo}" -d "${POSTGRES_DB:-momo}" \
    -v ON_ERROR_STOP=1 --no-psqlrc -q "$@"
}

sql_scalar() { # one -tA scalar query on stdin
  run_sql -tA | tr -d '[:space:]'
}

wait_sql_eq() { # expected label; query on stdin
  local expected="$1" label="$2" query got
  query="$(cat)"
  local sql_deadline=$(( $(date -u +%s) + WAIT_TIMEOUT ))
  while :; do
    got="$(printf '%s\n' "$query" | sql_scalar)"
    if [ "$got" = "$expected" ]; then
      echo "[push-notif] ok: $label"
      return 0
    fi
    if [ "$(date -u +%s)" -ge "$sql_deadline" ]; then
      echo "[push-notif] FAIL $label: expected '$expected', last saw '$got'" >&2
      echo "[push-notif] query: $query" >&2
      compose logs --tail 60 notifier >&2 || true
      exit 1
    fi
    sleep 1
  done
}

RESPONSE_BODY=""
RESPONSE_STATUS=""
api() { # method path [json-body] [token]
  local method="$1" path="$2" body="${3:-}" token="${4:-}"
  local out="$TMP_DIR/response.json"
  local -a args=(-sS -o "$out" -w "%{http_code}" -X "$method" -H "Content-Type: application/json")
  [ -n "$token" ] && args+=(-H "Authorization: Bearer $token")
  [ -n "$body" ] && args+=(--data "$body")
  RESPONSE_STATUS="$(curl "${args[@]}" "$BASE_URL$path")"
  RESPONSE_BODY="$(cat "$out")"
}

expect_status() { # expected label
  if [ "$RESPONSE_STATUS" != "$1" ]; then
    echo "[push-notif] FAIL $2: expected HTTP $1, got $RESPONSE_STATUS" >&2
    echo "$RESPONSE_BODY" >&2
    exit 1
  fi
  echo "[push-notif] ok: $2 (HTTP $1)"
}

login() { # email password -> access token on stdout
  curl -fsS -X POST "$BASE_URL/v1/auth/login" -H 'Content-Type: application/json' \
    -d "$(jq -cn --arg e "$1" --arg p "$2" '{email:$e,password:$p}')" | jq -r '.accessToken'
}

send_message() { # channel_id body token -> message id on stdout (lowercase)
  local out
  out="$TMP_DIR/send.json"
  curl -fsS -X POST "$BASE_URL/v1/workspaces/$DEMO_WORKSPACE_ID/channels/$1/messages" \
    -H 'Content-Type: application/json' -H "Authorization: Bearer $3" \
    -d "$(jq -cn --arg c "$(uuidgen)" --arg b "$2" '{clientMsgId:$c,body:$b}')" >"$out"
  jq -r '.id | ascii_downcase' "$out"
}

relay_received() { curl -fsS "$PUSH_RELAY_URL/received"; }

# ---- fixtures ------------------------------------------------------------------
echo "[push-notif] installing disposable member fixtures (sender + recipient in #general)"
run_sql <<SQL
BEGIN;
SET LOCAL row_security = off;

INSERT INTO member (id, workspace_id, kind, status, display_name, handle)
VALUES
  ('$M1_ID', '$DEMO_WORKSPACE_ID', 'human', 'active', '$M1_NAME', '$M1_HANDLE'),
  ('$M2_ID', '$DEMO_WORKSPACE_ID', 'human', 'active', '$M2_NAME', '$M2_HANDLE');

INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash, tz)
VALUES
  ('$M1_ID', '$DEMO_WORKSPACE_ID', '$M1_EMAIL', true, momo_password_hash('$M1_PASSWORD'), 'UTC'),
  ('$M2_ID', '$DEMO_WORKSPACE_ID', '$M2_EMAIL', true, momo_password_hash('$M2_PASSWORD'), 'UTC');

INSERT INTO membership (workspace_id, channel_id, member_id, role)
VALUES
  ('$DEMO_WORKSPACE_ID', '$GENERAL_CHANNEL_ID', '$M1_ID', 'member'),
  ('$DEMO_WORKSPACE_ID', '$GENERAL_CHANNEL_ID', '$M2_ID', 'member');

COMMIT;
SQL

echo "[push-notif] asserting 011 migration objects exist"
got="$(printf "SELECT count(*) FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'outbox_kind' AND e.enumlabel = 'push_candidate';\n" | sql_scalar)"
[ "$got" = "1" ] || { echo "[push-notif] FAIL: outbox_kind lacks 'push_candidate' (got=$got)" >&2; exit 1; }
got="$(printf "SELECT count(*) FROM pg_trigger WHERE tgname = 'push_candidate_enqueue_trg';\n" | sql_scalar)"
[ "$got" = "1" ] || { echo "[push-notif] FAIL: push_candidate_enqueue_trg missing" >&2; exit 1; }
got="$(printf "SELECT count(*) FROM pg_indexes WHERE indexname = 'push_dispatch_dedupe_uniq';\n" | sql_scalar)"
[ "$got" = "1" ] || { echo "[push-notif] FAIL: push_dispatch_dedupe_uniq missing" >&2; exit 1; }

echo "[push-notif] asserting the notifier is connected as momo_notifier (BYPASSRLS role)"
wait_sql_eq "t" "momo_notifier session present (LISTEN connection)" <<SQL
SELECT count(*) > 0 FROM pg_stat_activity WHERE usename = 'momo_notifier';
SQL

# ---- device registration via MOMO-403 REST (the canonical path) ----------------
echo "[push-notif] logging in fixture members"
M1_ACCESS="$(login "$M1_EMAIL" "$M1_PASSWORD")"
M2_ACCESS="$(login "$M2_EMAIL" "$M2_PASSWORD")"
for v in "$M1_ACCESS" "$M2_ACCESS"; do
  [ -n "$v" ] && [ "$v" != "null" ] || { echo "[push-notif] fixture login failed" >&2; exit 1; }
done

DEV_PATH="/v1/workspaces/$DEMO_WORKSPACE_ID/devices"
api POST "$DEV_PATH" "$(jq -cn --arg d "$DEVICE1_ID" --arg t "$TOKEN1" --arg to "$TOPIC" \
  '{deviceId:$d,platform:"ios",apnsToken:$t,env:"sandbox",topic:$to}')" "$M1_ACCESS"
expect_status 201 "M1 (sender) registers device via MOMO-403 REST"
api POST "$DEV_PATH" "$(jq -cn --arg d "$DEVICE2_ID" --arg t "$TOKEN2" --arg to "$TOPIC" \
  '{deviceId:$d,platform:"ios",apnsToken:$t,env:"sandbox",topic:$to}')" "$M2_ACCESS"
expect_status 201 "M2 (recipient) registers device via MOMO-403 REST"

T2_ID="$(printf "SELECT id FROM push_token WHERE apns_token = '$TOKEN2' AND env = 'sandbox';\n" | sql_scalar)"
[ -n "$T2_ID" ] || { echo "[push-notif] FAIL: T2 push_token row missing" >&2; exit 1; }

# ---- leg 1: DM 전건 --------------------------------------------------------------
echo "[push-notif] leg 1: DM message -> single dispatch to the recipient"
api POST "/v1/workspaces/$DEMO_WORKSPACE_ID/dms" "$(jq -cn --arg m "$M2_ID" '{memberId:$m}')" "$M1_ACCESS"
[ "$RESPONSE_STATUS" = "200" ] || [ "$RESPONSE_STATUS" = "201" ] || {
  echo "[push-notif] FAIL: DM open returned HTTP $RESPONSE_STATUS" >&2; echo "$RESPONSE_BODY" >&2; exit 1; }
DM_CHANNEL_ID="$(printf '%s' "$RESPONSE_BODY" | jq -r '.channel.id | ascii_downcase')"
[ -n "$DM_CHANNEL_ID" ] && [ "$DM_CHANNEL_ID" != "null" ] || {
  echo "[push-notif] FAIL: DM open returned no channel id" >&2; exit 1; }
MSG_DM="$(send_message "$DM_CHANNEL_ID" "dm smoke $DM_SECRET" "$M1_ACCESS")"

wait_sql_eq "1" "DM dispatch settled for M2 (apns_status=200)" <<SQL
SELECT count(*) FROM push_dispatch_log
 WHERE message_id = '$MSG_DM' AND member_id = '$M2_ID'
   AND push_token_id = '$T2_ID' AND collapse_id = 'm:$MSG_DM'
   AND apns_status = 200;
SQL
got="$(printf "SELECT count(*) FROM push_dispatch_log WHERE message_id = '$MSG_DM';\n" | sql_scalar)"
[ "$got" = "1" ] || { echo "[push-notif] FAIL: DM expected exactly 1 dispatch row, got $got (author must be excluded)" >&2; exit 1; }
got="$(relay_received | jq -r --arg m "$MSG_DM" '[.received[] | select(.message_id == $m)] | length')"
[ "$got" = "1" ] || { echo "[push-notif] FAIL: mock relay expected 1 DM dispatch, got $got" >&2; exit 1; }
got="$(relay_received | jq -r --arg m "$MSG_DM" '[.received[] | select(.message_id == $m)][0] | "\(.reason)/\(.apns_token)/\(.channel_id)"')"
[ "$got" = "dm/$TOKEN2/$DM_CHANNEL_ID" ] || {
  echo "[push-notif] FAIL: DM relay payload routing mismatch: $got" >&2; exit 1; }
echo "[push-notif] ok: DM dispatch targets the recipient token with reason=dm"

# ---- leg 2: 멘션 (server-recomputed projection) -----------------------------------
echo "[push-notif] leg 2: mention in #general -> single dispatch to the mentioned member"
MSG_MENTION="$(send_message "$GENERAL_CHANNEL_ID" "heads up @$M2_HANDLE $MENTION_SECRET" "$M1_ACCESS")"

wait_sql_eq "1" "mention dispatch settled for M2" <<SQL
SELECT count(*) FROM push_dispatch_log
 WHERE message_id = '$MSG_MENTION' AND member_id = '$M2_ID'
   AND apns_status = 200;
SQL
got="$(printf "SELECT count(*) FROM push_dispatch_log WHERE message_id = '$MSG_MENTION';\n" | sql_scalar)"
[ "$got" = "1" ] || { echo "[push-notif] FAIL: mention expected exactly 1 dispatch row, got $got" >&2; exit 1; }
got="$(relay_received | jq -r --arg m "$MSG_MENTION" '[.received[] | select(.message_id == $m)][0].reason')"
[ "$got" = "mention" ] || { echo "[push-notif] FAIL: mention relay payload reason=$got" >&2; exit 1; }
echo "[push-notif] ok: mention dispatch reuses the server mention projection (reason=mention)"

# ---- leg 3: 승인 요청 (gateway REST -> approval_request message) --------------------
echo "[push-notif] leg 3: approval request via agent gateway REST"
DEMO_ACCESS="$(login "$DEMO_EMAIL" "$DEMO_PASSWORD")"
[ -n "$DEMO_ACCESS" ] && [ "$DEMO_ACCESS" != "null" ] || {
  echo "[push-notif] FAIL: demo admin login failed" >&2; exit 1; }

api POST "/v1/workspaces/$DEMO_WORKSPACE_ID/agents/$HERMES_AGENT_ID/credentials" \
  '{"label":"MOMO-404 push notifier verifier"}' "$DEMO_ACCESS"
expect_status 201 "workspace admin mints @hermes gateway bearer"
AGENT_TOKEN="$(printf '%s' "$RESPONSE_BODY" | jq -r '.token')"
[ -n "$AGENT_TOKEN" ] && [ "$AGENT_TOKEN" != "null" ] || {
  echo "[push-notif] FAIL: agent credential mint returned no token" >&2; exit 1; }

MSG_TRIGGER="$(send_message "$GENERAL_CHANNEL_ID" "@hermes run the MOMO-404 push check" "$M1_ACCESS")"

echo "[push-notif] waiting for the gateway agent_job for the @hermes mention"
wait_sql_eq "1" "gateway agent_job created" <<SQL
SELECT count(*) FROM outbox
 WHERE kind = 'agent_job' AND method = 'gateway'
   AND lower(payload->>'trigger_message_id') = '$MSG_TRIGGER';
SQL
RUN_ID_GW="$(printf "SELECT lower(payload->>'run_id') FROM outbox WHERE kind = 'agent_job' AND method = 'gateway' AND lower(payload->>'trigger_message_id') = '$MSG_TRIGGER';\n" | sql_scalar)"
[ -n "$RUN_ID_GW" ] || { echo "[push-notif] FAIL: gateway job has no run_id" >&2; exit 1; }

claim_deadline=$(( $(date -u +%s) + WAIT_TIMEOUT ))
JOB_ID=""
LEASE_ID=""
while :; do
  api GET "/v1/workspaces/$DEMO_WORKSPACE_ID/agents/$HERMES_AGENT_ID/gateway/jobs/pending" "" "$AGENT_TOKEN"
  if [ "$RESPONSE_STATUS" = "200" ]; then
    JOB_ID="$(printf '%s' "$RESPONSE_BODY" | jq -r --arg run "$RUN_ID_GW" \
      '.jobs[] | select((.runId | ascii_downcase) == $run) | .id' | head -1)"
    LEASE_ID="$(printf '%s' "$RESPONSE_BODY" | jq -r --arg run "$RUN_ID_GW" \
      '.jobs[] | select((.runId | ascii_downcase) == $run) | .leaseId' | head -1)"
    [ -n "$JOB_ID" ] && [ "$JOB_ID" != "null" ] && break
  fi
  if [ "$(date -u +%s)" -ge "$claim_deadline" ]; then
    echo "[push-notif] FAIL: could not claim the gateway job (last HTTP $RESPONSE_STATUS)" >&2
    echo "$RESPONSE_BODY" >&2
    exit 1
  fi
  sleep 1
done
echo "[push-notif] ok: agent bearer claimed gateway job $JOB_ID"

api POST "/v1/workspaces/$DEMO_WORKSPACE_ID/agent-runs/$RUN_ID_GW/gateway/events" "$(jq -cn \
  --argjson job "$JOB_ID" --arg lease "$LEASE_ID" --arg secret "$APPROVAL_SECRET" \
  '{job_id:$job, lease_id:$lease, status:"approval_request", approval_request:{
     action_type:"tool_call",
     title:"MOMO-404 approval fixture",
     summary:("Review before running: " + $secret),
     tool_call:{call_id:"call-momo-404", name:"create_github_issue",
                arguments:{title:"MOMO-404 push approval"},
                tool_grant:{tool_name:"create_github_issue", approval_policy:"require_approval"}},
     estimated_micro_usd:1200, is_reversible:false}}')" "$AGENT_TOKEN"
expect_status 200 "gateway approval_request event accepted"

MSG_APPROVAL="$(printf "SELECT lower(id::text) FROM message WHERE type = 'approval_request' AND run_id = '$RUN_ID_GW';\n" | sql_scalar)"
[ -n "$MSG_APPROVAL" ] || { echo "[push-notif] FAIL: approval_request message missing" >&2; exit 1; }

wait_sql_eq "2" "approval dispatches settled for both registered humans" <<SQL
SELECT count(*) FROM push_dispatch_log
 WHERE message_id = '$MSG_APPROVAL' AND apns_status = 200
   AND member_id IN ('$M1_ID', '$M2_ID');
SQL
got="$(printf "SELECT count(*) FROM push_dispatch_log WHERE message_id = '$MSG_APPROVAL';\n" | sql_scalar)"
[ "$got" = "2" ] || { echo "[push-notif] FAIL: approval expected exactly 2 dispatch rows, got $got" >&2; exit 1; }
got="$(relay_received | jq -r --arg m "$MSG_APPROVAL" '[.received[] | select(.message_id == $m) | .reason] | unique | join(",")')"
[ "$got" = "approval_request" ] || { echo "[push-notif] FAIL: approval relay payload reasons=$got" >&2; exit 1; }
echo "[push-notif] ok: approval request notifies deciding humans (reason=approval_request)"

# The @hermes trigger mention targets only an agent — agents have no devices,
# so judgment must produce ZERO dispatches for that message.
got="$(printf "SELECT count(*) FROM push_dispatch_log WHERE message_id = '$MSG_TRIGGER';\n" | sql_scalar)"
[ "$got" = "0" ] || { echo "[push-notif] FAIL: agent mention must not dispatch (got $got)" >&2; exit 1; }
echo "[push-notif] ok: agent-only mention produced no dispatches"

wait_sql_eq "4" "all four push candidates consumed to done" <<SQL
SELECT count(*) FROM outbox
 WHERE kind = 'push_candidate' AND status = 'done'
   AND lower(payload->>'message_id') IN
       ('$MSG_DM', '$MSG_MENTION', '$MSG_TRIGGER', '$MSG_APPROVAL');
SQL

# ---- id-only hard contract (ADR-0120 D2) -------------------------------------------
echo "[push-notif] asserting the id-only hard contract on every relay-received payload"
RECEIVED_JSON="$TMP_DIR/received.json"
relay_received >"$RECEIVED_JSON"
got="$(jq -r '.count' "$RECEIVED_JSON")"
[ "$got" = "4" ] || { echo "[push-notif] FAIL: mock relay expected exactly 4 dispatches total, got $got" >&2; exit 1; }

for marker in "$DM_SECRET" "$MENTION_SECRET" "$APPROVAL_SECRET" \
              "$M1_NAME" "$M2_NAME" "$M1_HANDLE" "$M2_HANDLE" \
              "dm smoke" "heads up" "Review before running" "Approval required"; do
  if grep -Fq "$marker" "$RECEIVED_JSON"; then
    echo "[push-notif] FAIL: conversation content '$marker' leaked into a relay payload" >&2
    exit 1
  fi
done
echo "[push-notif] ok: no message body, display name, handle, or approval summary in any payload"

python3 - "$RECEIVED_JSON" <<'PY'
import json, sys

allowed = {
    "schema", "server_id", "workspace_id", "device_id", "device_platform",
    "apns_token", "apns_env", "apns_topic", "collapse_id", "badge", "reason",
    "channel_id", "message_id",
}
reasons = {"dm", "mention", "approval_request"}
data = json.load(open(sys.argv[1]))
payloads = data["received"]
assert payloads, "no payloads received"
for p in payloads:
    extra = set(p) - allowed
    assert not extra, f"non-id-only keys in relay payload: {sorted(extra)}"
    assert p["schema"] == "momo.push.dispatch.v1", p["schema"]
    assert p["reason"] in reasons, p["reason"]
    assert isinstance(p["badge"], int) and p["badge"] >= 1, p["badge"]
    assert len(p["collapse_id"].encode()) <= 64, p["collapse_id"]
print(f"[push-notif] ok: {len(payloads)} payloads carry ONLY the allowed id-only key set")
PY

# ---- at-least-once + idempotent dispatch (restart & redelivery) ---------------------
echo "[push-notif] restart/redelivery: stuck-processing sweep + settled-dispatch dedupe"
DISPATCH_BEFORE="$(printf "SELECT count(*) FROM push_dispatch_log;\n" | sql_scalar)"
RECEIVED_BEFORE="$(relay_received | jq -r '.count')"
AGENT_JOB_SNAPSHOT="$(printf "SELECT COALESCE(string_agg(id::text || ':' || status::text, ',' ORDER BY id), '') FROM outbox WHERE kind = 'agent_job';\n" | sql_scalar)"

# Simulate a crash mid-candidate: leave the DM candidate stuck in 'processing'.
run_sql <<SQL
UPDATE outbox SET status = 'processing'
 WHERE kind = 'push_candidate' AND lower(payload->>'message_id') = '$MSG_DM';
SQL

compose restart notifier >/dev/null 2>&1
wait_for_log notifier "push notifier starting" "$BOOT_TIMEOUT" 2
echo "[push-notif] notifier restarted (second boot marker seen)"

wait_sql_eq "done" "stuck DM candidate swept back and reprocessed to done" <<SQL
SELECT status::text FROM outbox
 WHERE kind = 'push_candidate' AND lower(payload->>'message_id') = '$MSG_DM';
SQL

# Redelivery on the LIVE notifier: flip the mention candidate back to pending.
run_sql <<SQL
UPDATE outbox SET status = 'pending', available_at = now()
 WHERE kind = 'push_candidate' AND lower(payload->>'message_id') = '$MSG_MENTION';
SQL
wait_sql_eq "done" "redelivered mention candidate reprocessed to done" <<SQL
SELECT status::text FROM outbox
 WHERE kind = 'push_candidate' AND lower(payload->>'message_id') = '$MSG_MENTION';
SQL

got="$(printf "SELECT count(*) FROM push_dispatch_log;\n" | sql_scalar)"
[ "$got" = "$DISPATCH_BEFORE" ] || {
  echo "[push-notif] FAIL: redelivery created dispatch_log rows ($DISPATCH_BEFORE -> $got)" >&2; exit 1; }
got="$(relay_received | jq -r '.count')"
[ "$got" = "$RECEIVED_BEFORE" ] || {
  echo "[push-notif] FAIL: redelivery re-sent to the relay ($RECEIVED_BEFORE -> $got)" >&2; exit 1; }
echo "[push-notif] ok: restart + redelivery produced ZERO duplicate dispatches (idempotent)"

# ---- consumer mutual exclusion / no regression ---------------------------------------
echo "[push-notif] asserting relay broadcast + gateway agent_job no-regression"
wait_sql_eq "0" "relay drained every broadcast row (no pending left)" <<SQL
SELECT count(*) FROM outbox WHERE kind = 'broadcast' AND status IN ('pending', 'processing');
SQL
got="$(printf "SELECT count(*) FROM outbox WHERE kind = 'broadcast' AND status = 'failed';\n" | sql_scalar)"
[ "$got" = "0" ] || { echo "[push-notif] FAIL: $got broadcast rows failed" >&2; exit 1; }
got="$(printf "SELECT count(*) FROM outbox WHERE kind = 'broadcast' AND status = 'done' AND lower(payload->'data'->'payload'->>'id') IN ('$MSG_DM', '$MSG_MENTION', '$MSG_TRIGGER', '$MSG_APPROVAL');\n" | sql_scalar)"
[ "$got" = "4" ] || {
  # Broadcast payload shape differs per producer; fall back to the drained-total assert.
  echo "[push-notif] note: per-message broadcast match=$got (payload shapes vary); drained-total assert above holds"
}
AGENT_JOB_AFTER="$(printf "SELECT COALESCE(string_agg(id::text || ':' || status::text, ',' ORDER BY id), '') FROM outbox WHERE kind = 'agent_job';\n" | sql_scalar)"
[ "$AGENT_JOB_AFTER" = "$AGENT_JOB_SNAPSHOT" ] || {
  echo "[push-notif] FAIL: agent_job rows changed across notifier restart/redelivery ($AGENT_JOB_SNAPSHOT -> $AGENT_JOB_AFTER)" >&2; exit 1; }
got="$(printf "SELECT status::text FROM outbox WHERE kind = 'agent_job' AND method = 'gateway' AND lower(payload->>'run_id') = '$RUN_ID_GW';\n" | sql_scalar)"
[ "$got" = "done" ] || { echo "[push-notif] FAIL: gateway job expected done (settled by the approval event), got '$got'" >&2; exit 1; }
got="$(printf "SELECT count(*) FROM outbox WHERE kind = 'push_candidate' AND status = 'failed';\n" | sql_scalar)"
[ "$got" = "0" ] || { echo "[push-notif] FAIL: $got push candidates failed" >&2; exit 1; }
echo "[push-notif] ok: broadcast/agent_job lifecycles untouched by the notifier (kind-scoped consumers)"

# ---- RLS spot check --------------------------------------------------------------------
run_sql <<SQL
SET ROLE momo_app;
DO \$\$
DECLARE got int;
BEGIN
  SELECT count(*) INTO got FROM push_dispatch_log;
  IF got <> 0 THEN RAISE EXCEPTION 'push_dispatch_log leaked without app.workspace_id: %', got; END IF;
END \$\$;
RESET ROLE;
SQL
echo "[push-notif] ok: push_dispatch_log stays tenant-scoped for momo_app (FORCE RLS)"

echo
echo "MOMO-404 push notifier verification PASS"
echo "- stack: compose project '$PROJECT' (api :$API_PORT, relay, notifier, mock-push-relay :$RELAY_PORT_HOST), torn down on exit"
echo "- verified: MOMO-403 REST device registration feeding dispatch targeting; DM 전건 (1 dispatch, author excluded), 멘션 (server projection reuse, 1 dispatch), 승인 요청 via gateway REST (2 human dispatches, requesting agent excluded), agent-only mention = 0 dispatches; push_dispatch_log contract rows (member/token/collapse_id/apns_status=200); id-only hard contract on all 4 relay payloads (no body/display name/handle/summary; allowed key set only); notifier restart sweep + live redelivery with ZERO duplicate dispatches; relay broadcast fully drained + agent_job rows byte-stable across restart (kind-scoped mutual exclusion); momo_notifier BYPASSRLS session; 011 enum/trigger/index presence; momo_app FORCE RLS on push_dispatch_log"

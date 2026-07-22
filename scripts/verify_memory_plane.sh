#!/usr/bin/env bash
# MOMO-526 / ADR-0129 D1-D2 isolated Memory Plane verifier.
# Docker execution belongs to the orchestrator; workers run bash/static tests only.
set -euo pipefail
umask 077

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

for tool in docker curl jq uuidgen python3; do
  command -v "$tool" >/dev/null 2>&1 || { echo "[memory-plane] missing $tool" >&2; exit 1; }
done

COMPOSE_FILE="$REPO_ROOT/infra/docker-compose.e2e.yml"
RUN_TAG="$(date -u +%s)-$$"
PROJECT="${MEMORY_GATE_PROJECT:-momo526memory-$RUN_TAG}"
API_PORT="${MEMORY_GATE_API_PORT:-28030}"
CENT_PORT="${MEMORY_GATE_CENTRIFUGO_PORT:-28031}"
PG_PORT="${MEMORY_GATE_POSTGRES_PORT:-28032}"
HERMES_PORT="${MEMORY_GATE_HERMES_PORT:-28033}"
BOOT_TIMEOUT="${MEMORY_GATE_BOOT_TIMEOUT:-2400}"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/momo-memory-plane.XXXXXX")"

compose() {
  PORT="$API_PORT" CENT_PORT="$CENT_PORT" POSTGRES_PORT="$PG_PORT" HERMES_PORT="$HERMES_PORT" \
    AGENT_PROVIDER_MODE=local-mock MEMORY_EXTRACTION_ENABLED=1 \
    MEMORY_EXTRACTION_POLL_INTERVAL_MS=100 MEMORY_EXTRACTION_BATCH_SIZE=20 \
    docker compose -p "$PROJECT" -f "$COMPOSE_FILE" "$@"
}

if [ -n "$(compose ps -aq 2>/dev/null)" ]; then
  echo "[memory-plane] compose project already exists: $PROJECT" >&2
  exit 1
fi
python3 - "$API_PORT" "$CENT_PORT" "$PG_PORT" "$HERMES_PORT" <<'PY'
import socket, sys
ports = [int(value) for value in sys.argv[1:]]
if len(ports) != len(set(ports)):
    raise SystemExit(f"[memory-plane] reserved ports must be distinct: {ports}")
sockets = []
try:
    for port in ports:
        sock = socket.socket()
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 0)
        sock.bind(("127.0.0.1", port))
        sockets.append(sock)
except OSError as error:
    raise SystemExit(f"[memory-plane] reserved port preflight failed: {error}")
finally:
    for sock in sockets:
        sock.close()
PY

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if [ "${MEMORY_GATE_KEEP:-0}" = "1" ]; then
    echo "[memory-plane] leaving $PROJECT up; evidence $TMP_DIR"
  else
    compose down -v --remove-orphans >/dev/null 2>&1 || true
    case "$TMP_DIR" in
      "${TMPDIR:-/tmp}"/momo-memory-plane.*) rm -r -- "$TMP_DIR" ;;
      *) echo "[memory-plane] refusing unexpected cleanup path: $TMP_DIR" >&2 ;;
    esac
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

BASE_URL="http://127.0.0.1:$API_PORT"
WS_ID="00000000-0000-7000-8000-000000000001"
OTHER_WS_ID="00000000-0000-7000-8000-000000005260"
CHANNEL_ID="00000000-0000-7000-8000-000000000202"
PASSWORD="memory-$(uuidgen | tr '[:upper:]' '[:lower:]')"

run_sql() {
  compose exec -T postgres psql -U "${POSTGRES_USER:-momo}" -d "${POSTGRES_DB:-momo}" \
    -v ON_ERROR_STOP=1 --no-psqlrc -q "$@"
}
sql_value() { run_sql -tA | tr -d '[:space:]'; }
run_app_sql() {
  compose exec -T -e PGPASSWORD=momo_app_dev_pw postgres \
    psql -U momo_app -d "${POSTGRES_DB:-momo}" -v ON_ERROR_STOP=1 --no-psqlrc -q "$@"
}
uuid() { uuidgen | tr '[:upper:]' '[:lower:]'; }
fail() { echo "[memory-plane] FAIL $*" >&2; exit 1; }
pass() { echo "[memory-plane] PASS $*"; }

echo "[memory-plane] booting isolated api+worker stack $PROJECT"
compose up -d api worker
deadline=$(( $(date -u +%s) + BOOT_TIMEOUT ))
until curl -fsS "$BASE_URL/health" >/dev/null 2>&1; do
  if [ "$(date -u +%s)" -ge "$deadline" ]; then
    compose logs --tail 180 api worker migrate db-roles >&2 || true
    fail "api health timeout"
  fi
  sleep 3
done

# migration 005가 dev/e2e에서 demo에 'dev-password'를 백필하므로 NULL 가정 금지 —
# 행 존재만 확인하고 게이트 전용 비밀번호로 덮어쓴다.
demo_rows="$(sql_value <<SQL
SELECT count(*) FROM human
 WHERE workspace_id='$WS_ID' AND email='demo@momo.local';
SQL
)"
[ "$demo_rows" = "1" ] || fail "unexpected demo password seed state"
run_sql <<SQL
BEGIN;
SET LOCAL row_security = off;
UPDATE human SET password_hash=momo_password_hash('$PASSWORD')
 WHERE workspace_id='$WS_ID' AND email='demo@momo.local';
INSERT INTO workspace (id,slug,name)
VALUES ('$OTHER_WS_ID','m526-other-$RUN_TAG','MOMO-526 other tenant');
INSERT INTO memory_item
  (workspace_id,scope,kind,body,confidence,created_by_kind)
VALUES ('$OTHER_WS_ID','workspace','fact','foreign tenant sentinel',1.0,'worker');
COMMIT;
SQL

LOGIN_JSON="$(curl -fsS -X POST "$BASE_URL/v1/auth/login" \
  -H 'Content-Type: application/json' \
  --data "$(jq -cn --arg e 'demo@momo.local' --arg p "$PASSWORD" --arg w "$WS_ID" \
    '{email:$e,password:$p,workspace:$w}')")"
OWNER_TOKEN="$(printf '%s' "$LOGIN_JSON" | jq -er '.accessToken')"

# External-provider consent is a distinct, default-deny workspace ledger axis.
# This verifier runs local-mock, so extraction remains allowed regardless of
# consent while the admin transition and audit contract are exercised.
CONSENT_JSON="$(curl -fsS \
  "$BASE_URL/v1/workspaces/$WS_ID/memory-external-provider-consent" \
  -H "Authorization: Bearer $OWNER_TOKEN")"
printf '%s' "$CONSENT_JSON" | jq -e \
  '.memoryExternalProviderConsent.consented == false
   and .memoryExternalProviderConsent.providerTrust == "local-mock"
   and .memoryExternalProviderConsent.extractionAllowed == true' >/dev/null \
  || fail "default external-provider consent projection is not fail-closed/local-safe"
for consented in true false; do
  CONSENT_JSON="$(curl -fsS -X PUT \
    "$BASE_URL/v1/workspaces/$WS_ID/memory-external-provider-consent" \
    -H "Authorization: Bearer $OWNER_TOKEN" -H 'Content-Type: application/json' \
    --data "{\"consented\":$consented}")"
  printf '%s' "$CONSENT_JSON" | jq -e \
    --argjson expected "$consented" \
    '.memoryExternalProviderConsent.consented == $expected
     and .memoryExternalProviderConsent.providerTrust == "local-mock"
     and .memoryExternalProviderConsent.extractionAllowed == true' >/dev/null \
    || fail "external-provider consent transition failed expected=$consented"
done
consent_audit="$(sql_value <<SQL
SELECT count(*) FROM audit_log
 WHERE workspace_id='$WS_ID'
   AND action='memory.external_provider_consent.updated';
SQL
)"
[ "$consent_audit" = "2" ] || fail "external-provider consent audit count=$consent_audit"
pass "external-provider consent default and admin transitions are independent from local extraction"

send_marker() {
  local marker="$1" client_id response
  client_id="$(uuid)"
  response="$(curl -fsS -X POST \
    "$BASE_URL/v1/workspaces/$WS_ID/channels/$CHANNEL_ID/messages" \
    -H "Authorization: Bearer $OWNER_TOKEN" -H 'Content-Type: application/json' \
    --data "$(jq -cn --arg c "$client_id" --arg b "$marker" \
      '{clientMsgId:$c,type:"text",body:$b}')")"
  printf '%s' "$response" | jq -er '.id | ascii_downcase'
}

wait_sql() {
  local label="$1" expected="$2" query="$3" value="" end
  end=$(( $(date -u +%s) + 90 ))
  while [ "$(date -u +%s)" -lt "$end" ]; do
    value="$(printf '%s\n' "$query" | sql_value)"
    if [ "$value" = "$expected" ]; then
      pass "$label"
      return 0
    fi
    sleep 1
  done
  compose logs --tail 160 worker >&2 || true
  fail "$label expected=$expected got=$value"
}

ADD_MESSAGE_ID="$(send_marker '[memory:add kind=fact confidence=0.9] Team timezone is Asia/Seoul')"
wait_sql "mock ADD candidate applied" 1 \
  "SELECT count(*) FROM memory_candidate WHERE workspace_id='$WS_ID' AND operation='ADD' AND status='applied';"
MEMORY_ID="$(sql_value <<SQL
SELECT lower(id::text) FROM memory_item
 WHERE workspace_id='$WS_ID' AND body='Team timezone is Asia/Seoul';
SQL
)"
[ -n "$MEMORY_ID" ] || fail "ADD did not create memory item"

UPDATE_MESSAGE_ID="$(send_marker "[memory:update id=$MEMORY_ID kind=fact confidence=0.8] Team timezone is UTC+09:00")"
wait_sql "mock UPDATE candidate applied" 1 \
  "SELECT count(*) FROM memory_candidate WHERE workspace_id='$WS_ID' AND operation='UPDATE' AND status='applied';"
updated="$(sql_value <<SQL
SELECT count(*) FROM memory_item
 WHERE workspace_id='$WS_ID' AND lower(id::text)=lower('$MEMORY_ID')
   AND body='Team timezone is UTC+09:00' AND confidence=0.8;
SQL
)"
[ "$updated" = "1" ] || fail "UPDATE did not mutate the target"

send_marker '[memory:noop] transient small talk' >/dev/null
wait_sql "mock NOOP candidate applied" 1 \
  "SELECT count(*) FROM memory_candidate WHERE workspace_id='$WS_ID' AND operation='NOOP' AND status='applied';"

INVALIDATE_MESSAGE_ID="$(send_marker "[memory:invalidate id=$MEMORY_ID] superseded by team policy")"
wait_sql "mock INVALIDATE candidate applied" 1 \
  "SELECT count(*) FROM memory_candidate WHERE workspace_id='$WS_ID' AND operation='INVALIDATE' AND status='applied';"
invalidated="$(sql_value <<SQL
SELECT count(*) FROM memory_item
 WHERE workspace_id='$WS_ID' AND lower(id::text)=lower('$MEMORY_ID') AND invalid_at IS NOT NULL;
SQL
)"
[ "$invalidated" = "1" ] || fail "INVALIDATE did not time-invalidate target"

# Source refs are identifiers only and preserve every mutating source backlink.
source_integrity="$(sql_value <<SQL
SELECT count(*) FROM memory_source_ref sr
JOIN memory_item mi ON mi.workspace_id=sr.workspace_id AND mi.id=sr.memory_id
JOIN message m ON m.workspace_id=sr.workspace_id AND m.id=sr.message_id
              AND m.channel_id=sr.channel_id
WHERE sr.workspace_id='$WS_ID' AND lower(sr.memory_id::text)=lower('$MEMORY_ID')
  AND lower(sr.message_id::text) IN
      (lower('$ADD_MESSAGE_ID'),lower('$UPDATE_MESSAGE_ID'),lower('$INVALIDATE_MESSAGE_ID'));
SQL
)"
[ "$source_integrity" = "3" ] || fail "source_ref identifier integrity count=$source_integrity"
raw_columns="$(sql_value <<SQL
SELECT count(*) FROM information_schema.columns
 WHERE table_schema='public' AND table_name='memory_source_ref'
   AND column_name IN ('body','content','excerpt','raw');
SQL
)"
[ "$raw_columns" = "0" ] || fail "source_ref contains forbidden raw-content column"
pass "source refs are identifier-only and FK-consistent"

candidate_matrix="$(sql_value <<SQL
SELECT count(*) FROM (
  SELECT operation FROM memory_candidate WHERE workspace_id='$WS_ID'
  GROUP BY operation HAVING count(*)=1
) branches;
SQL
)"
[ "$candidate_matrix" = "4" ] || fail "candidate four-branch matrix count=$candidate_matrix"
lifecycle_ok="$(sql_value <<SQL
SELECT count(DISTINCT action) FROM memory_lifecycle_event
 WHERE workspace_id='$WS_ID'
   AND action IN ('created','updated','invalidated','noop','candidate_created','candidate_applied');
SQL
)"
[ "$lifecycle_ok" = "6" ] || fail "lifecycle evidence missing count=$lifecycle_ok"
audit_ok="$(sql_value <<SQL
SELECT count(DISTINCT action) FROM audit_log
 WHERE workspace_id='$WS_ID' AND action IN ('memory.created','memory.updated','memory.invalidated');
SQL
)"
[ "$audit_ok" = "3" ] || fail "audit evidence missing count=$audit_ok"
outbox_ok="$(sql_value <<SQL
SELECT count(*) FROM outbox
 WHERE workspace_id='$WS_ID' AND payload->'data'->>'type'='memory.updated'
   AND lower(payload->'data'->'payload'->>'memory_id')=lower('$MEMORY_ID')
   AND NOT (payload::text ILIKE '%Team timezone%' OR payload::text ILIKE '%password%'
            OR payload::text ILIKE '%api_key%' OR payload::text ILIKE '%token%');
SQL
)"
[ "$outbox_ok" = "3" ] || fail "transactional memory.updated outbox count=$outbox_ok"
pass "candidate, lifecycle, audit, and closed outbox evidence"

# Ordinary app role sees no foreign tenant rows and cannot insert one while its
# transaction is scoped to the demo workspace. This checks FORCE RLS itself.
visible_foreign="$(run_app_sql -tA <<SQL | tr -d '[:space:]'
BEGIN;
SET LOCAL app.workspace_id='$WS_ID';
SELECT count(*) FROM memory_item WHERE workspace_id='$OTHER_WS_ID';
ROLLBACK;
SQL
)"
[ "$visible_foreign" = "0" ] || fail "RLS leaked foreign memory rows"
if run_app_sql >/dev/null 2>"$TMP_DIR/rls-denial.log" <<SQL
BEGIN;
SET LOCAL app.workspace_id='$WS_ID';
INSERT INTO memory_item
  (workspace_id,scope,kind,body,confidence,created_by_kind)
VALUES ('$OTHER_WS_ID','workspace','fact','forbidden cross tenant write',1.0,'worker');
COMMIT;
SQL
then
  fail "RLS allowed a foreign-workspace insert"
fi
pass "FORCE RLS hides and rejects cross-workspace access"

POLICY_JSON="$(curl -fsS -X PUT "$BASE_URL/v1/workspaces/$WS_ID/memory-policy" \
  -H "Authorization: Bearer $OWNER_TOKEN" -H 'Content-Type: application/json' \
  --data '{"enabled":false}')"
printf '%s' "$POLICY_JSON" | jq -e '.memoryPolicy.enabled == false and .deletedCount == 1' >/dev/null \
  || fail "policy off response did not report one deleted item"
purge_ok="$(sql_value <<SQL
SELECT (SELECT count(*) FROM memory_item WHERE workspace_id='$WS_ID')
     + (SELECT count(*) FROM memory_candidate WHERE workspace_id='$WS_ID')
     + (SELECT count(*) FROM memory_source_ref WHERE workspace_id='$WS_ID');
SQL
)"
[ "$purge_ok" = "0" ] || fail "policy off did not purge projections count=$purge_ok"
delete_evidence="$(sql_value <<SQL
SELECT count(*) FROM memory_lifecycle_event
 WHERE workspace_id='$WS_ID' AND action='deleted'
   AND memory_id IS NULL AND lower(detail->>'memory_id')=lower('$MEMORY_ID');
SQL
)"
[ "$delete_evidence" = "1" ] || fail "policy purge lifecycle evidence missing"
policy_audit="$(sql_value <<SQL
SELECT count(*) FROM audit_log
 WHERE workspace_id='$WS_ID' AND action='memory.policy.updated'
   AND detail->>'enabled'='false' AND (detail->>'deleted_count')::int=1;
SQL
)"
[ "$policy_audit" = "1" ] || fail "policy audit evidence missing"
pass "admin policy off atomically purges projections and preserves audit/lifecycle"

cursor_seq="$(sql_value <<SQL
SELECT last_extracted_seq FROM memory_extraction_cursor
 WHERE workspace_id='$WS_ID' AND channel_id='$CHANNEL_ID';
SQL
)"
channel_seq="$(sql_value <<SQL
SELECT last_seq FROM channel_seq WHERE workspace_id='$WS_ID' AND channel_id='$CHANNEL_ID';
SQL
)"
[ "$cursor_seq" = "$channel_seq" ] || fail "watermark did not reach channel seq ($cursor_seq/$channel_seq)"
pass "channel watermark advanced only after all four batches"

echo "[memory-plane] PASS MOMO-526 Memory Plane runtime verifier"

#!/usr/bin/env bash
# MOMO-667 / ADR-0140 D1-D3+D5 — canonical T3 lifecycle concurrency harness.
set -euo pipefail
umask 077

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

log() { echo "[t3-concurrency] $*"; }
pass() { echo "[t3-concurrency] PASS $*"; }
fail() { echo "[t3-concurrency] FAIL $*" >&2; exit 1; }

LOCK_MIGRATION="server/Migrations/052_t3_lifecycle_advisory_lock.sql"
CANONICAL_MIGRATION="server/Migrations/053_t3_lifecycle_canonicalization.sql"
test -f "$LOCK_MIGRATION" || fail "missing $LOCK_MIGRATION"
test -f "$CANONICAL_MIGRATION" || fail "missing $CANONICAL_MIGRATION"
grep -q "hashtext('momo.t3')" "$LOCK_MIGRATION" \
  || fail "named gate advisory namespace missing"
grep -q "hashtext(lower(p_cloud_host_id::text))" "$LOCK_MIGRATION" \
  || fail "named gate lowercase cloud-host key missing"
grep -q "CREATE FUNCTION t3_terminate" "$CANONICAL_MIGRATION" \
  || fail "named gate t3_terminate missing"
grep -q "t3 settlement must go through t3_terminate" "$CANONICAL_MIGRATION" \
  || fail "named gate settlement seal missing"
grep -q "illegal cloud host transition % -> %" "$CANONICAL_MIGRATION" \
  || fail "named gate cloud-host transition guard missing"
grep -q "work_cloud_host_transition" "$CANONICAL_MIGRATION" \
  || fail "named gate cloud-host transition table missing"
grep -q "withTenantT3LifecycleTransaction" \
  server/Sources/MomoServer/DB/Database.swift \
  || fail "named gate server T3 transaction wrapper missing"
grep -q "orderedHostIDs" server/Sources/MomoServer/DB/Database.swift \
  || fail "named gate multi-host ordering missing"
grep -q "T3LifecycleLock.acquirePrelude" \
  server/Sources/MomoServer/DB/Database.swift \
  || fail "named gate canonical server prelude missing"
if grep -q "T3LifecycleLock" \
  server/Sources/MomoServer/Routes/WorkHostRoutes.swift; then
  fail "named gate heartbeat must stay outside T3 advisory serialization"
fi
grep -q "T3LifecycleLock.acquirePrelude" \
  workers/NotifierWorker/Sources/NotifierWorker/CloudLifecycleReconciler.swift \
  || fail "named gate reconciler prelude wiring missing"
grep -q "T3LifecycleLock.acquirePrelude" \
  workers/NotifierWorker/Sources/NotifierWorker/TierFallbackSweep.swift \
  || fail "named gate sweep prelude wiring missing"
if grep -R -n "settle_t3_work_session" \
  server/Sources workers/NotifierWorker/Sources >/dev/null; then
  fail "named gate runtime caller still bypasses t3_terminate"
fi
grep -q "reason: \\.orphaned" \
  server/Sources/MomoServer/Routes/WorkSessionRoutes.swift \
  || fail "named gate lineage resume does not idempotently terminate source T3 usage"
test "$(grep -c "withTenantLifecycleTransactionUnwrapped(" \
  server/Sources/MomoServer/Routes/WorkSessionRoutes.swift)" -ge 6 \
  || fail "named gate REST lifecycle advisory wiring missing"
test "$(grep -c "withTenantLifecycleTransactionUnwrapped(" \
  server/Sources/MomoServer/Routes/CloudProvisionerRoutes.swift)" -ge 5 \
  || fail "named gate cloud lifecycle advisory wiring missing"
grep -q "tier fallback session failed" \
  workers/NotifierWorker/Sources/NotifierWorker/TierFallbackSweep.swift \
  || fail "named gate per-session sweep failure isolation missing"

server_prelude="server/Sources/MomoServer/Cloud/T3LifecycleLock.swift"
advisory_line="$(grep -n "acquire_t3_lifecycle_lock" "$server_prelude" | head -1 | cut -d: -f1)"
tenant_line="$(grep -n "set_config('app.workspace_id'" "$server_prelude" | head -1 | cut -d: -f1)"
credit_line="$(grep -n "FROM workspace_credit" "$server_prelude" | head -1 | cut -d: -f1)"
cloud_line="$(grep -n "FROM work_cloud_host" "$server_prelude" | head -1 | cut -d: -f1)"
test -n "$advisory_line" && test -n "$tenant_line" \
  && test -n "$credit_line" && test -n "$cloud_line" \
  && test "$advisory_line" -lt "$tenant_line" \
  && test "$tenant_line" -lt "$credit_line" \
  && test "$credit_line" -lt "$cloud_line" \
  || fail "named gate canonical server prelude order is not advisory -> tenant -> credit -> cloud"
bash -n "$0"

if [ "${T3_CONCURRENCY_RUN_DOCKER:-1}" != "1" ]; then
  pass "static advisory, canonicalization, sweep-isolation, and harness checks"
  exit 0
fi

command -v docker >/dev/null 2>&1 || fail "missing docker"

COMPOSE_FILE="$REPO_ROOT/infra/docker-compose.e2e.yml"
SAFE_ENV_FILE="$REPO_ROOT/infra/.env.example"
PROJECT="${T3_CONCURRENCY_PROJECT:-momo891t3canonical}"
PG_PORT="${T3_CONCURRENCY_POSTGRES_PORT:-28491}"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/momo-t3-concurrency.XXXXXX")"
PROVE_RED="${T3_CONCURRENCY_PROVE_RED:-0}"

compose() {
  POSTGRES_PORT="$PG_PORT" docker compose --env-file "$SAFE_ENV_FILE" \
    -p "$PROJECT" -f "$COMPOSE_FILE" "$@"
}

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if [ "${T3_CONCURRENCY_KEEP:-0}" = "1" ]; then
    log "leaving compose project '$PROJECT' up; evidence $TMP_DIR"
  else
    compose down -v --remove-orphans >/dev/null 2>&1 || true
    case "$TMP_DIR" in
      "${TMPDIR:-/tmp}"/momo-t3-concurrency.*) rm -r -- "$TMP_DIR" ;;
      *) echo "[t3-concurrency] refusing unexpected cleanup path: $TMP_DIR" >&2 ;;
    esac
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

run_sql() {
  compose exec -T postgres psql -U "${POSTGRES_USER:-momo}" \
    -d "${POSTGRES_DB:-momo}" -v ON_ERROR_STOP=1 --no-psqlrc -q "$@"
}
sql_value() { run_sql -tA | tr -d '[:space:]'; }

run_connection() {
  local application_name=$1
  PGAPPNAME="$application_name" PGOPTIONS="-c deadlock_timeout=200ms" \
    compose exec -T \
      -e PGAPPNAME="$application_name" \
      -e PGOPTIONS="-c deadlock_timeout=200ms" \
      postgres psql -U "${POSTGRES_USER:-momo}" \
        -d "${POSTGRES_DB:-momo}" -v ON_ERROR_STOP=1 --no-psqlrc -q
}

wait_for_sql() {
  local description=$1
  local expected=$2
  local query=$3
  local deadline=$(( $(date -u +%s) + 12 ))
  local actual
  while [ "$(date -u +%s)" -lt "$deadline" ]; do
    actual="$(printf '%s\n' "$query" | sql_value)"
    [ "$actual" = "$expected" ] && return 0
    sleep 0.1
  done
  fail "$description (expected=$expected actual=${actual:-<empty>})"
}

WS_ID="00000000-0000-7000-8000-000000000001"
CHANNEL_ID="00000000-0000-7000-8000-000000000201"
MEMBER_ID="00000000-0000-7000-8000-000000000101"
PUBLIC_KEY="11qYAYLef0dU8/7tqW5Wc4MJio5SdxwIe3nHLzG2N9c="
REST_CLOUD_ID="89100000-0000-7000-8000-000000000001"
REST_HOST_ID="89100000-0000-7000-8000-000000000011"
REST_SESSION_ID="89100000-0000-7000-8000-000000000021"
REST_ROOT_ID="89100000-0000-7000-8000-000000000031"
SWEEP_CLOUD_ID="89100000-0000-7000-8000-000000000002"
SWEEP_HOST_ID="89100000-0000-7000-8000-000000000012"
SWEEP_SESSION_ID="89100000-0000-7000-8000-000000000022"
SWEEP_ROOT_ID="89100000-0000-7000-8000-000000000032"
TRANSITION_CLOUD_ID="89100000-0000-7000-8000-000000000003"
TRANSITION_HOST_ID="89100000-0000-7000-8000-000000000013"

log "booting isolated PostgreSQL 18 and applying migrations"
compose up -d postgres
compose run --rm migrate >/dev/null

run_sql <<SQL
BEGIN;
SET LOCAL row_security = off;
WITH bumped AS (
  UPDATE channel_seq
     SET last_seq = last_seq + 2
   WHERE channel_id = '$CHANNEL_ID'
  RETURNING last_seq
)
INSERT INTO message
  (id, workspace_id, channel_id, seq, hlc_ts, hlc_count,
   author_member_id, type, props)
SELECT '$REST_ROOT_ID'::uuid, '$WS_ID'::uuid, '$CHANNEL_ID'::uuid, last_seq - 1,
       891001, 0, '$MEMBER_ID'::uuid, 'system'::message_type,
       '{"kind":"work_session","status":"running"}'::jsonb
  FROM bumped
UNION ALL
SELECT '$SWEEP_ROOT_ID'::uuid, '$WS_ID'::uuid, '$CHANNEL_ID'::uuid, last_seq,
       891002, 0, '$MEMBER_ID'::uuid, 'system'::message_type,
       '{"kind":"work_session","status":"running"}'::jsonb
  FROM bumped;
INSERT INTO work_host
  (id, workspace_id, scope, owner_member_id, type, display_name,
   public_key, capabilities, last_seen_at)
VALUES
  ('$REST_HOST_ID', '$WS_ID', 'workspace', '$MEMBER_ID', 'cloud',
   'MOMO-667 REST host', '$PUBLIC_KEY', '{}', clock_timestamp() - interval '1 day'),
  ('$SWEEP_HOST_ID', '$WS_ID', 'workspace', '$MEMBER_ID', 'cloud',
   'MOMO-667 sweep host', '$PUBLIC_KEY', '{}', clock_timestamp() - interval '1 day'),
  ('$TRANSITION_HOST_ID', '$WS_ID', 'workspace', '$MEMBER_ID', 'cloud',
   'MOMO-667 transition host', '$PUBLIC_KEY', '{}', clock_timestamp());
INSERT INTO work_session
  (id, workspace_id, channel_id, member_id, host_id, root_message_id,
   tool, label, status)
VALUES
  ('$REST_SESSION_ID', '$WS_ID', '$CHANNEL_ID', '$MEMBER_ID',
   '$REST_HOST_ID', '$REST_ROOT_ID', 'codex', 'MOMO-667 REST', 'running'),
  ('$SWEEP_SESSION_ID', '$WS_ID', '$CHANNEL_ID', '$MEMBER_ID',
   '$SWEEP_HOST_ID', '$SWEEP_ROOT_ID', 'codex', 'MOMO-667 sweep', 'running');
INSERT INTO work_cloud_host
  (id, workspace_id, requester_member_id, host_id, provider_sandbox_id,
   state, bootstrap_token_digest, bootstrap_expires_at, bootstrap_consumed_at,
   unit_rate_micro_usd_second)
VALUES
  ('$REST_CLOUD_ID', '$WS_ID', '$MEMBER_ID', '$REST_HOST_ID', 'momo891-rest',
   'running', repeat('1', 64), clock_timestamp() + interval '1 hour',
   clock_timestamp(), 1),
  ('$SWEEP_CLOUD_ID', '$WS_ID', '$MEMBER_ID', '$SWEEP_HOST_ID', 'momo891-sweep',
   'running', repeat('2', 64), clock_timestamp() + interval '1 hour',
   clock_timestamp(), 1),
  ('$TRANSITION_CLOUD_ID', '$WS_ID', '$MEMBER_ID', '$TRANSITION_HOST_ID',
   'momo891-transition', 'ready', repeat('3', 64),
   clock_timestamp() + interval '1 hour', clock_timestamp(), 1);
INSERT INTO workspace_credit (workspace_id, balance_micro_usd, updated_at)
VALUES ('$WS_ID', 100000, clock_timestamp())
ON CONFLICT (workspace_id) DO UPDATE
  SET balance_micro_usd = 100000, updated_at = clock_timestamp();
INSERT INTO work_host_usage
  (session_id, host_id, workspace_id, started_at,
   unit_rate_micro_usd_second)
VALUES
  ('$REST_SESSION_ID', '$REST_HOST_ID', '$WS_ID',
   clock_timestamp() - interval '10 seconds', 1),
  ('$SWEEP_SESSION_ID', '$SWEEP_HOST_ID', '$WS_ID',
   clock_timestamp() - interval '10 seconds', 1);
INSERT INTO work_host_usage_interval
  (usage_id, workspace_id, state, started_at)
SELECT id, workspace_id, 'active'::text,
       clock_timestamp() - interval '10 seconds'
  FROM work_host_usage
 WHERE session_id IN ('$REST_SESSION_ID'::uuid, '$SWEEP_SESSION_ID'::uuid);
COMMIT;
SQL

write_reconciler_sql() {
  local output=$1
  local cloud_id=$2
  local host_id=$3
  local sleep_seconds=$4
  local session_id=$5
  {
    printf '%s\n' '\set VERBOSITY verbose'
    printf '%s\n' 'BEGIN;'
    printf "SELECT acquire_t3_lifecycle_lock('%s');\n" "$cloud_id"
    printf "SELECT workspace_id FROM workspace_credit WHERE workspace_id='%s' FOR UPDATE;\n" "$WS_ID"
    printf "SELECT id FROM work_cloud_host WHERE id='%s' FOR UPDATE;\n" "$cloud_id"
    printf "SELECT pg_sleep(%s);\n" "$sleep_seconds"
    printf "SELECT session_id FROM work_host_usage WHERE host_id='%s' AND session_id='%s' FOR UPDATE;\n" \
      "$host_id" "$session_id"
    printf "SELECT id FROM work_session WHERE id='%s' FOR UPDATE;\n" "$session_id"
    printf '%s\n' 'ROLLBACK;'
  } >"$output"
}

write_terminal_sql() {
  local output=$1
  local cloud_id=$2
  local session_id=$3
  local kind=$4
  local reason
  if [ "$kind" = "rest" ]; then reason="ended"; else reason="orphaned"; fi
  {
    printf '%s\n' '\set VERBOSITY verbose'
    printf '%s\n' 'BEGIN;'
    printf "SELECT acquire_t3_lifecycle_lock('%s');\n" "$cloud_id"
    printf "SELECT workspace_id FROM workspace_credit WHERE workspace_id='%s' FOR UPDATE;\n" "$WS_ID"
    printf "SELECT id FROM work_cloud_host WHERE id='%s' FOR UPDATE;\n" "$cloud_id"
    printf "SELECT t3_terminate('%s','%s','%s');\n" "$WS_ID" "$session_id" "$reason"
    if [ "$kind" = "rest" ]; then
      printf '%s\n' \
        "UPDATE work_session" \
        "   SET status='ended', idle_at=NULL, ended_at=clock_timestamp()," \
        "       end_reason=NULL" \
        " WHERE id='$session_id' AND status IN ('running','idle');"
    else
      printf '%s\n' \
        "UPDATE work_session" \
        "   SET status='orphaned', idle_at=NULL" \
        " WHERE id='$session_id' AND status IN ('running','idle');"
    fi
    printf '%s\n' 'ROLLBACK;'
  } >"$output"
}

assert_serialized_overlap() {
  local scenario=$1
  local cloud_id=$2
  local app_a=$3
  local app_b=$4
  local lock_count relation_count waiter_count
  lock_count="
    SELECT count(*)
      FROM pg_locks l
      JOIN pg_stat_activity a ON a.pid=l.pid
     WHERE a.application_name IN ('$app_a','$app_b')
       AND l.locktype='advisory'
       AND l.classid::bigint =
             (hashtext('momo.t3')::bigint & 4294967295)
       AND l.objid::bigint =
             (hashtext(lower('$cloud_id'::uuid::text))::bigint & 4294967295)
       AND (
         (a.application_name='$app_a' AND l.granted)
         OR (a.application_name='$app_b' AND NOT l.granted)
       );"
  relation_count="
    SELECT count(*)
      FROM pg_locks l
      JOIN pg_stat_activity a ON a.pid=l.pid
      JOIN pg_class c ON c.oid=l.relation
     WHERE a.application_name='$app_a'
       AND c.relname='work_cloud_host'
       AND l.mode='RowShareLock'
       AND l.granted;"
  waiter_count="
    SELECT count(*)
      FROM pg_stat_activity
     WHERE application_name='$app_b'
       AND state='active'
       AND wait_event_type='Lock'
       AND lower(wait_event)='advisory'
       AND query LIKE '%acquire_t3_lifecycle_lock%';"
  wait_for_sql "$scenario granted+waiting advisory overlap" 2 "$lock_count"
  wait_for_sql "$scenario reconciler cloud-host row lock held" 1 "$relation_count"
  wait_for_sql "$scenario terminal path waiting at first lock" 1 "$waiter_count"
  pass "$scenario pg_locks/pg_stat_activity prove real simultaneous serialization"
}

run_normal_scenario() {
  local scenario=$1
  local kind=$2
  local cloud_id=$3
  local host_id=$4
  local session_id=$5
  local app_a="momo891_${kind}_reconciler"
  local app_b="momo891_${kind}_terminal"
  local sql_a="$TMP_DIR/${kind}-a.sql"
  local sql_b="$TMP_DIR/${kind}-b.sql"
  local log_a="$TMP_DIR/${kind}-a.log"
  local log_b="$TMP_DIR/${kind}-b.log"

  write_reconciler_sql "$sql_a" "$cloud_id" "$host_id" 4 "$session_id"
  write_terminal_sql "$sql_b" "$cloud_id" "$session_id" "$kind"
  run_connection "$app_a" <"$sql_a" >"$log_a" 2>&1 &
  local pid_a=$!
  wait_for_sql "$scenario reconciler pause reached" 1 \
    "SELECT count(*) FROM pg_stat_activity
      WHERE application_name='$app_a' AND wait_event='PgSleep';"
  run_connection "$app_b" <"$sql_b" >"$log_b" 2>&1 &
  local pid_b=$!
  assert_serialized_overlap "$scenario" "$cloud_id" "$app_a" "$app_b"
  wait "$pid_a" || fail "$scenario reconciler connection failed: $(tr '\n' ' ' <"$log_a")"
  wait "$pid_b" || fail "$scenario terminal connection failed: $(tr '\n' ' ' <"$log_b")"
  if grep -q "deadlock detected" "$log_a" "$log_b"; then
    fail "$scenario unexpectedly deadlocked"
  fi
  pass "$scenario completed without deadlock"
}

assert_settlement_seal() {
  local output="$TMP_DIR/settlement-seal.log"
  set +e
  run_sql >"$output" 2>&1 <<SQL
BEGIN;
UPDATE work_host_usage
   SET ended_at=clock_timestamp(), active_seconds=0,
       settled_at=clock_timestamp()
 WHERE session_id='$SWEEP_SESSION_ID';
ROLLBACK;
SQL
  local rc=$?
  set -e
  [ "$rc" -ne 0 ] || fail "direct settled_at UPDATE unexpectedly passed"
  grep -q "t3 settlement must go through t3_terminate" "$output" \
    || fail "direct settlement failed without the named t3_terminate exception"
  pass "settled_at direct UPDATE rejected by named t3_terminate seal"
}

assert_transition_guard() {
  local output="$TMP_DIR/transition-guard.log"
  set +e
  run_sql >"$output" 2>&1 <<SQL
BEGIN;
UPDATE work_cloud_host
   SET state='destroyed'
 WHERE id='$TRANSITION_CLOUD_ID';
ROLLBACK;
SQL
  local rc=$?
  set -e
  [ "$rc" -ne 0 ] || fail "ready -> destroyed transition unexpectedly passed"
  grep -q "illegal cloud host transition ready -> destroyed" "$output" \
    || fail "illegal transition failed without the named transition exception"
  pass "unseeded ready -> destroyed transition rejected by named exception"
}

run_workspace_axis_scenario() {
  local app_a="momo891_workspace_provision"
  local app_b="momo891_workspace_settle"
  local sql_a="$TMP_DIR/workspace-a.sql"
  local sql_b="$TMP_DIR/workspace-b.sql"
  local log_a="$TMP_DIR/workspace-a.log"
  local log_b="$TMP_DIR/workspace-b.log"

  {
    printf '%s\n' 'BEGIN;'
    printf "SELECT acquire_t3_lifecycle_lock('%s');\n" "$TRANSITION_CLOUD_ID"
    printf "SELECT workspace_id FROM work_pool WHERE workspace_id='%s' FOR UPDATE;\n" "$WS_ID"
    printf "SELECT workspace_id FROM workspace_credit WHERE workspace_id='%s' FOR UPDATE;\n" "$WS_ID"
    printf '%s\n' 'SELECT pg_sleep(4);' 'ROLLBACK;'
  } >"$sql_a"
  {
    printf '%s\n' 'BEGIN;'
    printf "SELECT acquire_t3_lifecycle_lock('%s');\n" "$SWEEP_CLOUD_ID"
    printf "SELECT workspace_id FROM workspace_credit WHERE workspace_id='%s' FOR UPDATE;\n" "$WS_ID"
    printf "SELECT id FROM work_cloud_host WHERE id='%s' FOR UPDATE;\n" "$SWEEP_CLOUD_ID"
    printf "SELECT t3_terminate('%s','%s','orphaned');\n" "$WS_ID" "$SWEEP_SESSION_ID"
    printf '%s\n' 'ROLLBACK;'
  } >"$sql_b"

  run_connection "$app_a" <"$sql_a" >"$log_a" 2>&1 &
  local pid_a=$!
  wait_for_sql "workspace provision reservation pause reached" 1 \
    "SELECT count(*) FROM pg_stat_activity
      WHERE application_name='$app_a' AND wait_event='PgSleep';"
  run_connection "$app_b" <"$sql_b" >"$log_b" 2>&1 &
  local pid_b=$!
  wait_for_sql "workspace axis uses two independently granted host advisories" t \
    "SELECT count(*) >= 2
       FROM pg_locks l
       JOIN pg_stat_activity a ON a.pid=l.pid
      WHERE a.application_name IN ('$app_a','$app_b')
        AND l.locktype='advisory'
        AND l.granted;"
  wait_for_sql "workspace axis settlement waits on shared credit row" 1 \
    "SELECT count(*) FROM pg_stat_activity
      WHERE application_name='$app_b'
        AND state='active'
        AND wait_event_type='Lock'
        AND query LIKE '%workspace_credit%';"
  wait_for_sql "workspace axis credit relation locks overlap" t \
    "SELECT count(*) >= 2
       FROM pg_locks l
       JOIN pg_stat_activity a ON a.pid=l.pid
       JOIN pg_class c ON c.oid=l.relation
      WHERE a.application_name IN ('$app_a','$app_b')
        AND c.relname='workspace_credit'
        AND l.mode='RowShareLock'
        AND l.granted;"
  pass "workspace axis pg_locks prove provisioning and settlement overlap beyond host advisory"
  wait "$pid_a" || fail "workspace provision connection failed: $(tr '\n' ' ' <"$log_a")"
  wait "$pid_b" || fail "workspace settlement connection failed: $(tr '\n' ' ' <"$log_b")"
  if grep -q "deadlock detected" "$log_a" "$log_b"; then
    fail "workspace axis unexpectedly deadlocked"
  fi
  pass "workspace axis completed in work_pool -> workspace_credit -> cloud order"
}

run_idempotence_scenario() {
  local app_a="momo891_idempotence_a"
  local app_b="momo891_idempotence_b"
  local sql_a="$TMP_DIR/idempotence-a.sql"
  local sql_b="$TMP_DIR/idempotence-b.sql"
  local log_a="$TMP_DIR/idempotence-a.log"
  local log_b="$TMP_DIR/idempotence-b.log"

  {
    printf '%s\n' 'BEGIN;'
    printf "SELECT acquire_t3_lifecycle_lock('%s');\n" "$REST_CLOUD_ID"
    printf "SELECT workspace_id FROM workspace_credit WHERE workspace_id='%s' FOR UPDATE;\n" "$WS_ID"
    printf "SELECT id FROM work_cloud_host WHERE id='%s' FOR UPDATE;\n" "$REST_CLOUD_ID"
    printf '%s\n' 'SELECT pg_sleep(4);'
    printf "SELECT t3_terminate('%s','%s','ended');\n" "$WS_ID" "$REST_SESSION_ID"
    printf '%s\n' 'COMMIT;'
  } >"$sql_a"
  {
    printf '%s\n' 'BEGIN;'
    printf "SELECT acquire_t3_lifecycle_lock('%s');\n" "$REST_CLOUD_ID"
    printf "SELECT workspace_id FROM workspace_credit WHERE workspace_id='%s' FOR UPDATE;\n" "$WS_ID"
    printf "SELECT id FROM work_cloud_host WHERE id='%s' FOR UPDATE;\n" "$REST_CLOUD_ID"
    printf "SELECT t3_terminate('%s','%s','ended');\n" "$WS_ID" "$REST_SESSION_ID"
    printf '%s\n' 'COMMIT;'
  } >"$sql_b"

  run_connection "$app_a" <"$sql_a" >"$log_a" 2>&1 &
  local pid_a=$!
  wait_for_sql "idempotence first termination pause reached" 1 \
    "SELECT count(*) FROM pg_stat_activity
      WHERE application_name='$app_a' AND wait_event='PgSleep';"
  run_connection "$app_b" <"$sql_b" >"$log_b" 2>&1 &
  local pid_b=$!
  assert_serialized_overlap \
    "concurrent t3_terminate idempotence" "$REST_CLOUD_ID" "$app_a" "$app_b"
  wait "$pid_a" || fail "first t3_terminate failed: $(tr '\n' ' ' <"$log_a")"
  wait "$pid_b" || fail "second t3_terminate failed: $(tr '\n' ' ' <"$log_b")"

  [ "$(run_sql -tA -c "
    SELECT
      (SELECT count(*) FROM credit_entry
        WHERE reason='t3_usage' AND ref_id='$REST_SESSION_ID'::uuid)
      || ':' ||
      (SELECT settled_reason FROM work_host_usage
        WHERE session_id='$REST_SESSION_ID'::uuid);
  " | tr -d '[:space:]')" = "1:ended" ] \
    || fail "concurrent t3_terminate did not preserve one debit and first reason"

  run_sql <<SQL
BEGIN;
SELECT acquire_t3_lifecycle_lock('$REST_CLOUD_ID');
SELECT workspace_id FROM workspace_credit WHERE workspace_id='$WS_ID' FOR UPDATE;
SELECT id FROM work_cloud_host WHERE id='$REST_CLOUD_ID' FOR UPDATE;
SELECT t3_terminate('$WS_ID', '$REST_SESSION_ID', 'destroyed');
COMMIT;
SQL
  [ "$(run_sql -tA -c "
    SELECT
      (SELECT count(*) FROM credit_entry
        WHERE reason='t3_usage' AND ref_id='$REST_SESSION_ID'::uuid)
      || ':' ||
      (SELECT settled_reason FROM work_host_usage
        WHERE session_id='$REST_SESSION_ID'::uuid);
  " | tr -d '[:space:]')" = "1:ended" ] \
    || fail "sequential different-reason retry overwrote settlement evidence"
  pass "concurrent + sequential t3_terminate keep one debit and first reason"
}

run_lock_order_red_proof() {
  local app_a="momo891_red_reconciler"
  local app_b="momo891_red_reversed"
  local sql_a="$TMP_DIR/red-lock-a.sql"
  local sql_b="$TMP_DIR/red-lock-b.sql"
  local log_a="$TMP_DIR/red-lock-a.log"
  local log_b="$TMP_DIR/red-lock-b.log"

  write_reconciler_sql \
    "$sql_a" "$REST_CLOUD_ID" "$REST_HOST_ID" 5 "$REST_SESSION_ID"
  {
    printf '%s\n' '\set VERBOSITY verbose' 'BEGIN;'
    printf "UPDATE work_session SET status='ended' WHERE id='%s';\n" "$REST_SESSION_ID"
    printf "SELECT t3_terminate('%s','%s','ended');\n" "$WS_ID" "$REST_SESSION_ID"
    printf '%s\n' 'ROLLBACK;'
  } >"$sql_b"

  run_connection "$app_a" <"$sql_a" >"$log_a" 2>&1 &
  local pid_a=$!
  wait_for_sql "red reconciler canonical prelude reached" 1 \
    "SELECT count(*) FROM pg_stat_activity
      WHERE application_name='$app_a' AND wait_event='PgSleep';"
  run_connection "$app_b" <"$sql_b" >"$log_b" 2>&1 &
  local pid_b=$!
  wait_for_sql "red reversed path holds session and waits on prelude" 1 \
    "SELECT count(*) FROM pg_stat_activity
      WHERE application_name='$app_b'
        AND state='active'
        AND wait_event_type='Lock'
        AND query LIKE '%t3_terminate%';"

  set +e
  wait "$pid_a"
  local rc_a=$?
  wait "$pid_b"
  local rc_b=$?
  set -e
  if ! grep -q "40P01" "$log_a" "$log_b" \
    || ! grep -q "deadlock detected" "$log_a" "$log_b"; then
    fail "red lock-order proof did not produce named SQLSTATE 40P01 (a=$rc_a b=$rc_b)"
  fi
  fail "named red proof: reversed session-first path produced deadlock detected (SQLSTATE 40P01)"
}

run_settlement_seal_red_proof() {
  run_sql -c "DROP TRIGGER work_host_usage_settlement_guard ON work_host_usage"
  local output="$TMP_DIR/red-settlement-seal.log"
  set +e
  run_sql >"$output" 2>&1 <<SQL
BEGIN;
UPDATE work_host_usage
   SET ended_at=clock_timestamp(), active_seconds=0,
       settled_at=clock_timestamp()
 WHERE session_id='$SWEEP_SESSION_ID';
ROLLBACK;
SQL
  local rc=$?
  set -e
  [ "$rc" -eq 0 ] \
    || fail "red settlement-seal setup did not allow the direct UPDATE"
  fail "named red proof: settlement trigger removal allowed direct settled_at UPDATE"
}

case "$PROVE_RED" in
  0) ;;
  1|lock-order) run_lock_order_red_proof ;;
  settlement-seal) run_settlement_seal_red_proof ;;
  *) fail "T3_CONCURRENCY_PROVE_RED must be 0, lock-order, or settlement-seal" ;;
esac

assert_settlement_seal
assert_transition_guard
run_normal_scenario \
  "reconciler x REST end" rest \
  "$REST_CLOUD_ID" "$REST_HOST_ID" "$REST_SESSION_ID"
run_normal_scenario \
  "reconciler x sweep" sweep \
  "$SWEEP_CLOUD_ID" "$SWEEP_HOST_ID" "$SWEEP_SESSION_ID"
run_workspace_axis_scenario
run_idempotence_scenario
pass "MOMO-667 T3 canonical lifecycle concurrency harness"

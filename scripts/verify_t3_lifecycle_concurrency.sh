#!/usr/bin/env bash
# MOMO-666 / ADR-0140 D2+D5 — T3 lifecycle advisory concurrency harness.
set -euo pipefail
umask 077

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

log() { echo "[t3-concurrency] $*"; }
pass() { echo "[t3-concurrency] PASS $*"; }
fail() { echo "[t3-concurrency] FAIL $*" >&2; exit 1; }

LOCK_MIGRATION="server/Migrations/052_t3_lifecycle_advisory_lock.sql"
test -f "$LOCK_MIGRATION" || fail "missing $LOCK_MIGRATION"
grep -q "hashtext('momo.t3')" "$LOCK_MIGRATION" \
  || fail "named gate advisory namespace missing"
grep -q "hashtext(lower(p_cloud_host_id::text))" "$LOCK_MIGRATION" \
  || fail "named gate lowercase cloud-host key missing"
grep -q "withTenantT3LifecycleTransaction" \
  server/Sources/MomoServer/DB/Database.swift \
  || fail "named gate server first-statement wrapper missing"
grep -q "orderedHostIDs" server/Sources/MomoServer/DB/Database.swift \
  || fail "named gate multi-host ordering missing"
if grep -q "T3LifecycleLock" \
  server/Sources/MomoServer/Routes/WorkHostRoutes.swift; then
  fail "named gate heartbeat must stay outside T3 advisory serialization"
fi
grep -q "T3LifecycleLock.acquire" \
  workers/NotifierWorker/Sources/NotifierWorker/CloudLifecycleReconciler.swift \
  || fail "named gate reconciler advisory wiring missing"
grep -q "T3LifecycleLock.acquire" \
  workers/NotifierWorker/Sources/NotifierWorker/TierFallbackSweep.swift \
  || fail "named gate sweep advisory wiring missing"
test "$(grep -c "withTenantLifecycleTransactionUnwrapped(" \
  server/Sources/MomoServer/Routes/WorkSessionRoutes.swift)" -ge 6 \
  || fail "named gate REST lifecycle advisory wiring missing"
test "$(grep -c "withTenantLifecycleTransactionUnwrapped(" \
  server/Sources/MomoServer/Routes/CloudProvisionerRoutes.swift)" -ge 5 \
  || fail "named gate cloud lifecycle advisory wiring missing"
grep -q "tier fallback session failed" \
  workers/NotifierWorker/Sources/NotifierWorker/TierFallbackSweep.swift \
  || fail "named gate per-session sweep failure isolation missing"
lock_line="$(
  sed -n '/func withTenantT3LifecycleTransaction/,/func withTenantConnection/p' \
    server/Sources/MomoServer/DB/Database.swift \
    | grep -n "T3LifecycleLock.acquire" | head -1 | cut -d: -f1
)"
tenant_line="$(
  sed -n '/func withTenantT3LifecycleTransaction/,/func withTenantConnection/p' \
    server/Sources/MomoServer/DB/Database.swift \
    | grep -n "set_config('app.workspace_id'" | head -1 | cut -d: -f1
)"
test -n "$lock_line" && test -n "$tenant_line" && test "$lock_line" -lt "$tenant_line" \
  || fail "named gate host advisory must precede tenant/application SQL"
bash -n "$0"

if [ "${T3_CONCURRENCY_RUN_DOCKER:-1}" != "1" ]; then
  pass "static advisory, sweep-isolation, and harness checks"
  exit 0
fi

command -v docker >/dev/null 2>&1 || fail "missing docker"

COMPOSE_FILE="$REPO_ROOT/infra/docker-compose.e2e.yml"
SAFE_ENV_FILE="$REPO_ROOT/infra/.env.example"
PROJECT="${T3_CONCURRENCY_PROJECT:-momo890t3locks}"
PG_PORT="${T3_CONCURRENCY_POSTGRES_PORT:-28490}"
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
REST_CLOUD_ID="89000000-0000-7000-8000-000000000001"
REST_HOST_ID="89000000-0000-7000-8000-000000000011"
REST_SESSION_ID="89000000-0000-7000-8000-000000000021"
REST_ROOT_ID="89000000-0000-7000-8000-000000000031"
SWEEP_CLOUD_ID="89000000-0000-7000-8000-000000000002"
SWEEP_HOST_ID="89000000-0000-7000-8000-000000000012"
SWEEP_SESSION_ID="89000000-0000-7000-8000-000000000022"
SWEEP_ROOT_ID="89000000-0000-7000-8000-000000000032"

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
       890001, 0, '$MEMBER_ID'::uuid, 'system'::message_type,
       '{"kind":"work_session","status":"running"}'::jsonb
  FROM bumped
UNION ALL
SELECT '$SWEEP_ROOT_ID'::uuid, '$WS_ID'::uuid, '$CHANNEL_ID'::uuid, last_seq,
       890002, 0, '$MEMBER_ID'::uuid, 'system'::message_type,
       '{"kind":"work_session","status":"running"}'::jsonb
  FROM bumped;
INSERT INTO work_host
  (id, workspace_id, scope, owner_member_id, type, display_name,
   public_key, capabilities, last_seen_at)
VALUES
  ('$REST_HOST_ID', '$WS_ID', 'workspace', '$MEMBER_ID', 'cloud',
   'MOMO-666 REST host', '$PUBLIC_KEY', '{}', clock_timestamp() - interval '1 day'),
  ('$SWEEP_HOST_ID', '$WS_ID', 'workspace', '$MEMBER_ID', 'cloud',
   'MOMO-666 sweep host', '$PUBLIC_KEY', '{}', clock_timestamp() - interval '1 day');
INSERT INTO work_session
  (id, workspace_id, channel_id, member_id, host_id, root_message_id,
   tool, label, status)
VALUES
  ('$REST_SESSION_ID', '$WS_ID', '$CHANNEL_ID', '$MEMBER_ID',
   '$REST_HOST_ID', '$REST_ROOT_ID', 'codex', 'MOMO-666 REST', 'running'),
  ('$SWEEP_SESSION_ID', '$WS_ID', '$CHANNEL_ID', '$MEMBER_ID',
   '$SWEEP_HOST_ID', '$SWEEP_ROOT_ID', 'codex', 'MOMO-666 sweep', 'running');
INSERT INTO work_cloud_host
  (id, workspace_id, requester_member_id, host_id, provider_sandbox_id,
   state, bootstrap_token_digest, bootstrap_expires_at, bootstrap_consumed_at,
   unit_rate_micro_usd_second)
VALUES
  ('$REST_CLOUD_ID', '$WS_ID', '$MEMBER_ID', '$REST_HOST_ID', 'momo890-rest',
   'running', repeat('1', 64), clock_timestamp() + interval '1 hour',
   clock_timestamp(), 1),
  ('$SWEEP_CLOUD_ID', '$WS_ID', '$MEMBER_ID', '$SWEEP_HOST_ID', 'momo890-sweep',
   'running', repeat('2', 64), clock_timestamp() + interval '1 hour',
   clock_timestamp(), 1);
INSERT INTO work_host_usage
  (session_id, host_id, workspace_id, unit_rate_micro_usd_second)
VALUES
  ('$REST_SESSION_ID', '$REST_HOST_ID', '$WS_ID', 1),
  ('$SWEEP_SESSION_ID', '$SWEEP_HOST_ID', '$WS_ID', 1);
INSERT INTO work_host_usage_interval (usage_id, workspace_id, state)
SELECT id, workspace_id, 'active' FROM work_host_usage
 WHERE session_id IN ('$REST_SESSION_ID', '$SWEEP_SESSION_ID');
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
    printf "SELECT id FROM work_cloud_host WHERE id='%s' FOR UPDATE;\n" "$cloud_id"
    printf "SELECT pg_sleep(%s);\n" "$sleep_seconds"
    printf '%s\n' \
      "SELECT u.session_id" \
      "  FROM work_host_usage u" \
      "  JOIN work_session ws ON ws.id=u.session_id" \
      " WHERE u.host_id='$host_id' AND u.session_id='$session_id'" \
      " FOR UPDATE OF u, ws;"
    printf '%s\n' 'ROLLBACK;'
  } >"$output"
}

write_terminal_sql() {
  local output=$1
  local cloud_id=$2
  local session_id=$3
  local kind=$4
  local skip_advisory=${5:-0}
  {
    printf '%s\n' '\set VERBOSITY verbose'
    printf '%s\n' 'BEGIN;'
    if [ "$skip_advisory" != "1" ]; then
      printf "SELECT acquire_t3_lifecycle_lock('%s');\n" "$cloud_id"
    fi
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
    printf "SELECT settle_t3_work_session('%s','%s');\n" "$WS_ID" "$session_id"
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
  wait_for_sql "$scenario reconciler row lock held" 1 "$relation_count"
  wait_for_sql "$scenario terminal path waiting at first lock" 1 "$waiter_count"
  pass "$scenario pg_locks/pg_stat_activity prove real simultaneous serialization"
}

run_normal_scenario() {
  local scenario=$1
  local kind=$2
  local cloud_id=$3
  local host_id=$4
  local session_id=$5
  local app_a="momo890_${kind}_reconciler"
  local app_b="momo890_${kind}_terminal"
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

run_red_proof() {
  local app_a="momo890_red_reconciler"
  local app_b="momo890_red_rest"
  local sql_a="$TMP_DIR/red-a.sql"
  local sql_b="$TMP_DIR/red-b.sql"
  local log_a="$TMP_DIR/red-a.log"
  local log_b="$TMP_DIR/red-b.log"

  write_reconciler_sql \
    "$sql_a" "$REST_CLOUD_ID" "$REST_HOST_ID" 5 "$REST_SESSION_ID"
  # Deliberately model one regressed caller which omits its first-statement
  # advisory. The reconciler keeps the production lock, so 40P01 proves that a
  # single missing participant reopens the original cycle.
  write_terminal_sql "$sql_b" "$REST_CLOUD_ID" "$REST_SESSION_ID" rest 1
  run_connection "$app_a" <"$sql_a" >"$log_a" 2>&1 &
  local pid_a=$!
  wait_for_sql "red reconciler cloud-host lock reached" 1 \
    "SELECT count(*) FROM pg_stat_activity
      WHERE application_name='$app_a' AND wait_event='PgSleep';"
  run_connection "$app_b" <"$sql_b" >"$log_b" 2>&1 &
  local pid_b=$!
  wait_for_sql "red REST holds session+usage and waits for cloud host" 1 \
    "SELECT count(*) FROM pg_stat_activity
      WHERE application_name='$app_b'
        AND state='active'
        AND wait_event_type='Lock'
        AND query LIKE '%settle_t3_work_session%';"

  set +e
  wait "$pid_a"
  local rc_a=$?
  wait "$pid_b"
  local rc_b=$?
  set -e
  if ! grep -q "40P01" "$log_a" "$log_b" \
    || ! grep -q "deadlock detected" "$log_a" "$log_b"; then
    fail "red proof did not produce named SQLSTATE 40P01 deadlock (a=$rc_a b=$rc_b)"
  fi
  fail "named red proof: advisory removal produced deadlock detected (SQLSTATE 40P01)"
}

if [ "$PROVE_RED" = "1" ]; then
  run_red_proof
fi

run_normal_scenario \
  "reconciler x REST end" rest \
  "$REST_CLOUD_ID" "$REST_HOST_ID" "$REST_SESSION_ID"
run_normal_scenario \
  "reconciler x sweep" sweep \
  "$SWEEP_CLOUD_ID" "$SWEEP_HOST_ID" "$SWEEP_SESSION_ID"
pass "MOMO-666 T3 lifecycle concurrency harness"

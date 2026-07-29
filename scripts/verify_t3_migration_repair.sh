#!/usr/bin/env bash
# MOMO-665 / ADR-0140: prove migration 051 fails by name, migration 050 repairs
# through the 049 settlement primitive, retry is idempotent, and the API boots.
set -euo pipefail
umask 077

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

log() { echo "[t3-migration-repair] $*"; }
fail() { echo "[t3-migration-repair] FAIL $*" >&2; exit 1; }
pass() { echo "[t3-migration-repair] PASS $*"; }

need() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

for tool in curl docker jq python3 swift; do
  need "$tool"
done

scripts/check_migration_numbers.sh server/Migrations >/dev/null
bash -n "$0"

RUN_SUFFIX="$(date -u +%Y%m%dT%H%M%SZ)-$$"
POSTGRES_CONTAINER="momo-t3-migration-repair-$RUN_SUFFIX"
POSTGRES_PASSWORD="momo_t3_repair_verifier_$RUN_SUFFIX"
RECOVERY_DB="momo_t3_recovery"
LEGACY_DB="momo_t3_legacy_049"
HOST_ID="00000000-0000-7000-8000-000000008861"
SESSION_ONE_ID="00000000-0000-7000-8000-000000008862"
SESSION_TWO_ID="00000000-0000-7000-8000-000000008863"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/momo-t3-migration-repair.XXXXXX")"
SERVER_PID=""

terminate_tree() {
  local pid="$1"
  local child
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do
    terminate_tree "$child"
  done
  kill "$pid" >/dev/null 2>&1 || true
}

stop_server() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    terminate_tree "$SERVER_PID"
    wait "$SERVER_PID" >/dev/null 2>&1 || true
  fi
  SERVER_PID=""
}

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  stop_server
  docker rm -f "$POSTGRES_CONTAINER" >/dev/null 2>&1 || true
  case "$TMP_DIR" in
    "${TMPDIR:-/tmp}"/momo-t3-migration-repair.*) rm -r -- "$TMP_DIR" ;;
    *) log "refusing unexpected cleanup path: $TMP_DIR" ;;
  esac
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

log "starting isolated PostgreSQL 18"
docker run --detach --rm \
  --name "$POSTGRES_CONTAINER" \
  --env "POSTGRES_PASSWORD=$POSTGRES_PASSWORD" \
  --publish 127.0.0.1::5432 \
  --volume "$REPO_ROOT:/workspace:ro" \
  pgvector/pgvector:0.8.5-pg18-trixie@sha256:9d2e61c7352b9e9f4798df5fd9a498f043f4cda1cdacc707de3d198650f4321e \
  >/dev/null

for _ in $(seq 1 60); do
  if docker exec "$POSTGRES_CONTAINER" pg_isready -U postgres >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec "$POSTGRES_CONTAINER" pg_isready -U postgres >/dev/null \
  || fail "PostgreSQL did not become ready"

HOST_PORT="$(docker port "$POSTGRES_CONTAINER" 5432/tcp \
  | sed -E 's/.*:([0-9]+)$/\1/' | tail -n 1)"
case "$HOST_PORT" in
  ''|*[!0-9]*) fail "could not resolve PostgreSQL host port" ;;
esac

for database in "$RECOVERY_DB" "$LEGACY_DB"; do
  docker exec "$POSTGRES_CONTAINER" createdb -U postgres "$database"
done

psql_in() {
  local database="$1"
  shift
  docker exec --interactive "$POSTGRES_CONTAINER" \
    psql -U postgres -d "$database" -v ON_ERROR_STOP=1 --no-psqlrc "$@"
}

sql_value() {
  local database="$1"
  shift
  psql_in "$database" -At "$@" | tr -d '[:space:]'
}

apply_through_048() {
  local database="$1"
  local migration version prefix number

  psql_in "$database" -q <<'SQL'
CREATE TABLE schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
SQL

  for migration in "$REPO_ROOT"/server/Migrations/*.sql; do
    version="${migration##*/}"
    prefix="${version%%_*}"
    number=$((10#$prefix))
    [ "$number" -le 48 ] || continue

    docker exec "$POSTGRES_CONTAINER" psql \
      -U postgres -d "$database" \
      -v ON_ERROR_STOP=1 \
      --set=MOMO_AGENT_SEED_ENABLED=1 \
      --no-psqlrc --quiet --single-transaction \
      -f "/workspace/server/Migrations/$version" \
      -c "INSERT INTO schema_migrations (version) VALUES ('$version');"
  done
}

run_migrate() {
  local database="$1"
  docker exec \
    --env "DATABASE_URL=postgres://postgres:$POSTGRES_PASSWORD@127.0.0.1:5432/$database" \
    --env MOMO_AGENT_SEED_MODE=e2e \
    --env MIGRATE_IDEMPOTENCY_CHECK=1 \
    --workdir /workspace \
    "$POSTGRES_CONTAINER" sh scripts/migrate.sh
}

assert_named_051_failure() {
  local log_file="$1"
  grep -F "+ APPLY 051_t3_unsettled_usage_constraint.sql" "$log_file" >/dev/null \
    || fail "migration did not stop in 051"
  grep -F "cannot enforce one unsettled T3 usage per host" "$log_file" >/dev/null \
    || fail "051 failure did not name the violated invariant"
  grep -F "docs/runbooks/t3-unsettled-usage-repair.md" "$log_file" >/dev/null \
    || fail "051 failure did not point to the repair runbook"
  grep -F "$(printf '%s' "$HOST_ID" | tr '[:upper:]' '[:lower:]') (2)" \
    "$log_file" >/dev/null \
    || fail "051 failure did not name the lowercased host and usage count"
}

log "building recovery fixture through migration 048"
apply_through_048 "$RECOVERY_DB"

psql_in "$RECOVERY_DB" -q <<SQL
BEGIN;
SET LOCAL row_security = off;

UPDATE channel_seq
   SET last_seq = 2
 WHERE channel_id = '00000000-0000-7000-8000-000000000201';

INSERT INTO message
  (id, workspace_id, channel_id, seq, hlc_ts, hlc_count,
   author_member_id, type, state, body, props)
VALUES
  ('00000000-0000-7000-8000-000000008864',
   '00000000-0000-7000-8000-000000000001',
   '00000000-0000-7000-8000-000000000201',
   1, 1, 0, '00000000-0000-7000-8000-000000000101',
   'system', 'sent', 'T3 repair fixture one', '{"kind":"work_session"}'),
  ('00000000-0000-7000-8000-000000008865',
   '00000000-0000-7000-8000-000000000001',
   '00000000-0000-7000-8000-000000000201',
   2, 2, 0, '00000000-0000-7000-8000-000000000101',
   'system', 'sent', 'T3 repair fixture two', '{"kind":"work_session"}');

INSERT INTO work_host
  (id, workspace_id, scope, owner_member_id, type, display_name,
   public_key, capabilities, last_seen_at)
VALUES
  ('$HOST_ID', '00000000-0000-7000-8000-000000000001',
   'workspace', '00000000-0000-7000-8000-000000000101',
   'cloud', 'T3 duplicate fixture', repeat('A', 43) || '=',
   '{"tool.codex":true}', clock_timestamp());

INSERT INTO work_session
  (id, workspace_id, channel_id, member_id, host_id, root_message_id,
   tool, label, status)
VALUES
  ('$SESSION_ONE_ID', '00000000-0000-7000-8000-000000000001',
   '00000000-0000-7000-8000-000000000201',
   '00000000-0000-7000-8000-000000000101',
   '$HOST_ID', '00000000-0000-7000-8000-000000008864',
   'codex', 'T3 duplicate fixture one', 'running'),
  ('$SESSION_TWO_ID', '00000000-0000-7000-8000-000000000001',
   '00000000-0000-7000-8000-000000000201',
   '00000000-0000-7000-8000-000000000101',
   '$HOST_ID', '00000000-0000-7000-8000-000000008865',
   'codex', 'T3 duplicate fixture two', 'running');

INSERT INTO work_cloud_host
  (id, workspace_id, requester_member_id, host_id, provider_sandbox_id,
   state, bootstrap_token_digest, bootstrap_expires_at,
   bootstrap_consumed_at, unit_rate_micro_usd_second)
VALUES
  ('00000000-0000-7000-8000-000000008866',
   '00000000-0000-7000-8000-000000000001',
   '00000000-0000-7000-8000-000000000101',
   '$HOST_ID', 'momo886repair', 'running', repeat('8', 64),
   clock_timestamp() + interval '10 minutes', clock_timestamp(), 25);

INSERT INTO work_host_usage
  (id, session_id, host_id, workspace_id, started_at,
   unit_rate_micro_usd_second)
VALUES
  ('00000000-0000-7000-8000-000000008867',
   '$SESSION_ONE_ID', '$HOST_ID',
   '00000000-0000-7000-8000-000000000001',
   clock_timestamp() - interval '120 seconds', 25),
  ('00000000-0000-7000-8000-000000008868',
   '$SESSION_TWO_ID', '$HOST_ID',
   '00000000-0000-7000-8000-000000000001',
   clock_timestamp() - interval '120 seconds', 25);

INSERT INTO work_host_usage_interval
  (id, usage_id, workspace_id, state, started_at)
VALUES
  ('00000000-0000-7000-8000-000000008869',
   '00000000-0000-7000-8000-000000008867',
   '00000000-0000-7000-8000-000000000001',
   'active', clock_timestamp() - interval '120 seconds'),
  ('00000000-0000-7000-8000-00000000886a',
   '00000000-0000-7000-8000-000000008868',
   '00000000-0000-7000-8000-000000000001',
   'active', clock_timestamp() - interval '120 seconds');

COMMIT;
SQL

FIRST_FAILURE_LOG="$TMP_DIR/first-051-failure.log"
if run_migrate "$RECOVERY_DB" >"$FIRST_FAILURE_LOG" 2>&1; then
  fail "migration unexpectedly accepted duplicate unsettled usage"
fi
assert_named_051_failure "$FIRST_FAILURE_LOG"
[ "$(sql_value "$RECOVERY_DB" -c "
  SELECT string_agg(version, ',' ORDER BY version)
    FROM schema_migrations
   WHERE version LIKE '049_%'
      OR version LIKE '050_%'
      OR version LIKE '051_%';
")" = "049_t3_lifecycle_settlement.sql,050_t3_unsettled_usage_repair.sql" ] \
  || fail "049/050 did not commit independently before 051 rollback"
pass "051 fails by name after primitive and repair entrypoint commit"

RED_FAILURE_LOG="$TMP_DIR/red-051-failure.log"
if run_migrate "$RECOVERY_DB" >"$RED_FAILURE_LOG" 2>&1; then
  fail "red proof skipped repair but migration succeeded"
fi
assert_named_051_failure "$RED_FAILURE_LOG"
[ "$(sql_value "$RECOVERY_DB" -c "
  SELECT count(*) FROM schema_migrations
   WHERE version = '051_t3_unsettled_usage_constraint.sql';
")" = "0" ] || fail "failed 051 was recorded"
pass "red proof: retry without repair repeats the same named 051 failure"

REPAIR_LOG="$TMP_DIR/repair-output.log"
psql_in "$RECOVERY_DB" -At -F '|' -c "
  SELECT lower(host_id::text),
         usage_count,
         lower(session_id::text),
         settled
    FROM repair_t3_duplicate_unsettled_usage()
   ORDER BY host_id, session_id;
" >"$REPAIR_LOG"

[ "$(wc -l <"$REPAIR_LOG" | tr -d '[:space:]')" = "2" ] \
  || fail "repair did not report both duplicate sessions"
grep -Fx "$HOST_ID|2|$SESSION_ONE_ID|t" "$REPAIR_LOG" >/dev/null \
  || fail "repair output missing first session diagnostic"
grep -Fx "$HOST_ID|2|$SESSION_TWO_ID|t" "$REPAIR_LOG" >/dev/null \
  || fail "repair output missing second session diagnostic"

[ "$(sql_value "$RECOVERY_DB" -c "
  SELECT
    count(*) FILTER (WHERE settled_at IS NOT NULL) || ':' ||
    count(*) FILTER (WHERE settled_at IS NULL) || ':' ||
    (SELECT count(*) FROM credit_entry
      WHERE reason = 't3_usage'
        AND ref_id IN ('$SESSION_ONE_ID', '$SESSION_TWO_ID')) || ':' ||
    (SELECT count(*) FROM work_host
      WHERE id = '$HOST_ID' AND revoked_at IS NOT NULL) || ':' ||
    (SELECT count(*) FROM work_cloud_host
      WHERE host_id = '$HOST_ID' AND state = 'destroy_pending')
  FROM work_host_usage
  WHERE host_id = '$HOST_ID';
")" = "2:0:2:1:1" ] \
  || fail "repair did not preserve the 049 atomic settlement effects"
pass "050 repairs every duplicate session through settle_t3_work_session"

SUCCESS_LOG="$TMP_DIR/retry-success.log"
run_migrate "$RECOVERY_DB" >"$SUCCESS_LOG" 2>&1
grep -F "+ APPLY 051_t3_unsettled_usage_constraint.sql" "$SUCCESS_LOG" >/dev/null \
  || fail "051 was not applied after repair"
grep -F "[migrate] IDEMPOTENCY_OK second-pass applied=0" "$SUCCESS_LOG" >/dev/null \
  || fail "migration runner second-pass idempotency marker missing"
[ "$(sql_value "$RECOVERY_DB" -c "
  SELECT position(
    't3_terminate' IN pg_get_functiondef(
      'repair_t3_duplicate_unsettled_usage()'::regprocedure
    )
  ) > 0;
")" = "t" ] \
  || fail "053 did not replace repair delegation with t3_terminate"
pass "053 canonicalizes subsequent repair calls through t3_terminate"
[ "$(sql_value "$RECOVERY_DB" -c "
  SELECT count(*) FROM pg_indexes
   WHERE schemaname = 'public'
     AND indexname = 'work_host_usage_one_unsettled_per_host_idx';
")" = "1" ] || fail "unsettled usage unique index missing after retry"
pass "repair retry applies 051 and runner second pass applies zero files"

psql_in "$RECOVERY_DB" -q -f /workspace/infra/e2e/bootstrap_roles.sql

free_port() {
  python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()'
}

SERVER_PORT="$(free_port)"
(
  cd "$REPO_ROOT"
  DATABASE_URL="postgres://momo_app:momo_app_dev_pw@127.0.0.1:$HOST_PORT/$RECOVERY_DB" \
    MOMO_ENV=local HOST=127.0.0.1 PORT="$SERVER_PORT" \
    swift run --package-path server MomoServer
) >"$TMP_DIR/server.log" 2>&1 &
SERVER_PID="$!"

for _ in $(seq 1 180); do
  if curl -fsS --connect-timeout 2 --max-time 3 \
      "http://127.0.0.1:$SERVER_PORT/health" \
      | jq -e '.status == "ok" and .service == "MomoServer"' >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    tail -160 "$TMP_DIR/server.log" >&2 || true
    fail "MomoServer exited before health became green"
  fi
  sleep 1
done
curl -fsS --connect-timeout 2 --max-time 3 \
  "http://127.0.0.1:$SERVER_PORT/health" \
  | jq -e '.status == "ok" and .service == "MomoServer"' >/dev/null \
  || {
    tail -160 "$TMP_DIR/server.log" >&2 || true
    fail "MomoServer health timeout after repaired migration"
  }
stop_server
pass "MomoServer starts and serves health after repair and migration retry"

log "building an already-applied-049 database with the legacy index present"
apply_through_048 "$LEGACY_DB"
docker exec "$POSTGRES_CONTAINER" psql \
  -U postgres -d "$LEGACY_DB" \
  -v ON_ERROR_STOP=1 \
  --set=MOMO_AGENT_SEED_ENABLED=1 \
  --no-psqlrc --quiet --single-transaction \
  -f /workspace/server/Migrations/049_t3_lifecycle_settlement.sql \
  -c "INSERT INTO schema_migrations (version) VALUES ('049_t3_lifecycle_settlement.sql');"
psql_in "$LEGACY_DB" -q <<'SQL'
CREATE UNIQUE INDEX work_host_usage_one_unsettled_per_host_idx
  ON work_host_usage (host_id)
  WHERE settled_at IS NULL;
COMMENT ON INDEX work_host_usage_one_unsettled_per_host_idx IS
  'v0 one paid session per cloud host; prevents double billing and sandbox-wide pause races.';
SQL

LEGACY_LOG="$TMP_DIR/legacy-049-success.log"
run_migrate "$LEGACY_DB" >"$LEGACY_LOG" 2>&1
grep -F "= SKIP  049_t3_lifecycle_settlement.sql (이미 적용됨)" \
  "$LEGACY_LOG" >/dev/null \
  || fail "legacy database did not skip its recorded 049 filename"
grep -F "+ APPLY 050_t3_unsettled_usage_repair.sql" "$LEGACY_LOG" >/dev/null \
  || fail "legacy database did not apply 050"
grep -F "+ APPLY 051_t3_unsettled_usage_constraint.sql" "$LEGACY_LOG" >/dev/null \
  || fail "legacy database did not apply 051"
grep -F "[migrate] IDEMPOTENCY_OK second-pass applied=0" "$LEGACY_LOG" >/dev/null \
  || fail "legacy database second-pass idempotency marker missing"
[ "$(sql_value "$LEGACY_DB" -c "
  SELECT count(*) FROM pg_indexes
   WHERE schemaname = 'public'
     AND indexname = 'work_host_usage_one_unsettled_per_host_idx';
")" = "1" ] || fail "051 duplicated or removed the legacy unique index"
pass "already-applied 049 safely skips 049 and accepts idempotent 051"

pass "named failure -> red proof -> repair -> retry -> service boot -> legacy 049"

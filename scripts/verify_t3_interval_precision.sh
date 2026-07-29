#!/usr/bin/env bash
# MOMO-661 ① / #879 — T3 interval billing precision.
#
# The claim under test: after migration 058 a T3 session with many pause
# boundaries bills the whole seconds a microsecond-exact ledger owes, while a
# `paused` interval still bills structurally zero.
#
# The old behaviour is not simulated — it is measured. Migrations 001..057 are
# applied first and a fixture session is settled through the *real* pre-058
# `t3_terminate`; that number is kept. Migration 058 is then applied through the
# real runner and an identically shaped session is settled through the new
# statement. The difference between the two numbers is the loss the issue
# describes, and it is asserted by name.
#
# Fixture shape (exact boundaries, no sleeps):
#   12 x active 1.900000s interleaved with 11 x paused 3.300000s, then one
#   still-open paused interval that settlement closes four weeks later.
#     true active time    = 22.800000 s
#     sum of per-interval floors = 12 x floor(1.9) = 12 s  (10.8 s discarded)
#     floor of the sum           = floor(22.8)     = 22 s  ( 0.8 s discarded)
#
# Red proof:
#   T3_PRECISION_PROVE_RED=interval-floor rewrites the post-058 t3_terminate to
#   floor every interval before summing. The gate must then fail with
#   `interval-floor truncation loss` naming the seconds it failed to recover.
#
# Requires Docker (isolated PostgreSQL 18). No compose stack, no server build.
# T3_PRECISION_RUN_DOCKER=0 runs the static half only.
set -euo pipefail
umask 077

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

log() { echo "[t3-precision] $*"; }
fail() { echo "[t3-precision] FAIL $*" >&2; exit 1; }
pass() { echo "[t3-precision] PASS $*"; }

PRECISION_MIGRATION="server/Migrations/058_t3_interval_micro_precision.sql"
CANONICAL_MIGRATION="server/Migrations/053_t3_lifecycle_canonicalization.sql"
CONSTRAINT_MIGRATION="server/Migrations/051_t3_unsettled_usage_constraint.sql"
LEDGER_SWIFT="server/Sources/MomoServer/Cloud/CloudUsageLedger.swift"

test -f "$PRECISION_MIGRATION" || fail "missing $PRECISION_MIGRATION"
test -f "$CANONICAL_MIGRATION" || fail "missing $CANONICAL_MIGRATION"
test -f "$CONSTRAINT_MIGRATION" || fail "missing $CONSTRAINT_MIGRATION"
grep -qF "active_micros bigint GENERATED ALWAYS AS" "$PRECISION_MIGRATION" \
  || fail "named gate generated-microsecond-interval"
grep -qF "WHEN state = 'active' AND ended_at IS NOT NULL" "$PRECISION_MIGRATION" \
  || fail "named gate structural-pause-zero-retained"
grep -qF "CREATE OR REPLACE FUNCTION t3_terminate" "$PRECISION_MIGRATION" \
  || fail "named gate single-floor-settlement-primitive"
grep -qF "t3 settlement must go through t3_terminate" "$CANONICAL_MIGRATION" \
  || fail "named gate direct-settlement-seal"
grep -qF "work_host_usage_one_unsettled_per_host_idx" "$CONSTRAINT_MIGRATION" \
  || fail "named gate one-unsettled-usage-per-host"
grep -qF "WITH closed AS (" "$LEDGER_SWIFT" \
  || fail "named gate adjacent-interval-boundary"
grep -qF "closed.ended_at" "$LEDGER_SWIFT" \
  || fail "named gate adjacent-interval-boundary"
# Every rounding decision belongs to the settlement statement. A Swift file that
# names either billing column is a second opinion about the same number.
if grep -qE "active_micros|active_seconds" "$LEDGER_SWIFT"; then
  fail "named gate billing-arithmetic-stays-in-the-database"
fi

if git diff --name-only HEAD -- schema_v0.sql | grep -q .; then
  fail "schema_v0.sql must not change"
fi
scripts/check_migration_numbers.sh server/Migrations >/dev/null
bash -n "$0"

if [ "${T3_PRECISION_RUN_DOCKER:-1}" != "1" ]; then
  pass "static migration and ledger checks"
  exit 0
fi

command -v docker >/dev/null 2>&1 || fail "missing required command: docker"

RUN_SUFFIX="$(date -u +%Y%m%dT%H%M%SZ)-$$"
POSTGRES_CONTAINER="momo-t3-precision-$RUN_SUFFIX"
POSTGRES_PASSWORD="momo_t3_precision_verifier_$RUN_SUFFIX"
DB="momo_t3_precision"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/momo-t3-precision.XXXXXX")"

WS_ID="00000000-0000-7000-8000-000000000001"
MEMBER_ID="00000000-0000-7000-8000-000000000101"
CHANNEL_ID="00000000-0000-7000-8000-000000000201"

LEGACY_HOST_ID="00000000-0000-7000-8000-000000008791"
LEGACY_SESSION_ID="00000000-0000-7000-8000-000000008792"
LEGACY_MESSAGE_ID="00000000-0000-7000-8000-000000008793"
LEGACY_CLOUD_ID="00000000-0000-7000-8000-000000008794"
LEGACY_USAGE_ID="00000000-0000-7000-8000-000000008795"

MICROS_HOST_ID="00000000-0000-7000-8000-0000000087a1"
MICROS_SESSION_ID="00000000-0000-7000-8000-0000000087a2"
MICROS_MESSAGE_ID="00000000-0000-7000-8000-0000000087a3"
MICROS_CLOUD_ID="00000000-0000-7000-8000-0000000087a4"
MICROS_USAGE_ID="00000000-0000-7000-8000-0000000087a5"

HISTORY_HOST_ID="00000000-0000-7000-8000-0000000087b1"
HISTORY_SESSION_ID="00000000-0000-7000-8000-0000000087b2"
HISTORY_MESSAGE_ID="00000000-0000-7000-8000-0000000087b3"
HISTORY_USAGE_ID="00000000-0000-7000-8000-0000000087b4"
HISTORY_SECONDS=3577

UNIT_RATE=25
ACTIVE_ROUNDS=12
# 1.9 s active / 3.3 s paused, written in microseconds so the fixture never
# depends on floating point.
ACTIVE_MICROS_EACH=1900000
PAUSED_MICROS_EACH=3300000
EXPECTED_TRUE_MICROS=$((ACTIVE_ROUNDS * ACTIVE_MICROS_EACH))                 # 22800000
EXPECTED_MICROS_SECONDS=$((EXPECTED_TRUE_MICROS / 1000000))                  # 22
EXPECTED_LEGACY_SECONDS=$((ACTIVE_ROUNDS * (ACTIVE_MICROS_EACH / 1000000)))  # 12
EXPECTED_RECOVERED=$((EXPECTED_MICROS_SECONDS - EXPECTED_LEGACY_SECONDS))    # 10
FIXTURE_BASE="2026-07-01 00:00:00+00"

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  docker rm -f "$POSTGRES_CONTAINER" >/dev/null 2>&1 || true
  case "$TMP_DIR" in
    "${TMPDIR:-/tmp}"/momo-t3-precision.*) rm -r -- "$TMP_DIR" ;;
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

docker exec "$POSTGRES_CONTAINER" createdb -U postgres "$DB" >/dev/null

psql_in() {
  docker exec --interactive "$POSTGRES_CONTAINER" \
    psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 --no-psqlrc "$@"
}

# Every value read back is a single scalar with no internal whitespace.
sql_value() {
  psql_in -At "$@" | tr -d '[:space:]'
}

# Apply everything up to and including migration <ceiling>, recorded exactly the
# way scripts/migrate.sh records it so the later runner call skips them.
apply_through() {
  local ceiling="$1"
  local migration version prefix number

  psql_in -q <<'SQL'
CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
SQL

  for migration in "$REPO_ROOT"/server/Migrations/*.sql; do
    version="${migration##*/}"
    prefix="${version%%_*}"
    number=$((10#$prefix))
    [ "$number" -le "$ceiling" ] || continue

    docker exec "$POSTGRES_CONTAINER" psql \
      -U postgres -d "$DB" \
      -v ON_ERROR_STOP=1 \
      --set=MOMO_AGENT_SEED_ENABLED=1 \
      --no-psqlrc --quiet --single-transaction \
      -f "/workspace/server/Migrations/$version" \
      -c "INSERT INTO schema_migrations (version) VALUES ('$version');" \
      >/dev/null
  done
}

run_migrate() {
  docker exec \
    --env "DATABASE_URL=postgres://postgres:$POSTGRES_PASSWORD@127.0.0.1:5432/$DB" \
    --env MOMO_AGENT_SEED_MODE=e2e \
    --env MIGRATE_IDEMPOTENCY_CHECK=1 \
    --workdir /workspace \
    "$POSTGRES_CONTAINER" sh scripts/migrate.sh
}

# One paid T3 session whose intervals are written with exact boundaries. The
# fixture only ever writes timestamps — the active-time column is generated in
# both the pre-058 and post-058 schema, which is the property under test.
seed_session() {
  local host_id="$1" session_id="$2" message_id="$3"
  local cloud_id="$4" usage_id="$5" seq="$6"

  psql_in -q <<SQL
BEGIN;
SET LOCAL row_security = off;

INSERT INTO workspace_credit (workspace_id, balance_micro_usd)
VALUES ('$WS_ID', 100000000)
ON CONFLICT (workspace_id) DO NOTHING;

UPDATE channel_seq SET last_seq = GREATEST(last_seq, $seq)
 WHERE channel_id = '$CHANNEL_ID';

INSERT INTO message
  (id, workspace_id, channel_id, seq, hlc_ts, hlc_count,
   author_member_id, type, state, body, props)
VALUES
  ('$message_id'::uuid, '$WS_ID'::uuid, '$CHANNEL_ID'::uuid, $seq, $seq, 0,
   '$MEMBER_ID'::uuid, 'system', 'sent', 'T3 precision fixture',
   '{"kind":"work_session"}'::jsonb);

INSERT INTO work_host
  (id, workspace_id, scope, owner_member_id, type, display_name,
   public_key, capabilities, last_seen_at)
VALUES
  ('$host_id'::uuid, '$WS_ID'::uuid, 'workspace', '$MEMBER_ID'::uuid, 'cloud',
   'T3 precision fixture', repeat('A', 43) || '=',
   '{"tool.codex":true}'::jsonb, clock_timestamp());

INSERT INTO work_session
  (id, workspace_id, channel_id, member_id, host_id, root_message_id,
   tool, label, status)
VALUES
  ('$session_id'::uuid, '$WS_ID'::uuid, '$CHANNEL_ID'::uuid,
   '$MEMBER_ID'::uuid, '$host_id'::uuid, '$message_id'::uuid,
   'codex', 'T3 precision fixture', 'running');

INSERT INTO work_cloud_host
  (id, workspace_id, requester_member_id, host_id, provider,
   provider_sandbox_id, state, bootstrap_token_digest,
   bootstrap_expires_at, bootstrap_consumed_at, unit_rate_micro_usd_second)
VALUES
  ('$cloud_id'::uuid, '$WS_ID'::uuid, '$MEMBER_ID'::uuid, '$host_id'::uuid,
   'mock-a', 'momo879precision-$seq', 'running',
   md5('momo879-precision-$seq') || md5('momo879-precision-digest-$seq'),
   clock_timestamp() + interval '10 minutes', clock_timestamp(), $UNIT_RATE);

INSERT INTO work_host_usage
  (id, session_id, host_id, workspace_id, started_at,
   unit_rate_micro_usd_second)
VALUES
  ('$usage_id'::uuid, '$session_id'::uuid, '$host_id'::uuid, '$WS_ID'::uuid,
   timestamptz '$FIXTURE_BASE', $UNIT_RATE);

-- active run i starts where paused run i-1 ended; no gaps, no overlaps.
INSERT INTO work_host_usage_interval
  (usage_id, workspace_id, state, started_at, ended_at)
SELECT '$usage_id'::uuid, '$WS_ID'::uuid, 'active',
       timestamptz '$FIXTURE_BASE'
         + (t.i * interval '$ACTIVE_MICROS_EACH microseconds')
         + (t.i * interval '$PAUSED_MICROS_EACH microseconds'),
       timestamptz '$FIXTURE_BASE'
         + ((t.i + 1) * interval '$ACTIVE_MICROS_EACH microseconds')
         + (t.i * interval '$PAUSED_MICROS_EACH microseconds')
  FROM generate_series(0, $ACTIVE_ROUNDS - 1) AS t(i);

INSERT INTO work_host_usage_interval
  (usage_id, workspace_id, state, started_at, ended_at)
SELECT '$usage_id'::uuid, '$WS_ID'::uuid, 'paused',
       timestamptz '$FIXTURE_BASE'
         + ((t.i + 1) * interval '$ACTIVE_MICROS_EACH microseconds')
         + (t.i * interval '$PAUSED_MICROS_EACH microseconds'),
       timestamptz '$FIXTURE_BASE'
         + ((t.i + 1) * interval '$ACTIVE_MICROS_EACH microseconds')
         + ((t.i + 1) * interval '$PAUSED_MICROS_EACH microseconds')
  FROM generate_series(0, $ACTIVE_ROUNDS - 2) AS t(i);

-- The pause the session is still sitting in when it is terminated.
INSERT INTO work_host_usage_interval
  (usage_id, workspace_id, state, started_at)
VALUES
  ('$usage_id'::uuid, '$WS_ID'::uuid, 'paused',
   timestamptz '$FIXTURE_BASE'
     + ($ACTIVE_ROUNDS * interval '$ACTIVE_MICROS_EACH microseconds')
     + (($ACTIVE_ROUNDS - 1) * interval '$PAUSED_MICROS_EACH microseconds'));

COMMIT;
SQL
}

settle() {
  sql_value -c "SELECT t3_terminate('$WS_ID'::uuid, '$1'::uuid, 'ended');"
}

# ---------------------------------------------------------------------------
# 1) Pre-058 behaviour, measured through the statement that actually shipped.
# ---------------------------------------------------------------------------
log "applying migrations 001..057"
apply_through 57

[ "$(sql_value -c "
  SELECT count(*) FROM information_schema.columns
   WHERE table_name = 'work_host_usage_interval'
     AND column_name = 'active_seconds';
")" = "1" ] || fail "pre-058 database does not carry the per-interval floor column"

seed_session "$LEGACY_HOST_ID" "$LEGACY_SESSION_ID" "$LEGACY_MESSAGE_ID" \
  "$LEGACY_CLOUD_ID" "$LEGACY_USAGE_ID" 4001
[ "$(settle "$LEGACY_SESSION_ID")" = "t" ] || fail "pre-058 settlement returned false"

LEGACY_SECONDS="$(sql_value -c "
  SELECT active_seconds FROM work_host_usage WHERE id = '$LEGACY_USAGE_ID';
")"
LEGACY_DEBIT="$(sql_value -c "
  SELECT -delta_micro_usd FROM credit_entry
   WHERE workspace_id = '$WS_ID' AND reason = 't3_usage'
     AND ref_id = '$LEGACY_SESSION_ID';
")"
LEGACY_SETTLED_EPOCH="$(sql_value -c "
  SELECT extract(epoch FROM settled_at)::text
    FROM work_host_usage WHERE id = '$LEGACY_USAGE_ID';
")"

[ "$LEGACY_SECONDS" = "$EXPECTED_LEGACY_SECONDS" ] \
  || fail "pre-058 fixture did not reproduce the per-interval floor: billed ${LEGACY_SECONDS}s, expected ${EXPECTED_LEGACY_SECONDS}s"
[ "$LEGACY_DEBIT" = "$((EXPECTED_LEGACY_SECONDS * UNIT_RATE))" ] \
  || fail "pre-058 debit mismatch: $LEGACY_DEBIT"
pass "pre-058 t3_terminate bills ${LEGACY_SECONDS}s for ${EXPECTED_TRUE_MICROS}us of active time (measured, not simulated)"

# Every real database has rows settled before this migration. They must survive
# it byte for byte: no recompute, no compensating debit.
psql_in -q <<SQL
BEGIN;
SET LOCAL row_security = off;

UPDATE channel_seq SET last_seq = GREATEST(last_seq, 4101)
 WHERE channel_id = '$CHANNEL_ID';

INSERT INTO message
  (id, workspace_id, channel_id, seq, hlc_ts, hlc_count,
   author_member_id, type, state, body, props)
VALUES
  ('$HISTORY_MESSAGE_ID'::uuid, '$WS_ID'::uuid, '$CHANNEL_ID'::uuid,
   4101, 4101, 0, '$MEMBER_ID'::uuid, 'system', 'sent',
   'T3 precision history fixture', '{"kind":"work_session"}'::jsonb);

INSERT INTO work_host
  (id, workspace_id, scope, owner_member_id, type, display_name,
   public_key, capabilities, last_seen_at)
VALUES
  ('$HISTORY_HOST_ID'::uuid, '$WS_ID'::uuid, 'workspace', '$MEMBER_ID'::uuid,
   'cloud', 'T3 precision history', repeat('B', 43) || '=',
   '{"tool.codex":true}'::jsonb, clock_timestamp());

INSERT INTO work_session
  (id, workspace_id, channel_id, member_id, host_id, root_message_id,
   tool, label, status, started_at, ended_at, exit_code)
VALUES
  ('$HISTORY_SESSION_ID'::uuid, '$WS_ID'::uuid, '$CHANNEL_ID'::uuid,
   '$MEMBER_ID'::uuid, '$HISTORY_HOST_ID'::uuid, '$HISTORY_MESSAGE_ID'::uuid,
   'codex', 'T3 precision history', 'ended',
   timestamptz '$FIXTURE_BASE', timestamptz '$FIXTURE_BASE' + interval '1 hour',
   0);

INSERT INTO work_host_usage
  (id, session_id, host_id, workspace_id, started_at, ended_at,
   active_seconds, unit_rate_micro_usd_second, settled_at, settled_reason)
VALUES
  ('$HISTORY_USAGE_ID'::uuid, '$HISTORY_SESSION_ID'::uuid,
   '$HISTORY_HOST_ID'::uuid, '$WS_ID'::uuid,
   timestamptz '$FIXTURE_BASE', timestamptz '$FIXTURE_BASE' + interval '1 hour',
   $HISTORY_SECONDS, $UNIT_RATE,
   timestamptz '$FIXTURE_BASE' + interval '1 hour', 'ended');

COMMIT;
SQL

# ---------------------------------------------------------------------------
# 2) Apply 058 through the real runner.
# ---------------------------------------------------------------------------
MIGRATE_LOG="$TMP_DIR/migrate-058.log"
run_migrate >"$MIGRATE_LOG" 2>&1 || {
  tail -60 "$MIGRATE_LOG" >&2 || true
  fail "migration runner failed applying 058"
}
grep -F "+ APPLY 058_t3_interval_micro_precision.sql" "$MIGRATE_LOG" >/dev/null \
  || fail "058 was not applied by the runner"
grep -F "[migrate] IDEMPOTENCY_OK second-pass applied=0" "$MIGRATE_LOG" >/dev/null \
  || fail "058 broke the runner second-pass idempotency marker"
pass "058 applies through scripts/migrate.sh and keeps the idempotency marker"

# ---------------------------------------------------------------------------
# 3) Past invoices are facts.
# ---------------------------------------------------------------------------
UNCHANGED="$(sql_value -c "
  SELECT
    (SELECT active_seconds FROM work_host_usage WHERE id = '$LEGACY_USAGE_ID') || ':' ||
    (SELECT count(*) FROM work_host_usage
      WHERE id = '$LEGACY_USAGE_ID' AND active_micros IS NULL) || ':' ||
    (SELECT count(*) FROM work_host_usage
      WHERE id = '$LEGACY_USAGE_ID'
        AND extract(epoch FROM settled_at)::text = '$LEGACY_SETTLED_EPOCH') || ':' ||
    (SELECT count(*) FROM credit_entry
      WHERE ref_id = '$LEGACY_SESSION_ID' AND reason = 't3_usage') || ':' ||
    (SELECT -delta_micro_usd FROM credit_entry
      WHERE ref_id = '$LEGACY_SESSION_ID' AND reason = 't3_usage') || ':' ||
    (SELECT active_seconds FROM work_host_usage WHERE id = '$HISTORY_USAGE_ID') || ':' ||
    (SELECT count(*) FROM work_host_usage
      WHERE id = '$HISTORY_USAGE_ID' AND active_micros IS NULL);
")"
EXPECTED_UNCHANGED="$LEGACY_SECONDS:1:1:1:$LEGACY_DEBIT:$HISTORY_SECONDS:1"
[ "$UNCHANGED" = "$EXPECTED_UNCHANGED" ] \
  || fail "058 rewrote already-settled rows: $UNCHANGED (expected $EXPECTED_UNCHANGED)"
pass "settled rows keep their seconds, settlement timestamp and debit; active_micros IS NULL marks them"

# ---------------------------------------------------------------------------
# 4) Structure: pause-zero is still generated, not enforced by billing code.
# ---------------------------------------------------------------------------
SHAPE="$(sql_value -c "
  SELECT
    (SELECT count(*) FROM information_schema.columns
      WHERE table_name = 'work_host_usage_interval'
        AND column_name = 'active_seconds') || ':' ||
    (SELECT is_generated FROM information_schema.columns
      WHERE table_name = 'work_host_usage_interval'
        AND column_name = 'active_micros') || ':' ||
    (SELECT column_default FROM information_schema.columns
      WHERE table_name = 'work_host_usage_interval'
        AND column_name = 'started_at') || ':' ||
    (SELECT count(*) FROM pg_indexes
      WHERE indexname = 'work_host_usage_one_unsettled_per_host_idx') || ':' ||
    (SELECT count(*) FROM pg_indexes
      WHERE indexname = 'work_host_usage_interval_one_open_idx');
")"
[ "$SHAPE" = "0:ALWAYS:clock_timestamp():1:1" ] \
  || fail "058 schema shape: $SHAPE (expected 0:ALWAYS:clock_timestamp():1:1)"
pass "per-interval floor column gone, active_micros GENERATED ALWAYS, 045/051 unique indexes intact"

GENERATED_WRITE="$TMP_DIR/generated-write.log"
set +e
psql_in -q >"$GENERATED_WRITE" 2>&1 <<SQL
\set VERBOSITY verbose
BEGIN;
SET LOCAL row_security = off;
UPDATE work_host_usage_interval
   SET active_micros = 999999999
 WHERE usage_id = '$LEGACY_USAGE_ID';
ROLLBACK;
SQL
GENERATED_RC=$?
set -e
[ "$GENERATED_RC" -ne 0 ] || fail "direct write to the generated column was accepted"
grep -qE "428C9|can only be updated to DEFAULT" "$GENERATED_WRITE" \
  || fail "generated-column write failed for the wrong reason: $(tr '\n' ' ' <"$GENERATED_WRITE")"
pass "no statement can write active_micros — PostgreSQL rejects it by SQLSTATE 428C9"

# ---------------------------------------------------------------------------
# 5) Post-058 behaviour on the identical fixture.
# ---------------------------------------------------------------------------
if [ "${T3_PRECISION_PROVE_RED:-0}" = "interval-floor" ]; then
  log "red proof: flooring every interval again inside t3_terminate"
  psql_in -q <<'SQL'
DO $red$
DECLARE
  v_definition text;
  v_reverted text;
BEGIN
  v_definition :=
    pg_get_functiondef('t3_terminate(uuid,uuid,text)'::regprocedure);
  v_reverted := replace(
    v_definition,
    'sum(active_micros)',
    'sum((active_micros / 1000000) * 1000000)'
  );
  IF v_reverted = v_definition THEN
    RAISE EXCEPTION
      'red proof could not find the single-floor aggregation in t3_terminate';
  END IF;
  EXECUTE v_reverted;
END $red$;
SQL
fi

seed_session "$MICROS_HOST_ID" "$MICROS_SESSION_ID" "$MICROS_MESSAGE_ID" \
  "$MICROS_CLOUD_ID" "$MICROS_USAGE_ID" 4201
[ "$(settle "$MICROS_SESSION_ID")" = "t" ] || fail "post-058 settlement returned false"

SETTLED="$(sql_value -c "
  SELECT
    (SELECT active_micros FROM work_host_usage WHERE id = '$MICROS_USAGE_ID') || ':' ||
    (SELECT active_seconds FROM work_host_usage WHERE id = '$MICROS_USAGE_ID') || ':' ||
    (SELECT settled_reason FROM work_host_usage WHERE id = '$MICROS_USAGE_ID') || ':' ||
    (SELECT -delta_micro_usd FROM credit_entry
      WHERE ref_id = '$MICROS_SESSION_ID' AND reason = 't3_usage') || ':' ||
    (SELECT count(*) FROM work_host_usage_interval
      WHERE usage_id = '$MICROS_USAGE_ID') || ':' ||
    (SELECT count(*) FROM work_host_usage_interval
      WHERE usage_id = '$MICROS_USAGE_ID' AND state = 'paused'
        AND active_micros <> 0) || ':' ||
    (SELECT count(*) FROM work_host_usage_interval
      WHERE usage_id = '$MICROS_USAGE_ID' AND ended_at IS NULL);
")"
IFS=: read -r NEW_MICROS NEW_SECONDS NEW_REASON NEW_DEBIT \
  INTERVAL_COUNT PAUSED_NONZERO STILL_OPEN <<EOF
$SETTLED
EOF

[ "$INTERVAL_COUNT" = "$((ACTIVE_ROUNDS * 2))" ] \
  || fail "fixture wrote $INTERVAL_COUNT intervals, expected $((ACTIVE_ROUNDS * 2))"
[ "$STILL_OPEN" = "0" ] || fail "terminal statement left an interval open"
[ "$PAUSED_NONZERO" = "0" ] \
  || fail "paused interval billed non-zero — the structural pause-zero guarantee is broken"
[ "$NEW_REASON" = "ended" ] || fail "settled_reason changed: $NEW_REASON"
pass "a four-week pause closed by settlement still bills exactly zero"

# The loss assertion. Recovering ${EXPECTED_RECOVERED}s against the measured
# pre-058 number is the whole ticket; it is checked before the exact totals so
# a reverted aggregation fails by this name rather than by an arithmetic detail.
RECOVERED=$((NEW_SECONDS - LEGACY_SECONDS))
if [ "$NEW_SECONDS" != "$EXPECTED_MICROS_SECONDS" ] \
  || [ "$RECOVERED" != "$EXPECTED_RECOVERED" ]; then
  fail "interval-floor truncation loss: ${ACTIVE_ROUNDS} pause round trips billed ${NEW_SECONDS}s where the microsecond ledger owes ${EXPECTED_MICROS_SECONDS}s (pre-058 billed ${LEGACY_SECONDS}s; expected to recover ${EXPECTED_RECOVERED}s, recovered ${RECOVERED}s)"
fi
[ "$NEW_MICROS" = "$EXPECTED_TRUE_MICROS" ] \
  || fail "settled active_micros ${NEW_MICROS}, expected ${EXPECTED_TRUE_MICROS}"
RESIDUE=$((NEW_MICROS - NEW_SECONDS * 1000000))
{ [ "$RESIDUE" -ge 0 ] && [ "$RESIDUE" -lt 1000000 ]; } \
  || fail "settlement truncated more than once: residue ${RESIDUE}us"
[ "$NEW_DEBIT" = "$((EXPECTED_MICROS_SECONDS * UNIT_RATE))" ] \
  || fail "credit debit ${NEW_DEBIT}, expected $((EXPECTED_MICROS_SECONDS * UNIT_RATE))"
pass "${ACTIVE_ROUNDS} pause round trips recover ${RECOVERED}s; residue ${RESIDUE}us floored once; debit ${NEW_DEBIT}"

# ---------------------------------------------------------------------------
# 6) The single floor is a constraint, not a convention.
# ---------------------------------------------------------------------------
FLOOR_ONCE="$TMP_DIR/floor-once.log"
set +e
psql_in -q >"$FLOOR_ONCE" 2>&1 <<SQL
BEGIN;
SET LOCAL row_security = off;
UPDATE work_host_usage
   SET active_seconds = active_seconds - 1
 WHERE id = '$MICROS_USAGE_ID';
ROLLBACK;
SQL
FLOOR_RC=$?
set -e
[ "$FLOOR_RC" -ne 0 ] || fail "billed seconds were allowed to drift from the microsecond total"
grep -qF "work_host_usage_active_micros_ck" "$FLOOR_ONCE" \
  || fail "seconds/micros drift rejected without the named constraint: $(tr '\n' ' ' <"$FLOOR_ONCE")"
pass "work_host_usage_active_micros_ck pins active_seconds to floor(active_micros / 1000000)"

REPEAT="$(sql_value -c "
  SELECT t3_terminate('$WS_ID'::uuid, '$MICROS_SESSION_ID'::uuid, 'idle_timeout');
")"
AFTER_REPEAT="$(sql_value -c "
  SELECT
    (SELECT active_micros FROM work_host_usage WHERE id = '$MICROS_USAGE_ID') || ':' ||
    (SELECT active_seconds FROM work_host_usage WHERE id = '$MICROS_USAGE_ID') || ':' ||
    (SELECT settled_reason FROM work_host_usage WHERE id = '$MICROS_USAGE_ID') || ':' ||
    (SELECT count(*) FROM credit_entry
      WHERE ref_id = '$MICROS_SESSION_ID' AND reason = 't3_usage');
")"
[ "$REPEAT" = "t" ] || fail "re-termination did not report success: $REPEAT"
[ "$AFTER_REPEAT" = "$EXPECTED_TRUE_MICROS:$EXPECTED_MICROS_SECONDS:ended:1" ] \
  || fail "re-termination was not idempotent: $AFTER_REPEAT"
pass "re-terminating keeps the first reason, the micros total and the single debit"

pass "measured pre-058 loss -> 058 applied -> history untouched -> ${EXPECTED_RECOVERED}s recovered with one floor"

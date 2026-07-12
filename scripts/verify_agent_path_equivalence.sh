#!/usr/bin/env bash
# MOMO-352 / ADR-0102: prove that managed AgentWorker and BYOA gateway runs
# expose the same server-owned guarantee matrix.
#
# Each path is executed by its authoritative runtime verifier. Those verifiers
# own the detailed assertions; this script gives both a fresh marker/OID-owned
# database and per-run channel generation, then compares their normalized
# verdict manifests. A zero exit from a child is therefore evidence for the
# fields emitted below, not a replacement for the child DB/REST assertions.
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)

ENV_FILE=${ENV_FILE:-}
if [ "$ENV_FILE" = "" ]; then
  for candidate in "$REPO_ROOT/.env.worktree" "$REPO_ROOT/.env" "$REPO_ROOT/infra/.env.example"; do
    [ -f "$candidate" ] || continue
    ENV_FILE=$candidate
    break
  done
fi
if [ "$ENV_FILE" != "" ] && [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

require_bin() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[agent-path-equivalence] missing required command: $1" >&2
    exit 1
  fi
}

require_bin jq
require_bin python3

if command -v psql >/dev/null 2>&1; then
  PSQL_BIN=$(command -v psql)
elif [ -x /opt/homebrew/opt/libpq/bin/psql ]; then
  PSQL_BIN=/opt/homebrew/opt/libpq/bin/psql
elif [ -x /usr/local/opt/libpq/bin/psql ]; then
  PSQL_BIN=/usr/local/opt/libpq/bin/psql
else
  echo "[agent-path-equivalence] psql not found" >&2
  exit 1
fi

POSTGRES_HOST=${POSTGRES_HOST:-localhost}
POSTGRES_PORT=${POSTGRES_PORT:-5432}
POSTGRES_USER=${POSTGRES_USER:-momo}
POSTGRES_PASSWORD=${POSTGRES_PASSWORD:-momo_dev_pw}
SOURCE_POSTGRES_DB=${POSTGRES_DB:-momo}
SOURCE_DATABASE_URL=${DATABASE_URL:-}
RUN_UUID=$(python3 -c 'import uuid; print(uuid.uuid4())')
RUN_SUFFIX=$(printf '%s' "$RUN_UUID" | tr -d '-' | cut -c 1-12)
WORKER_MARKER_UUID=$(python3 -c 'import uuid; print(uuid.uuid4())')
GATEWAY_MARKER_UUID=$(python3 -c 'import uuid; print(uuid.uuid4())')
WORKER_DB=momo_path_eq_worker_${POSTGRES_PORT}_${RUN_SUFFIX}
GATEWAY_DB=momo_path_eq_gateway_${POSTGRES_PORT}_${RUN_SUFFIX}
WORKER_ROLLBACK_DB=momo_path_eq_worker_rb_${POSTGRES_PORT}_${RUN_SUFFIX}
GATEWAY_ROLLBACK_DB=momo_path_eq_gateway_rb_${POSTGRES_PORT}_${RUN_SUFFIX}

# Per-run channel IDs prevent Centrifugo version=seq history from treating a
# later verifier publication as stale. Swift UUID rendering is uppercase, so
# both normalized transport channel strings are explicitly uppercase here.
WORKER_MARKER=momo:agent-worker-verifier:v1:${WORKER_MARKER_UUID}
WORKER_NAMESPACE=$(printf '%s' "$WORKER_MARKER" | shasum -a 256 | cut -c 1-6)
WORKER_WORKSPACE_ID=00000000-0000-7000-8000-${WORKER_NAMESPACE}343001
WORKER_CHANNEL_ID=00000000-0000-7000-8000-${WORKER_NAMESPACE}343202
WORKER_CENT_CHANNEL=$(python3 -c 'import sys; print("ch:ws" + sys.argv[1].upper() + "." + sys.argv[2].upper())' "$WORKER_WORKSPACE_ID" "$WORKER_CHANNEL_ID")
GATEWAY_MARKER=momo:hermes-gateway-verifier:v1:${GATEWAY_MARKER_UUID}
GATEWAY_WORKSPACE_ID=00000000-0000-7000-8000-000000000001
GATEWAY_CHANNEL_ID=$(python3 -c 'import sys, uuid; print(uuid.uuid5(uuid.NAMESPACE_URL, sys.argv[1] + ":agent-lab-channel"))' "$GATEWAY_MARKER")
GATEWAY_CENT_CHANNEL=$(python3 -c 'import sys; print("agent:ws" + sys.argv[1].upper() + "." + sys.argv[2].upper() + "." + sys.argv[3].upper())' "$GATEWAY_WORKSPACE_ID" "$GATEWAY_CHANNEL_ID" 00000000-0000-7000-8000-000000000103)

TMP_ROOT=${TMPDIR:-/tmp}
WORKER_LOG=${TMP_ROOT}/momo-agent-path-equivalence-worker-${RUN_SUFFIX}.log
GATEWAY_LOG=${TMP_ROOT}/momo-agent-path-equivalence-gateway-${RUN_SUFFIX}.log
WORKER_EVIDENCE=${TMP_ROOT}/momo-agent-path-equivalence-worker-${RUN_SUFFIX}.json
GATEWAY_EVIDENCE=${TMP_ROOT}/momo-agent-path-equivalence-gateway-${RUN_SUFFIX}.json
WORKER_NORMALIZED=${TMP_ROOT}/momo-agent-path-equivalence-worker-${RUN_SUFFIX}.normalized.json
GATEWAY_NORMALIZED=${TMP_ROOT}/momo-agent-path-equivalence-gateway-${RUN_SUFFIX}.normalized.json
SOURCE_DIGEST_ARMED=0

admin_scalar() {
  output=$(PGPASSWORD="$POSTGRES_PASSWORD" "$PSQL_BIN" \
    -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d postgres \
    -t -A -v ON_ERROR_STOP=1 --no-psqlrc -c "$1") || return 1
  printf '%s' "$output" | tr -d '[:space:]'
}

database_count() {
  admin_scalar "SELECT count(*) FROM pg_database WHERE datname = '$1';"
}

assert_database_absent() {
  count=$(database_count "$1") || exit 1
  if [ "$count" != "0" ]; then
    echo "[agent-path-equivalence] verifier DB leaked or pre-existed: $1" >&2
    exit 1
  fi
}

source_digest() {
  output=$(PGPASSWORD="$POSTGRES_PASSWORD" "$PSQL_BIN" \
    -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d "$SOURCE_POSTGRES_DB" \
    -t -A -v ON_ERROR_STOP=1 --no-psqlrc <<'SQL'
SELECT encode(digest(concat_ws('|',
  (SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text, '[]') FROM outbox t),
  (SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text, '[]') FROM agent_run t),
  (SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text, '[]') FROM approval t),
  (SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text, '[]') FROM approval_decision t),
  (SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text, '[]') FROM usage_ledger t),
  (SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text, '[]') FROM budget_window t),
  (SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text, '[]') FROM audit_log t),
  (SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text, '[]') FROM message t)
), 'sha256'), 'hex');
SQL
  ) || return 1
  printf '%s' "$output" | tr -d '[:space:]'
}

validate_admin_target() {
  case "$POSTGRES_HOST" in
    localhost|127.0.0.1|::1) ;;
    *) echo "[agent-path-equivalence] verifier DB target must be loopback: $POSTGRES_HOST" >&2; exit 1 ;;
  esac
  if [ "$SOURCE_DATABASE_URL" != "" ]; then
    python3 - "$SOURCE_DATABASE_URL" "$POSTGRES_HOST" "$POSTGRES_PORT" "$SOURCE_POSTGRES_DB" <<'PY'
import sys
from urllib.parse import urlparse

url, expected_host, expected_port, expected_db = sys.argv[1:]
parsed = urlparse(url)
host = parsed.hostname or ""
port = parsed.port or 5432
database = parsed.path.lstrip("/")
if host not in {"localhost", "127.0.0.1", "::1"} or expected_host not in {"localhost", "127.0.0.1", "::1"}:
    raise SystemExit("[agent-path-equivalence] DATABASE_URL and admin target must be loopback")
if port != int(expected_port) or database != expected_db:
    raise SystemExit("[agent-path-equivalence] DATABASE_URL source does not match admin target")
PY
  fi
}

cleanup() {
  original_rc=$?
  cleanup_failed=0
  trap - EXIT
  if [ "$SOURCE_DIGEST_ARMED" = "1" ]; then
    source_after=$(source_digest) || cleanup_failed=1
    if [ "$cleanup_failed" = "0" ] && [ "$source_after" != "$SOURCE_DIGEST_BEFORE" ]; then
      echo "[agent-path-equivalence] source dogfood DB changed" >&2
      cleanup_failed=1
    elif [ "$cleanup_failed" = "0" ]; then
      echo "[agent-path-equivalence] source dogfood DB digest preserved"
    fi
  fi
  rm -f "$WORKER_LOG" "$GATEWAY_LOG" "$WORKER_EVIDENCE" "$GATEWAY_EVIDENCE" \
    "$WORKER_NORMALIZED" "$GATEWAY_NORMALIZED"
  if [ "$original_rc" = "0" ] && [ "$cleanup_failed" = "1" ]; then
    original_rc=1
  fi
  exit "$original_rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

run_pre_marker_rollback_regression() {
  assert_database_absent "$WORKER_ROLLBACK_DB"
  set +e
  AGENT_WORKER_VERIFIER_DB="$WORKER_ROLLBACK_DB" \
  AGENT_WORKER_VERIFIER_TEST_MARKER_UUID=$(python3 -c 'import uuid; print(uuid.uuid4())') \
  AGENT_WORKER_VERIFIER_TEST_FAIL_COMMENT=1 \
    "$REPO_ROOT/scripts/verify_agent_worker.sh" >/dev/null 2>&1
  rc=$?
  set -e
  [ "$rc" = "96" ] || { echo "[agent-path-equivalence] worker rollback expected exit 96, got $rc" >&2; exit 1; }
  assert_database_absent "$WORKER_ROLLBACK_DB"

  assert_database_absent "$GATEWAY_ROLLBACK_DB"
  set +e
  HERMES_GATEWAY_VERIFIER_DB="$GATEWAY_ROLLBACK_DB" \
  HERMES_GATEWAY_VERIFIER_TEST_MARKER_UUID=$(python3 -c 'import uuid; print(uuid.uuid4())') \
  HERMES_GATEWAY_VERIFIER_TEST_FAIL_COMMENT=1 \
    "$REPO_ROOT/scripts/verify_hermes_gateway_adapter.sh" >/dev/null 2>&1
  rc=$?
  set -e
  [ "$rc" = "96" ] || { echo "[agent-path-equivalence] gateway rollback expected exit 96, got $rc" >&2; exit 1; }
  assert_database_absent "$GATEWAY_ROLLBACK_DB"
  echo "[agent-path-equivalence] pre-marker rollback PASS: worker+gateway exit 96 removed exact OIDs"
}

run_worker_path() {
  assert_database_absent "$WORKER_DB"
  if ! AGENT_WORKER_VERIFIER_DB="$WORKER_DB" \
    AGENT_WORKER_VERIFIER_TEST_MARKER_UUID="$WORKER_MARKER_UUID" \
    AGENT_WORKER_VERIFIER_TEST_CLEANUP_ON_EXIT=1 \
    AGENT_WORKER_EQUIVALENCE_EVIDENCE_FILE="$WORKER_EVIDENCE" \
      "$REPO_ROOT/scripts/verify_agent_worker.sh" >"$WORKER_LOG" 2>&1; then
    echo "[agent-path-equivalence] worker mode failed" >&2
    tail -160 "$WORKER_LOG" >&2 || true
    exit 1
  fi
  grep -F "REST @agent-worker-verifier mention routing verified" "$WORKER_LOG" >/dev/null
  grep -F "success path verified:" "$WORKER_LOG" >/dev/null
  grep -F "MOMO-352 equivalence scenario verified:" "$WORKER_LOG" >/dev/null
  jq -e '.schema == "momo.agent_path_equivalence.v1" and .observational.path == "worker"' \
    "$WORKER_EVIDENCE" >/dev/null
  assert_database_absent "$WORKER_DB"
}

run_gateway_path() {
  assert_database_absent "$GATEWAY_DB"
  if ! HERMES_GATEWAY_VERIFIER_DB="$GATEWAY_DB" \
    HERMES_GATEWAY_VERIFIER_TEST_MARKER_UUID="$GATEWAY_MARKER_UUID" \
    HERMES_GATEWAY_EQUIVALENCE_EVIDENCE_FILE="$GATEWAY_EVIDENCE" \
      "$REPO_ROOT/scripts/verify_hermes_gateway_adapter.sh" >"$GATEWAY_LOG" 2>&1; then
    echo "[agent-path-equivalence] gateway mode failed" >&2
    tail -160 "$GATEWAY_LOG" >&2 || true
    exit 1
  fi
  grep -F "[hermes-gateway] PASS:" "$GATEWAY_LOG" >/dev/null
  jq -e '.schema == "momo.agent_path_equivalence.v1" and .observational.path == "gateway"' \
    "$GATEWAY_EVIDENCE" >/dev/null
  assert_database_absent "$GATEWAY_DB"
}

normalize_evidence() {
  input=$1
  output=$2
  # ADR-0102 allowlist. These are transport observations, never server-owned
  # guarantee fields: wall-clock timing, provider metadata, and lease columns.
  # Path/channel identity is also per-run isolation metadata. No other field is
  # removed; adding a difference requires editing this explicit allowlist.
  jq -S 'del(
    .observational.completed_at,
    .observational.provider_metadata,
    .observational.lease_model,
    .observational.path,
    .observational.cent_channel
  )' "$input" >"$output"
}

validate_admin_target
SOURCE_DIGEST_BEFORE=$(source_digest)
SOURCE_DIGEST_ARMED=1
run_pre_marker_rollback_regression
run_worker_path
run_gateway_path

if [ "$(jq -r '.observational.cent_channel' "$WORKER_EVIDENCE")" != "$WORKER_CENT_CHANNEL" ]; then
  echo "[agent-path-equivalence] worker per-run uppercase channel mismatch" >&2
  exit 1
fi
if [ "$(jq -r '.observational.cent_channel' "$GATEWAY_EVIDENCE")" != "$GATEWAY_CENT_CHANNEL" ]; then
  echo "[agent-path-equivalence] gateway per-run uppercase channel mismatch" >&2
  exit 1
fi
normalize_evidence "$WORKER_EVIDENCE" "$WORKER_NORMALIZED"
normalize_evidence "$GATEWAY_EVIDENCE" "$GATEWAY_NORMALIZED"

if ! cmp -s "$WORKER_NORMALIZED" "$GATEWAY_NORMALIZED"; then
  echo "[agent-path-equivalence] server guarantee matrix drifted" >&2
  diff -u "$WORKER_NORMALIZED" "$GATEWAY_NORMALIZED" >&2 || true
  exit 1
fi

echo "[agent-path-equivalence] PASS: worker and gateway server guarantees are equivalent"
echo "[agent-path-equivalence] scenario=trigger->approval->resume->final run_states=queued,running,awaiting_approval,queued,running,succeeded"
echo "[agent-path-equivalence] compared=approval+usage_ledger+audit_log+durable_message+realtime_publication"
echo "[agent-path-equivalence] allowlist=timing,provider_metadata,lease_columns,path_channel_identity"

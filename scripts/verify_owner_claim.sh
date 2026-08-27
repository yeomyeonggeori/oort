#!/usr/bin/env bash
# #1651 / ADR-0166 — isolated PostgreSQL 18 first-owner claim verifier.
# #1673 — also runs the real momo-migrate MOMO_BOOTSTRAP_CLAIM=1 path (the
# gap that let `ttl_seconds` SELECT INTO ambiguity land).
#
# Ownership contract matches scripts/verify_hosted_disconnect.sh: invocation
# nonce label, janitor label, refusal of an external DATABASE_URL, trap cleanup.
set -euo pipefail
umask 077

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

if [ -n "${DATABASE_URL:-}" ] || [ -n "${OWNER_CLAIM_DATABASE_URL:-}" ]; then
  echo "[owner-claim] external DATABASE_URL is forbidden; isolated Docker is mandatory" >&2
  exit 1
fi
for command_name in cargo docker python3; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "[owner-claim] missing required command: $command_name" >&2
    exit 1
  }
done
if command -v psql >/dev/null 2>&1; then
  PSQL_DIR="$(dirname "$(command -v psql)")"
elif [ -x /opt/homebrew/opt/libpq/bin/psql ]; then
  PSQL_DIR=/opt/homebrew/opt/libpq/bin
elif [ -x /usr/local/opt/libpq/bin/psql ]; then
  PSQL_DIR=/usr/local/opt/libpq/bin
else
  echo "[owner-claim] psql not found" >&2
  exit 1
fi
export PATH="$PSQL_DIR:$PATH"

DOCKER_BIN="${DOCKER_BIN:-docker}"
PG_IMAGE="pgvector/pgvector:0.8.5-pg18-trixie@sha256:9d2e61c7352b9e9f4798df5fd9a498f043f4cda1cdacc707de3d198650f4321e"
PG_PORT="${OWNER_CLAIM_PG_PORT:-28206}"
NAME_PREFIX="${OWNER_CLAIM_PROJECT:-w1651-owner-claim}"
OWNERSHIP_LABEL=com.momo.owner-claim.invocation
INVOCATION_ID="$(python3 -c 'import secrets; print(secrets.token_hex(16))')"
[[ "$INVOCATION_ID" =~ ^[0-9a-f]{32}$ ]] || {
  echo "[owner-claim] failed to create invocation identity" >&2
  exit 1
}
[[ "$NAME_PREFIX" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,70}$ ]] || exit 1
[[ "$PG_PORT" =~ ^[0-9]+$ ]] || exit 1
PG_CONTAINER="${NAME_PREFIX}-${INVOCATION_ID}-pg"
PG_CONTAINER_ID=""
MUTATION_STARTED=0
CLEANUP_DONE=0
ENV_FILE=""
MIGRATE_LOG=""

fail() {
  printf '[owner-claim] FAIL: %s\n' "$*" >&2
  exit 1
}

container_refs() { "$DOCKER_BIN" ps -aq --no-trunc; }
label_refs() {
  "$DOCKER_BIN" ps -aq --no-trunc --filter "label=$OWNERSHIP_LABEL=$INVOCATION_ID"
}
valid_id() { [[ "$1" =~ ^[0-9a-f]{64}$ ]]; }

container_state() {
  local ref="$1" format="$2" output_var="$3" output refs grep_rc=0
  output="$("$DOCKER_BIN" inspect --format "$format" "$ref" 2>/dev/null)" && {
    printf -v "$output_var" '%s' "$output"
    return 0
  }
  refs="$(container_refs 2>/dev/null)" || return 2
  grep -Fqx -- "$ref" <<<"$refs" || grep_rc=$?
  case "$grep_rc" in 0) return 2 ;; 1) ;; *) return 2 ;; esac
  printf -v "$output_var" '%s' ''
  return 1
}

verify_binding() {
  local binding='' by_name='' labels=''
  container_state "$PG_CONTAINER_ID" \
    '{{.Id}}|{{.Name}}|{{index .Config.Labels "com.momo.owner-claim.invocation"}}' binding || return 1
  [ "$binding" = "$PG_CONTAINER_ID|/$PG_CONTAINER|$INVOCATION_ID" ] || return 1
  container_state "$PG_CONTAINER" '{{.Id}}' by_name || return 1
  [ "$by_name" = "$PG_CONTAINER_ID" ] || return 1
  labels="$(label_refs)" || return 1
  [ "$labels" = "$PG_CONTAINER_ID" ]
}

remove_owned() {
  local ignored='' rc=0 labels=''
  verify_binding || return 1
  "$DOCKER_BIN" rm -f -v "$PG_CONTAINER_ID" >/dev/null || return 1
  container_state "$PG_CONTAINER_ID" '{{.Id}}' ignored || rc=$?
  [ "$rc" -eq 1 ] || return 1
  rc=0
  container_state "$PG_CONTAINER" '{{.Id}}' ignored || rc=$?
  [ "$rc" -eq 1 ] || return 1
  labels="$(label_refs)" || return 1
  [ -z "$labels" ]
}

cleanup() {
  local rc=$? labels=''
  trap - EXIT INT TERM
  if [ -n "$ENV_FILE" ] && [ -f "$ENV_FILE" ]; then
    rm -f -- "$ENV_FILE" || { [ "$rc" -ne 0 ] || rc=1; }
  fi
  if [ -n "$MIGRATE_LOG" ] && [ -f "$MIGRATE_LOG" ]; then
    rm -f -- "$MIGRATE_LOG" || { [ "$rc" -ne 0 ] || rc=1; }
  fi
  if [ "$CLEANUP_DONE" -eq 0 ] && [ "$MUTATION_STARTED" -eq 1 ]; then
    if [ -z "$PG_CONTAINER_ID" ]; then
      labels="$(label_refs 2>/dev/null)" || { [ "$rc" -ne 0 ] || rc=1; exit "$rc"; }
      if [ -n "$labels" ] && [ "$(printf '%s\n' "$labels" | wc -l | tr -d ' ')" -eq 1 ]; then
        PG_CONTAINER_ID="$labels"
      fi
    fi
    if [ -n "$PG_CONTAINER_ID" ] && remove_owned; then
      CLEANUP_DONE=1
    else
      [ "$rc" -ne 0 ] || rc=1
    fi
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

ENV_FILE="$(mktemp "${TMPDIR:-/tmp}/momo-owner-claim-env.XXXXXX")"
chmod 600 "$ENV_FILE"
printf '%s\n' POSTGRES_DB=momo POSTGRES_USER=momo POSTGRES_PASSWORD=momo >"$ENV_FILE"
MUTATION_STARTED=1
PG_CONTAINER_ID="$("$DOCKER_BIN" run -d --name "$PG_CONTAINER" \
  --label com.momo.janitor.managed=true \
  --label "$OWNERSHIP_LABEL=$INVOCATION_ID" \
  --env-file "$ENV_FILE" \
  -p "127.0.0.1:${PG_PORT}:5432" "$PG_IMAGE")"
rm -f -- "$ENV_FILE"
ENV_FILE=""
valid_id "$PG_CONTAINER_ID" || { PG_CONTAINER_ID=""; exit 1; }
verify_binding || { echo "[owner-claim] ownership proof failed" >&2; exit 1; }

for attempt in $(seq 1 60); do
  : "$attempt"
  "$DOCKER_BIN" exec "$PG_CONTAINER_ID" pg_isready -U momo -d momo >/dev/null 2>&1 && break
  sleep 1
done
"$DOCKER_BIN" exec "$PG_CONTAINER_ID" pg_isready -U momo -d momo >/dev/null

export DATABASE_URL="postgres://momo:momo@127.0.0.1:${PG_PORT}/momo"
export MOMO_APP_PASSWORD=momo_app_dev_pw
export MOMO_RELAY_PASSWORD=momo_relay_dev_pw
export MOMO_WORKER_PASSWORD=momo_worker_dev_pw
export PGHOST=127.0.0.1 PGPORT="$PG_PORT" PGDATABASE=momo PGUSER=momo PGPASSWORD=momo

# #1673 — real momo-migrate with MOMO_BOOTSTRAP_CLAIM=1. The cargo test below
# mints tokens in-process and never executes bootstrap_owner_claim_if_absent.sql,
# which is how `column reference "ttl_seconds" is ambiguous` shipped.
CLAIM_EMAIL="claim-${INVOCATION_ID}@momo.local"
MIGRATE_LOG="$(mktemp "${TMPDIR:-/tmp}/momo-owner-claim-migrate.XXXXXX")"
chmod 600 "$MIGRATE_LOG"
set +e
env -u MOMO_INITIAL_OWNER_PASSWORD \
  -u MOMO_IN_CONTAINER \
  -u MOMO_BOOTSTRAP_OWNER_CLAIM_SQL \
  -u MOMO_BOOTSTRAP_OWNER_SQL \
  -u MOMO_SET_OWNER_SQL \
  DATABASE_URL="$DATABASE_URL" \
  MOMO_ENV=test \
  MOMO_AGENT_SEED_MODE=none \
  MOMO_BOOTSTRAP_CLAIM=1 \
  MOMO_INITIAL_OWNER_EMAIL="$CLAIM_EMAIL" \
  MOMO_BOOTSTRAP_RUNTIME_ROLES=1 \
  MOMO_PITR_EVIDENCE_REQUIRED=0 \
  MOMO_PITR_BOOTSTRAP_EMPTY=0 \
  CARGO_TERM_COLOR=never \
  cargo run --manifest-path "$REPO_ROOT/server-rust/Cargo.toml" \
    -p momo-migrate --quiet --bin momo-migrate -- migrate \
  >"$MIGRATE_LOG" 2>&1
migrate_rc=$?
set -e
if [ "$migrate_rc" -ne 0 ]; then
  printf '[owner-claim] momo-migrate exited %s; log follows\n' "$migrate_rc" >&2
  cat "$MIGRATE_LOG" >&2
  fail "MOMO_BOOTSTRAP_CLAIM=1 migrate did not finish (claim path not created)"
fi
grep -Fq 'MOMO_BOOTSTRAP_CLAIM=created' "$MIGRATE_LOG" || {
  cat "$MIGRATE_LOG" >&2
  fail "migrate log missing MOMO_BOOTSTRAP_CLAIM=created"
}
if grep -Fq 'column reference "ttl_seconds" is ambiguous' "$MIGRATE_LOG"; then
  cat "$MIGRATE_LOG" >&2
  fail "migrate log still reports ttl_seconds SELECT INTO ambiguity"
fi
claim_path_line="$(grep -E '^MOMO_CLAIM_PATH=/claim/[A-Za-z0-9_-]{43}$' "$MIGRATE_LOG" || true)"
[ -n "$claim_path_line" ] || {
  cat "$MIGRATE_LOG" >&2
  fail "migrate log missing MOMO_CLAIM_PATH=/claim/<token>"
}
CLAIM_TOKEN="${claim_path_line#MOMO_CLAIM_PATH=/claim/}"
if grep -F "$CLAIM_TOKEN" "$MIGRATE_LOG" | grep -v -F "MOMO_CLAIM_PATH=/claim/${CLAIM_TOKEN}" | grep -q .; then
  fail "raw claim token leaked outside MOMO_CLAIM_PATH"
fi
CHECK_EMAIL="$CLAIM_EMAIL"
CHECK_TOKEN="$CLAIM_TOKEN"
export CHECK_EMAIL CHECK_TOKEN
claim_state="$(psql -qAt -v ON_ERROR_STOP=1 --no-psqlrc <<'SQL'
\getenv check_email CHECK_EMAIL
\getenv check_token CHECK_TOKEN
SET app.workspace_id = '00000000-0000-7000-8000-000000000001';
SELECT
  (SELECT count(*)::text FROM human h
    WHERE h.member_id = '00000000-0000-7000-8000-000000000101'
      AND h.workspace_id = '00000000-0000-7000-8000-000000000001'
      AND h.email = lower(btrim(:'check_email'))
      AND h.email_verified
      AND (h.password_hash IS NULL OR h.password_hash = '')),
  (SELECT count(*)::text FROM credential_claim c
    WHERE c.workspace_id = '00000000-0000-7000-8000-000000000001'
      AND c.member_id = '00000000-0000-7000-8000-000000000101'
      AND c.kind = 'owner_bootstrap'
      AND c.consumed_at IS NULL
      AND c.expires_at > now() + interval '23 hours'
      AND c.expires_at < now() + interval '25 hours'
      AND c.token_hash = digest(:'check_token', 'sha256'));
SQL
)"
claim_state="$(printf '%s' "$claim_state" | tr -d '[:space:]')"
[ "$claim_state" = "1|1" ] || fail "migrate did not plant claim-pending owner + live owner_bootstrap claim (got ${claim_state:-<empty>})"
rm -f -- "$MIGRATE_LOG"
MIGRATE_LOG=""
echo "[owner-claim] migrate-time bootstrap planted claim-pending owner + credential_claim(owner_bootstrap)"

(
  cd server-rust
  cargo test -p momo-server --test claim_conformance_pg \
    -- --ignored --test-threads=1 --nocapture
  cargo test -p momo-server --test password_reset_conformance_pg \
    -- --ignored --test-threads=1 --nocapture
)

remove_owned
CLEANUP_DONE=1
echo "[owner-claim] PASS PG18 migrate-time bootstrap plus issue/login-reject/consume/login/reuse/ttl/hash-only/log-redaction plus #1767 password-reset red/green"

#!/usr/bin/env bash
# #1358 — isolated Rust/PostgreSQL agent credential lifecycle verifier.
#
# This gate never invokes the retired Swift server. It gives the ignored Rust
# conformance test a fresh pinned PostgreSQL 18 database, production-like
# momo_app NOBYPASSRLS role, and nothing else.
set -euo pipefail
umask 077

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

command -v cargo >/dev/null 2>&1 || {
  echo "[agent-credentials-rust] missing required command: cargo" >&2
  exit 1
}

if command -v psql >/dev/null 2>&1; then
  PSQL_DIR="$(dirname "$(command -v psql)")"
elif [ -x /opt/homebrew/opt/libpq/bin/psql ]; then
  PSQL_DIR=/opt/homebrew/opt/libpq/bin
elif [ -x /usr/local/opt/libpq/bin/psql ]; then
  PSQL_DIR=/usr/local/opt/libpq/bin
else
  echo "[agent-credentials-rust] psql not found; install PostgreSQL 18/libpq." >&2
  exit 1
fi
export PATH="$PSQL_DIR:$PATH"

run_suite() {
  (
    cd server-rust
    cargo test -p momo-server --test agent_credential_conformance_pg \
      -- --ignored --test-threads=1 --nocapture
  )
}

# This verifier is intentionally Docker-only. Accepting an arbitrary database
# URL makes a destructive migration/test suite impossible to distinguish from
# a production database, even with an acknowledgement flag. Keep the trust
# boundary small: every run creates one empty, high-entropy-named PG18 instance.
if [ -n "${AGENT_CREDENTIALS_RUST_DATABASE_URL:-}" ] || [ -n "${DATABASE_URL:-}" ]; then
  echo "[agent-credentials-rust] external DATABASE_URL is forbidden; isolated Docker is mandatory" >&2
  exit 1
fi

command -v docker >/dev/null 2>&1 || {
  echo "[agent-credentials-rust] missing required command: docker" >&2
  exit 1
}
command -v openssl >/dev/null 2>&1 || {
  echo "[agent-credentials-rust] missing required command: openssl" >&2
  exit 1
}

PROJECT_PREFIX="${AGENT_CREDENTIALS_RUST_PROJECT:-w1358-agent-credentials-verify}"
PG_PORT="${AGENT_CREDENTIALS_RUST_PG_PORT:-24538}"
PG_IMAGE="pgvector/pgvector:0.8.5-pg18-trixie@sha256:9d2e61c7352b9e9f4798df5fd9a498f043f4cda1cdacc707de3d198650f4321e"
KEEP_STACK="${AGENT_CREDENTIALS_RUST_KEEP_STACK:-0}"
OWNERSHIP_LABEL="com.momo.agent-credentials.invocation"
DOCKER_BIN="${DOCKER_BIN:-docker}"

# Every invocation gets an unguessable name and an independent ownership
# capability. A caller-supplied project prefix is only a readable prefix; it
# can never make the final container name predictable.
INVOCATION_ID="$(openssl rand -hex 16)"
if ! [[ "$INVOCATION_ID" =~ ^[0-9a-f]{32}$ ]]; then
  echo "[agent-credentials-rust] openssl did not return a 128-bit invocation id" >&2
  exit 1
fi
if ! [[ "$PROJECT_PREFIX" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,70}$ ]]; then
  echo "[agent-credentials-rust] project prefix must be 1..71 safe name characters" >&2
  exit 1
fi
PG_CONTAINER="${PROJECT_PREFIX}-${INVOCATION_ID}-pg"
PG_CONTAINER_ID=""

case "$PG_PORT" in
  ''|*[!0-9]*)
    echo "[agent-credentials-rust] PG port must be decimal: $PG_PORT" >&2
    exit 1
    ;;
esac
if [ "$KEEP_STACK" != "0" ]; then
  echo "[agent-credentials-rust] KEEP_STACK is forbidden: retained stacks are non-evidence and cannot produce PASS" >&2
  exit 1
fi

valid_container_id() { [[ "$1" =~ ^[0-9a-f]{64}$ ]]; }

container_refs() { "$DOCKER_BIN" ps -aq --no-trunc; }

# 0=present/readable, 1=absence proved by a successful full list, 2=ambiguous
# daemon/inspect/list error. Cleanup must never collapse 2 into absence.
container_query_state() {
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

label_refs() {
  "$DOCKER_BIN" ps -aq --no-trunc --filter "label=$OWNERSHIP_LABEL=$INVOCATION_ID"
}

verify_owned_binding() {
  local binding='' name_binding='' label_list='' rc=0
  container_query_state "$PG_CONTAINER_ID" \
    '{{.Id}}|{{.Name}}|{{index .Config.Labels "com.momo.agent-credentials.invocation"}}' binding || rc=$?
  [ "$rc" -eq 0 ] || return 1
  [ "$binding" = "$PG_CONTAINER_ID|/$PG_CONTAINER|$INVOCATION_ID" ] || return 1
  rc=0
  container_query_state "$PG_CONTAINER" '{{.Id}}' name_binding || rc=$?
  [ "$rc" -eq 0 ] && [ "$name_binding" = "$PG_CONTAINER_ID" ] || return 1
  label_list="$(label_refs)" || return 1
  [ "$label_list" = "$PG_CONTAINER_ID" ]
}

remove_owned_container() {
  local query_output='' rc=0 label_list=''
  verify_owned_binding || {
    echo "[agent-credentials-rust] cleanup ownership check failed; refusing container removal" >&2
    return 1
  }
  "$DOCKER_BIN" rm -f -v "$PG_CONTAINER_ID" >/dev/null || return 1
  container_query_state "$PG_CONTAINER_ID" '{{.Id}}' query_output || rc=$?
  : "$query_output"
  [ "$rc" -eq 1 ] || return 1
  rc=0
  container_query_state "$PG_CONTAINER" '{{.Id}}' query_output || rc=$?
  : "$query_output"
  [ "$rc" -eq 1 ] || return 1
  label_list="$(label_refs)" || return 1
  [ -z "$label_list" ]
}

MUTATION_STARTED=0
CLEANUP_DONE=0
ENV_FILE=""
ENV_FILE_ID=""

file_identity() {
  stat -f '%d:%i:%u:%Lp' -- "$1" 2>/dev/null || stat -c '%d:%i:%u:%a' -- "$1" 2>/dev/null
}

remove_private_env_file() {
  [ -n "$ENV_FILE" ] || return 0
  case "$ENV_FILE" in "${TMPDIR:-/tmp}"/momo-agent-credentials-env.*) ;; *) return 1 ;; esac
  if [ -e "$ENV_FILE" ] || [ -L "$ENV_FILE" ]; then
    [ -f "$ENV_FILE" ] && [ ! -L "$ENV_FILE" ] && [ "$(file_identity "$ENV_FILE")" = "$ENV_FILE_ID" ] || return 1
    rm -f -- "$ENV_FILE" || return 1
  fi
  ENV_FILE=""
}

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if ! remove_private_env_file; then
    [ "$rc" -ne 0 ] || rc=1
  fi
  if [ "$CLEANUP_DONE" -eq 0 ] && [ "$MUTATION_STARTED" -eq 1 ]; then
    if [ -z "$PG_CONTAINER_ID" ]; then
      # docker run may have mutated before returning. Rediscover only the exact
      # high-entropy name + nonce label; ambiguity remains red and untouched.
      local candidate='' label_list=''
      label_list="$(label_refs)" || { [ "$rc" -ne 0 ] || rc=1; exit "$rc"; }
      if [ -n "$label_list" ]; then
        [ "$(printf '%s\n' "$label_list" | wc -l | tr -d ' ')" -eq 1 ] || { [ "$rc" -ne 0 ] || rc=1; exit "$rc"; }
        candidate="$label_list"
        PG_CONTAINER_ID="$candidate"
      fi
    fi
    if [ -n "$PG_CONTAINER_ID" ] && ! remove_owned_container; then
      [ "$rc" -ne 0 ] || rc=1
    else
      CLEANUP_DONE=1
    fi
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

ENV_FILE="$(mktemp "${TMPDIR:-/tmp}/momo-agent-credentials-env.XXXXXX")"
chmod 600 "$ENV_FILE"
ENV_FILE_ID="$(file_identity "$ENV_FILE")"
printf '%s\n' 'POSTGRES_DB=momo' 'POSTGRES_USER=momo' 'POSTGRES_PASSWORD=momo' >"$ENV_FILE"
MUTATION_STARTED=1
PG_CONTAINER_ID="$("$DOCKER_BIN" run -d --name "$PG_CONTAINER" \
  --label com.momo.janitor.managed=true \
  --label "$OWNERSHIP_LABEL=$INVOCATION_ID" \
  --env-file "$ENV_FILE" \
  -p "127.0.0.1:${PG_PORT}:5432" \
  "$PG_IMAGE")"
remove_private_env_file
if ! valid_container_id "$PG_CONTAINER_ID"; then
  echo "[agent-credentials-rust] docker run returned an invalid container id" >&2
  # Never inspect/remove by malformed daemon output. The armed EXIT path may
  # reacquire only the exact high-entropy label, then re-prove name+label+ID.
  PG_CONTAINER_ID=""
  exit 1
fi
verify_owned_binding || {
  echo "[agent-credentials-rust] created container ownership could not be proven" >&2
  exit 1
}

for attempt in $(seq 1 60); do
  : "$attempt"
  if "$DOCKER_BIN" exec "$PG_CONTAINER_ID" pg_isready -U momo -d momo >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
"$DOCKER_BIN" exec "$PG_CONTAINER_ID" pg_isready -U momo -d momo >/dev/null

export DATABASE_URL="postgres://momo:momo@127.0.0.1:${PG_PORT}/momo"
export MOMO_APP_PASSWORD="momo_app_dev_pw"
export PGHOST="127.0.0.1"
export PGPORT="$PG_PORT"
export PGDATABASE="momo"
export PGUSER="momo"
export PGPASSWORD="momo"

run_suite

# A green suite is not PASS until normal-path teardown proves immutable-id,
# exact-name, and nonce-label absence. EXIT cleanup remains only a backup.
remove_owned_container
CLEANUP_DONE=1
echo "[agent-credentials-rust] PASS issue/list/rotate/revoke + RLS/auth/audit contract"

#!/usr/bin/env bash
# #1366 — isolated PostgreSQL 18 Agent Port tool-surface verifier (HAP-E5).
#
# Ownership contract is scripts/verify_hosted_agent_inbox.sh's, unchanged: an
# invocation nonce label, the janitor label, refusal of an external DATABASE_URL,
# trap cleanup, and a tri-state absence proof before PASS. `--verify-cleanup-
# contract` runs that proof against a fake docker so the reclamation logic is
# itself tested without a daemon.
set -euo pipefail
umask 077

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

if [ -n "${DATABASE_URL:-}" ] || [ -n "${AGENT_PORT_TOOLS_DATABASE_URL:-}" ]; then
  echo "[agent-port-tools] external DATABASE_URL is forbidden; isolated Docker is mandatory" >&2
  exit 1
fi
for command_name in cargo docker openssl; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "[agent-port-tools] missing required command: $command_name" >&2
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
  echo "[agent-port-tools] psql not found" >&2
  exit 1
fi
export PATH="$PSQL_DIR:$PATH"

DOCKER_BIN="${DOCKER_BIN:-docker}"
PG_IMAGE="pgvector/pgvector:0.8.5-pg18-trixie@sha256:9d2e61c7352b9e9f4798df5fd9a498f043f4cda1cdacc707de3d198650f4321e"
PG_PORT="${AGENT_PORT_TOOLS_PG_PORT:-24567}"
NAME_PREFIX="${AGENT_PORT_TOOLS_PROJECT:-w1366-agent-port-tools}"
OWNERSHIP_LABEL=com.momo.agent-port-tools.invocation
INVOCATION_ID="$(${DOCKER_BIN} version >/dev/null 2>&1 && openssl rand -hex 16)"
[[ "$INVOCATION_ID" =~ ^[0-9a-f]{32}$ ]] || {
  echo "[agent-port-tools] failed to create invocation identity" >&2
  exit 1
}
[[ "$NAME_PREFIX" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,70}$ ]] || exit 1
[[ "$PG_PORT" =~ ^[0-9]+$ ]] || exit 1
PG_CONTAINER="${NAME_PREFIX}-${INVOCATION_ID}-pg"
PG_CONTAINER_ID=""
MUTATION_STARTED=0
CLEANUP_DONE=0
ENV_FILE=""

container_refs() { "$DOCKER_BIN" ps -aq --no-trunc; }
label_refs() {
  "$DOCKER_BIN" ps -aq --no-trunc --filter "label=$OWNERSHIP_LABEL=$INVOCATION_ID"
}
valid_id() { [[ "$1" =~ ^[0-9a-f]{64}$ ]]; }

# 0=present, 1=proven absent, 2=daemon/read ambiguity.
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
    '{{.Id}}|{{.Name}}|{{index .Config.Labels "com.momo.agent-port-tools.invocation"}}' binding || return 1
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

verify_cleanup_contract() {
  local original_docker="$DOCKER_BIN" state fake rc=0 ignored=''
  state="$(mktemp -d "${TMPDIR:-/tmp}/momo-agent-port-tools-cleanup.XXXXXX")"
  fake="$REPO_ROOT/scripts/tests/fake_agent_port_tools_docker.sh"
  chmod 755 "$fake"
  export FAKE_DOCKER_STATE="$state"
  FAKE_DOCKER_ID="$(printf 'b%.0s' $(seq 1 64))"
  export FAKE_DOCKER_ID
  export FAKE_DOCKER_NAME="$PG_CONTAINER" FAKE_DOCKER_NONCE="$INVOCATION_ID"
  DOCKER_BIN="$fake"
  PG_CONTAINER_ID="$FAKE_DOCKER_ID"

  touch "$state/present" "$state/inspect_error"
  container_state "$PG_CONTAINER_ID" '{{.Id}}' ignored || rc=$?
  [ "$rc" -eq 2 ] || { DOCKER_BIN="$original_docker"; rm -f "$state"/*; rmdir "$state"; return 1; }
  touch "$state/list_error"
  rc=0; container_state "$PG_CONTAINER" '{{.Id}}' ignored || rc=$?
  [ "$rc" -eq 2 ] || { DOCKER_BIN="$original_docker"; rm -f "$state"/*; rmdir "$state"; return 1; }
  rm -f "$state/inspect_error" "$state/list_error"
  verify_binding
  touch "$state/remove_lie"
  ! remove_owned
  rm -f "$state/remove_lie"
  remove_owned
  [ ! -e "$state/present" ]
  DOCKER_BIN="$original_docker"
  rmdir "$state"
  echo "[agent-port-tools] PASS daemon-free cleanup tri-state/removal contract"
}

if [ "${1:-}" = "--verify-cleanup-contract" ]; then
  verify_cleanup_contract
  exit 0
fi

cleanup() {
  local rc=$? labels=''
  trap - EXIT INT TERM
  if [ -n "$ENV_FILE" ] && [ -f "$ENV_FILE" ]; then
    rm -f -- "$ENV_FILE" || { [ "$rc" -ne 0 ] || rc=1; }
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

ENV_FILE="$(mktemp "${TMPDIR:-/tmp}/momo-agent-port-tools-env.XXXXXX")"
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
verify_binding || { echo "[agent-port-tools] ownership proof failed" >&2; exit 1; }

for attempt in $(seq 1 60); do
  : "$attempt"
  "$DOCKER_BIN" exec "$PG_CONTAINER_ID" pg_isready -U momo -d momo >/dev/null 2>&1 && break
  sleep 1
done
"$DOCKER_BIN" exec "$PG_CONTAINER_ID" pg_isready -U momo -d momo >/dev/null

export DATABASE_URL="postgres://momo:momo@127.0.0.1:${PG_PORT}/momo"
export MOMO_APP_PASSWORD=momo_app_dev_pw
export HOSTED_INBOX_MIGRATIONS_DIR="$REPO_ROOT/server/Migrations"
export PGHOST=127.0.0.1 PGPORT="$PG_PORT" PGDATABASE=momo PGUSER=momo PGPASSWORD=momo
# The production delivery gate is NOT exported here. Every fixture that needs it
# opens the selector through the synthetic `AgentPortConfig` override in the test
# binary, so no environment on this machine can turn hosted delivery on by
# accident before #1367 lands.
(
  cd server-rust
  # Layer 1 — the DB-level producer closures (migration 071) plus HAP-E4's own
  # token audience/actor/connection axes.
  cargo test -p momo-messaging --test hosted_inbox_producer_pg \
    -- --ignored --test-threads=1 --nocapture
  # Layer 2 — the real Axum router: catalog intersection per lifecycle state,
  # all eight tools, single write path, lease races, terminal rules, the mixed
  # managed+hosted workspace and the inactive-hosted no-fallback proof.
  cargo test -p momo-server --test agent_port_tools_conformance_pg \
    -- --ignored --test-threads=1 --nocapture
)

remove_owned
CLEANUP_DONE=1
echo "[agent-port-tools] PASS PG18 tool catalog/scope-intersection/single-write-path/lease/run/selector contract"

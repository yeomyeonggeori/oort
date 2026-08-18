#!/usr/bin/env bash
# #1367 — isolated PostgreSQL 18 hosted-agent disconnect verifier (HAP-E6).
#
# Ownership contract is scripts/verify_agent_port_tools.sh's, unchanged: an
# invocation nonce label, the janitor label, refusal of an external DATABASE_URL,
# trap cleanup, and a tri-state absence proof before PASS. `--verify-cleanup-
# contract` runs that proof against the same fake docker the E5 verifier uses
# (scripts/tests/fake_agent_port_tools_docker.sh — it is parameterized by env and
# is deliberately not copied per verifier), so the reclamation logic is itself
# tested without a daemon.
#
# What the fixtures prove, and why each one needs a real database:
#   * the disconnect START is one transaction — revoke, `cleanup_pending`, pause,
#     open-job suppression, lease release, manifest seed, one audit row — and a
#     forced failure inside it rolls every effect back;
#   * every old capability closes at once: all eight Agent Port tools, the
#     gateway lease verbs with a handle claimed a moment earlier, the inbox
#     cursor, and the foundation request itself;
#   * the #1344 negatives: a connector uninstall never resolves the local plugin
#     files, and an inactive routine is an observation rather than a removal;
#   * a bot resolves through BOTH legal dispositions, and no message row is
#     created or deleted by either;
#   * the terminal transition is refused while anything required is unresolved,
#     then happens exactly once and replays idempotently — and migration 072's
#     trigger refuses a false terminal written around the transition entirely;
#   * a reconnect is a new namespace: the old bearer, the old sealed lease handle
#     and the old cursor all keep failing;
#   * a disconnect racing a claim leaves one serial outcome, zero claimable jobs
#     and zero surviving leases;
#   * an out-of-band credential revoke is reconciled fail-closed by the first
#     domain guard, connection-scoped so a sibling connection is untouched;
#   * the whole surface is non-enumerable off its own workspace and principal.
set -euo pipefail
umask 077

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

if [ -n "${DATABASE_URL:-}" ] || [ -n "${HOSTED_DISCONNECT_DATABASE_URL:-}" ]; then
  echo "[hosted-disconnect] external DATABASE_URL is forbidden; isolated Docker is mandatory" >&2
  exit 1
fi
for command_name in cargo docker openssl; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "[hosted-disconnect] missing required command: $command_name" >&2
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
  echo "[hosted-disconnect] psql not found" >&2
  exit 1
fi
export PATH="$PSQL_DIR:$PATH"

DOCKER_BIN="${DOCKER_BIN:-docker}"
PG_IMAGE="pgvector/pgvector:0.8.5-pg18-trixie@sha256:9d2e61c7352b9e9f4798df5fd9a498f043f4cda1cdacc707de3d198650f4321e"
PG_PORT="${HOSTED_DISCONNECT_PG_PORT:-24568}"
NAME_PREFIX="${HOSTED_DISCONNECT_PROJECT:-w1367-hosted-disconnect}"
OWNERSHIP_LABEL=com.momo.hosted-disconnect.invocation
INVOCATION_ID="$(${DOCKER_BIN} version >/dev/null 2>&1 && openssl rand -hex 16)"
[[ "$INVOCATION_ID" =~ ^[0-9a-f]{32}$ ]] || {
  echo "[hosted-disconnect] failed to create invocation identity" >&2
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
    '{{.Id}}|{{.Name}}|{{index .Config.Labels "com.momo.hosted-disconnect.invocation"}}' binding || return 1
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
  state="$(mktemp -d "${TMPDIR:-/tmp}/momo-hosted-disconnect-cleanup.XXXXXX")"
  fake="$REPO_ROOT/scripts/tests/fake_agent_port_tools_docker.sh"
  chmod 755 "$fake"
  export FAKE_DOCKER_STATE="$state"
  FAKE_DOCKER_ID="$(printf 'c%.0s' $(seq 1 64))"
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
  echo "[hosted-disconnect] PASS daemon-free cleanup tri-state/removal contract"
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

ENV_FILE="$(mktemp "${TMPDIR:-/tmp}/momo-hosted-disconnect-env.XXXXXX")"
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
verify_binding || { echo "[hosted-disconnect] ownership proof failed" >&2; exit 1; }

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
# HAP-E6 removed the `#[cfg(debug_assertions)]` around the delivery gate, so the
# variable is now readable in every build. It is still NOT exported here: the
# fixtures open the selector through the synthetic `AgentPortConfig` override in
# the test binary, so this verifier proves nothing that depends on a machine-wide
# environment — and the default stays closed.
unset MOMO_HOSTED_DELIVERY_ENABLED
(
  cd server-rust
  cargo test -p momo-server --test hosted_disconnect_conformance_pg \
    -- --ignored --test-threads=1 --nocapture
)

remove_owned
CLEANUP_DONE=1
echo "[hosted-disconnect] PASS PG18 atomic-start/manifest/terminal/reconnect/race/reconcile contract"

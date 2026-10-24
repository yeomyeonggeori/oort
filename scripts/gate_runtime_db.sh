#!/usr/bin/env bash
# #4386 — gate-owned, host-reachable PostgreSQL 18 for `local_gate.sh --profile runtime-db`.
#
# Why this exists. The profile used to bootstrap with `make up` → `make migrate`.
# `make up` starts the self-host compose stack, whose Postgres publishes no host
# port (it lives on the private network on purpose), while `make migrate` and
# `verify_rls.sh` are host-side psql clients that read DATABASE_URL from
# .env.worktree / .env / infra/.env.example (`localhost:<POSTGRES_PORT>`). The two
# halves were written for a compose file that no longer exists, so on a clean
# machine the step failed with "connection refused" (and `make up` itself stops
# first when infra/rust/local.secrets.env is absent). Rather than publish a port
# on the product compose file (a deploy-posture change this gate must not make),
# the gate owns a disposable PG18 of its own — the same pinned image digest as
# infra/rust/docker-compose.rust.yml and the other verifiers — with a random free
# loopback port, a random password and a unique name.
#
# Usage:
#   scripts/gate_runtime_db.sh up     start PG18, write the env file (0600)
#   scripts/gate_runtime_db.sh down   remove the container (idempotent; --keep skips)
#   scripts/gate_runtime_db.sh env    print the env file path
#
# Environment:
#   LOCAL_GATE_OUTPUT_DIR   where the env/state files go (set by local_gate.sh)
#   LOCAL_GATE_RUN_ID       unique label for this run (set by local_gate.sh)
#   GATE_RUNTIME_DB_BOOT_TIMEOUT   seconds to wait for readiness (default 180)
#
# The env file carries the keys `scripts/ensure_runtime_env.sh` requires plus the
# DB keys `make migrate` / `verify_rls.sh` / the agent bootstrap verifiers read.
# Every secret is generated here; none is printed.
set -euo pipefail
umask 077

PG_IMAGE="pgvector/pgvector:0.8.7-pg18-trixie@sha256:9d9c930220cb9bf2f956d10a8f909cf9973d9672ca0278aef2c1e6facccad2e0"
OUT_DIR="${LOCAL_GATE_OUTPUT_DIR:-${TMPDIR:-/tmp}/momo-local-gate}"
RUN_ID="${LOCAL_GATE_RUN_ID:-manual-$$}"
ENV_OUT="$OUT_DIR/runtime-db.env"
STATE_OUT="$OUT_DIR/runtime-db.container"
LABEL_KEY="com.momo.gate-runtime-db"
BOOT_TIMEOUT="${GATE_RUNTIME_DB_BOOT_TIMEOUT:-180}"

log() { printf '[gate-runtime-db] %s\n' "$*"; }
fail() { printf '[gate-runtime-db] FAIL: %s\n' "$*" >&2; exit 1; }

# Homebrew keeps libpq keg-only (off PATH), so PATH alone would refuse a machine
# that scripts/migrate.sh and verify_rls.sh can run on. MOMO_LIBPQ_BIN_DIRS lets a
# fixture point at a fake directory; the default is the two Homebrew prefixes.
find_psql() {
  local dir
  if command -v psql >/dev/null 2>&1; then
    command -v psql
    return 0
  fi
  for dir in ${MOMO_LIBPQ_BIN_DIRS:-/opt/homebrew/opt/libpq/bin /usr/local/opt/libpq/bin}; do
    if [ -x "$dir/psql" ]; then
      printf '%s\n' "$dir/psql"
      return 0
    fi
  done
  return 1
}

gen() { python3 -c 'import secrets; print(secrets.token_hex(24))'; }

free_port() {
  python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()'
}

cmd_up() {
  command -v docker >/dev/null 2>&1 || fail "docker not found; the runtime-db profile needs Docker"
  command -v python3 >/dev/null 2>&1 || fail "python3 not found"
  docker info >/dev/null 2>&1 || fail "docker daemon is not reachable (start Docker/Colima first)"
  # Fail here, in a second, with the install hint — not after a PostgreSQL boot
  # and a migration pass inside `make migrate` (which would exit 0 with
  # "runtime-unverified" when psql is absent).
  find_psql >/dev/null ||
    fail "psql not found on PATH or in the Homebrew libpq locations; install it (brew install libpq) and retry"

  mkdir -p "$OUT_DIR"
  local tag container project pg_pass pg_port
  tag="$(printf '%s' "$RUN_ID" | python3 -c 'import hashlib,sys; print(hashlib.sha256(sys.stdin.read().encode()).hexdigest()[:10])')"
  container="momo-gate-pg-$tag"
  project="momo-gate-$tag"
  pg_pass="$(gen)"

  log "starting isolated PostgreSQL 18 container '$container'"
  docker rm -f "$container" >/dev/null 2>&1 || true
  # `-e POSTGRES_PASSWORD` (no value) forwards the variable from this process's
  # environment, so the password never appears in docker's argv / `ps`.
  POSTGRES_PASSWORD="$pg_pass" docker run -d --name "$container" \
    --label "$LABEL_KEY=$RUN_ID" \
    -e POSTGRES_DB=momo -e POSTGRES_USER=momo -e POSTGRES_PASSWORD \
    -p 127.0.0.1::5432 \
    "$PG_IMAGE" >/dev/null
  # Recorded before readiness so an interrupted boot is still torn down.
  printf '%s\n' "$container" >"$STATE_OUT"

  pg_port="$(docker port "$container" 5432/tcp | sed -E 's/.*:([0-9]+)$/\1/' | tail -n 1)"
  case "$pg_port" in ''|*[!0-9]*) fail "could not resolve the published PostgreSQL port" ;; esac

  local deadline
  deadline=$(( $(date -u +%s) + BOOT_TIMEOUT ))
  until docker exec "$container" pg_isready -U momo -d momo >/dev/null 2>&1; do
    if [ "$(date -u +%s)" -ge "$deadline" ]; then
      docker logs --tail 80 "$container" >&2 || true
      fail "PostgreSQL readiness timeout after ${BOOT_TIMEOUT}s"
    fi
    if [ "$(docker inspect -f '{{.State.Status}}' "$container" 2>/dev/null)" = "exited" ]; then
      docker logs --tail 80 "$container" >&2 || true
      fail "PostgreSQL container exited during boot"
    fi
    sleep 2
  done

  local port cent_port hermes_port
  port="$(free_port)"; cent_port="$(free_port)"; hermes_port="$(free_port)"
  cat >"$ENV_OUT" <<EOF
# Generated by scripts/gate_runtime_db.sh for one local-gate run. Do not commit.
COMPOSE_PROJECT_NAME=$project
POSTGRES_DB=momo
POSTGRES_USER=momo
POSTGRES_PASSWORD=$pg_pass
POSTGRES_HOST=127.0.0.1
POSTGRES_PORT=$pg_port
DATABASE_URL=postgres://momo:$pg_pass@127.0.0.1:$pg_port/momo
PORT=$port
CENT_PORT=$cent_port
HERMES_PORT=$hermes_port
CENT_TOKEN_HMAC=$(gen)
CENT_API_KEY=$(gen)
CENT_PROXY_SECRET=$(gen)
CENT_API_URL=http://127.0.0.1:$cent_port/api
JWT_HMAC=$(gen)
HERMES_BASE_URL=http://127.0.0.1:$hermes_port/v1
HERMES_API_KEY=$(gen)
EOF
  chmod 600 "$ENV_OUT"
  log "ready: 127.0.0.1:$pg_port (env file: $ENV_OUT)"
}

cmd_down() {
  if [ "${1:-}" = "--keep" ]; then
    log "--keep: leaving the runtime DB container up"
    return 0
  fi
  local container=""
  [ -f "$STATE_OUT" ] && container="$(head -n 1 "$STATE_OUT")"
  # Only a container carrying this run's label is ever removed: a recorded name
  # that was reused by something else must not be taken down.
  if [ -n "$container" ] &&
    [ "$(docker inspect -f "{{ index .Config.Labels \"$LABEL_KEY\" }}" "$container" 2>/dev/null || true)" = "$RUN_ID" ]; then
    docker rm -f "$container" >/dev/null 2>&1 || true
    log "removed $container"
  else
    log "nothing to remove for run $RUN_ID"
  fi
  rm -f -- "$STATE_OUT"
}

case "${1:-}" in
  up) cmd_up ;;
  down) shift; cmd_down "$@" ;;
  env) printf '%s\n' "$ENV_OUT" ;;
  *) fail "usage: scripts/gate_runtime_db.sh up|down [--keep]|env" ;;
esac

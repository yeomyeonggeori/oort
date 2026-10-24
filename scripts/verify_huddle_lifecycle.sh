#!/usr/bin/env bash
# HD-1 / ADR-0122: exercise huddles through the real Rust/Axum router.
#
# The verifier owns only a pinned PostgreSQL 18 container. The ignored Rust
# integration test starts the API on an ephemeral host port, migrates/fixtures
# the database, and proves fail-closed configuration, lifecycle, LiveKit grant,
# transactional outbox/audit, re-entry, single-active, and FORCE-RLS behavior.
# Docker/PG execution belongs to momo-main; implementation workers run bash -n.
#
# LS-1 (#2165): boots the same pgvector/PG18 digest as infra/rust/docker-compose.rust.yml
# via `docker run` (the Rust compose file interpolates every ${VAR:?} before a
# postgres-only `up`, so it cannot isolate PG without a full smoke env).
set -euo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

need() { command -v "$1" >/dev/null 2>&1 || { echo "[huddle] missing $1" >&2; exit 1; }; }
need docker
need cargo
# The conformance test resolves psql PATH-or-Homebrew-libpq (`resolve_psql`),
# and Homebrew keeps libpq off PATH, so a bare `need psql` refused a machine
# that can run this (#4386). Same check, same fallback locations.
if ! command -v psql >/dev/null 2>&1; then
  psql_found=0
  for candidate in ${MOMO_LIBPQ_BIN_DIRS:-/opt/homebrew/opt/libpq/bin /usr/local/opt/libpq/bin}; do
    [ -x "$candidate/psql" ] && { psql_found=1; break; }
  done
  [ "$psql_found" = "1" ] || {
    echo "[huddle] psql not found on PATH or in the Homebrew libpq locations the test falls back to" >&2
    exit 1
  }
fi

PG_IMAGE="pgvector/pgvector:0.8.7-pg18-trixie@sha256:9d9c930220cb9bf2f956d10a8f909cf9973d9672ca0278aef2c1e6facccad2e0"
PROJECT="${HUDDLE_GATE_PROJECT:-hd1-huddle-pg}"
CONTAINER="${PROJECT}-postgres"
PG_PORT="${HUDDLE_GATE_POSTGRES_PORT:-19861}"
BOOT_TIMEOUT="${HUDDLE_GATE_BOOT_TIMEOUT:-180}"
POSTGRES_DB="${HUDDLE_GATE_POSTGRES_DB:-momo}"
POSTGRES_USER="${HUDDLE_GATE_POSTGRES_USER:-momo}"
POSTGRES_PASSWORD="${HUDDLE_GATE_POSTGRES_PASSWORD:-huddle-pg-owner}"

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if [ "${HUDDLE_GATE_KEEP:-0}" = "1" ]; then
    echo "[huddle] leaving container '$CONTAINER' up"
  else
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

echo "[huddle] booting isolated PostgreSQL 18 container '$CONTAINER'"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" \
  -e POSTGRES_DB="$POSTGRES_DB" \
  -e POSTGRES_USER="$POSTGRES_USER" \
  -e POSTGRES_PASSWORD="$POSTGRES_PASSWORD" \
  -p "127.0.0.1:${PG_PORT}:5432" \
  "$PG_IMAGE" >/dev/null

deadline=$(( $(date -u +%s) + BOOT_TIMEOUT ))
until docker exec "$CONTAINER" pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; do
  if [ "$(date -u +%s)" -ge "$deadline" ]; then
    docker logs --tail 120 "$CONTAINER" >&2 || true
    echo "[huddle] PostgreSQL readiness timeout" >&2
    exit 1
  fi
  if [ "$(docker inspect -f '{{.State.Status}}' "$CONTAINER" 2>/dev/null)" = "exited" ]; then
    docker logs --tail 120 "$CONTAINER" >&2 || true
    echo "[huddle] PostgreSQL exited" >&2
    exit 1
  fi
  sleep 2
done

DATABASE_URL="postgres://$POSTGRES_USER:$POSTGRES_PASSWORD@127.0.0.1:$PG_PORT/$POSTGRES_DB" \
MOMO_APP_PASSWORD=momo_app_dev_pw \
  cargo test --manifest-path server-rust/Cargo.toml \
    -p momo-server --test huddle_conformance_pg -- --ignored --nocapture

echo "HD-1 Rust huddle fail-closed + grant + lifecycle + outbox/audit + RLS PASS"

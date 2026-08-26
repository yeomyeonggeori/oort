#!/usr/bin/env bash
# HD-1 / ADR-0122: exercise huddles through the real Rust/Axum router.
#
# The verifier owns only a pinned PostgreSQL 18 container. The ignored Rust
# integration test starts the API on an ephemeral host port, migrates/fixtures
# the database, and proves fail-closed configuration, lifecycle, LiveKit grant,
# transactional outbox/audit, re-entry, single-active, and FORCE-RLS behavior.
# Docker/PG execution belongs to momo-main; implementation workers run bash -n.
set -euo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

need() { command -v "$1" >/dev/null 2>&1 || { echo "[huddle] missing $1" >&2; exit 1; }; }
need docker
need cargo
need psql

COMPOSE_FILE="$REPO_ROOT/infra/docker-compose.e2e.yml"
PROJECT="${HUDDLE_GATE_PROJECT:-hd1-huddle-pg}"
PG_PORT="${HUDDLE_GATE_POSTGRES_PORT:-19861}"
BOOT_TIMEOUT="${HUDDLE_GATE_BOOT_TIMEOUT:-180}"
POSTGRES_DB="${HUDDLE_GATE_POSTGRES_DB:-momo}"
POSTGRES_USER="${HUDDLE_GATE_POSTGRES_USER:-momo}"
POSTGRES_PASSWORD="${HUDDLE_GATE_POSTGRES_PASSWORD:-huddle-pg-owner}"

compose() {
  POSTGRES_PORT="$PG_PORT" POSTGRES_DB="$POSTGRES_DB" \
  POSTGRES_USER="$POSTGRES_USER" POSTGRES_PASSWORD="$POSTGRES_PASSWORD" \
    docker compose -p "$PROJECT" -f "$COMPOSE_FILE" "$@"
}

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if [ "${HUDDLE_GATE_KEEP:-0}" = "1" ]; then
    echo "[huddle] leaving compose project '$PROJECT' up"
  else
    compose down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

echo "[huddle] booting isolated PostgreSQL 18 project '$PROJECT'"
compose up -d postgres
deadline=$(( $(date -u +%s) + BOOT_TIMEOUT ))
until compose exec -T postgres pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; do
  if [ "$(date -u +%s)" -ge "$deadline" ]; then
    compose logs --tail 120 postgres >&2 || true
    echo "[huddle] PostgreSQL readiness timeout" >&2
    exit 1
  fi
  if [ -n "$(compose ps -aq --status exited postgres 2>/dev/null)" ]; then
    compose logs --tail 120 postgres >&2 || true
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

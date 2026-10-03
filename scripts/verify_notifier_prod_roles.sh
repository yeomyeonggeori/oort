#!/usr/bin/env bash
# #3377: run every momo-notifier job iteration as its PRODUCTION database role.
#
# The other notifier *_pg suites provision roles with the development file
# (bootstrap_roles.sql: DELETE on every table for momo_notifier), which is how the
# share retention sweep passed its tests and then died in production with
# `permission denied for table work_session_share` (v0.1.16 incident). The suite
# run here, prod_role_conformance_pg, builds a fresh database the way Railway's api
# pre-deploy does (bootstrap_runtime_roles.sql, migrate, bootstrap_runtime_roles.sql)
# and fails on any permission error. The two-pool sweeps' behaviour suites run too.
#
# Boots its own PostgreSQL 18 container and removes it (and its volume) on exit.
# Override NOTIFIER_ROLES_GATE_IMAGE to use a locally available pgvector/PG18 image.
set -euo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

need() { command -v "$1" >/dev/null 2>&1 || { echo "[notifier-roles] missing $1" >&2; exit 1; }; }
need docker
need cargo
need psql

PG_IMAGE="${NOTIFIER_ROLES_GATE_IMAGE:-pgvector/pgvector:0.8.5-pg18-trixie@sha256:9d2e61c7352b9e9f4798df5fd9a498f043f4cda1cdacc707de3d198650f4321e}"
CONTAINER="${NOTIFIER_ROLES_GATE_CONTAINER:-notifier-roles-pg}"
PG_PORT="${NOTIFIER_ROLES_GATE_POSTGRES_PORT:-19871}"
BOOT_TIMEOUT="${NOTIFIER_ROLES_GATE_BOOT_TIMEOUT:-180}"
POSTGRES_DB=momo
POSTGRES_USER=momo
POSTGRES_PASSWORD="${NOTIFIER_ROLES_GATE_POSTGRES_PASSWORD:-notifier-roles-owner}"

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  docker rm -f -v "$CONTAINER" >/dev/null 2>&1 || true
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

echo "[notifier-roles] booting isolated PostgreSQL 18 container '$CONTAINER'"
docker rm -f -v "$CONTAINER" >/dev/null 2>&1 || true
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
    echo "[notifier-roles] PostgreSQL readiness timeout" >&2
    exit 1
  fi
  if [ "$(docker inspect -f '{{.State.Status}}' "$CONTAINER" 2>/dev/null)" = "exited" ]; then
    docker logs --tail 120 "$CONTAINER" >&2 || true
    echo "[notifier-roles] PostgreSQL exited" >&2
    exit 1
  fi
  sleep 2
done

export DATABASE_URL="postgres://$POSTGRES_USER:$POSTGRES_PASSWORD@127.0.0.1:$PG_PORT/$POSTGRES_DB"
cargo test --manifest-path server-rust/Cargo.toml -p momo-notifier \
  --test prod_role_conformance_pg \
  --test share_retention_conformance_pg \
  --test avatar_reclaim_conformance_pg \
  -- --ignored --test-threads=1 --nocapture

echo "[notifier-roles] PASS: every notifier job iteration ran as its production role"

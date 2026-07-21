#!/usr/bin/env bash
# MOMO-408: production seed owner must be locked until operator takeover, while
# the explicit e2e seed mode keeps the deterministic local login path.
set -euo pipefail
umask 077

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
RUN_SUFFIX="$(date -u +%Y%m%dT%H%M%SZ)-$$"
POSTGRES_CONTAINER="momo-prod-seed-password-$RUN_SUFFIX"
POSTGRES_PASSWORD="momo_prod_seed_verifier_$RUN_SUFFIX"
PROD_DB="momo_prod_seed"
E2E_DB="momo_e2e_seed"
WORKSPACE_ID="00000000-0000-7000-8000-000000000001"
OWNER_MEMBER_ID="00000000-0000-7000-8000-000000000101"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/momo-prod-seed-password.XXXXXX")"
SERVER_PID=""

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "[prod-seed-password] missing required command: $1" >&2
    exit 1
  }
}

need curl
need docker
need jq
need python3
need swift

terminate_tree() {
  local pid="$1"
  local child
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do
    terminate_tree "$child"
  done
  kill "$pid" >/dev/null 2>&1 || true
}

stop_server() {
  if [ "$SERVER_PID" != "" ] && kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    terminate_tree "$SERVER_PID"
    wait "$SERVER_PID" >/dev/null 2>&1 || true
  fi
  SERVER_PID=""
}

cleanup() {
  stop_server
  docker rm -f "$POSTGRES_CONTAINER" >/dev/null 2>&1 || true
  rm -rf -- "$TMP_DIR"
}
trap cleanup EXIT INT TERM

docker run --detach --rm \
  --name "$POSTGRES_CONTAINER" \
  --env "POSTGRES_PASSWORD=$POSTGRES_PASSWORD" \
  --publish 127.0.0.1::5432 \
  --volume "$REPO_ROOT:/workspace:ro" \
  pgvector/pgvector:0.8.5-pg18@sha256:12a379b47ad65289572ea0756efc11b7c241a6662833e8af7038cd3b73d647e0 >/dev/null

for _ in $(seq 1 60); do
  if docker exec "$POSTGRES_CONTAINER" pg_isready -U postgres >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec "$POSTGRES_CONTAINER" pg_isready -U postgres >/dev/null

HOST_PORT="$(docker port "$POSTGRES_CONTAINER" 5432/tcp | sed -E 's/.*:([0-9]+)$/\1/' | tail -n 1)"
case "$HOST_PORT" in
  ''|*[!0-9]*)
    echo "[prod-seed-password] could not resolve PostgreSQL host port" >&2
    exit 1
    ;;
esac

for database in "$PROD_DB" "$E2E_DB"; do
  docker exec "$POSTGRES_CONTAINER" createdb -U postgres "$database"
done

migrate_database() {
  local database="$1"
  local seed_mode="$2"
  docker exec \
    --env "DATABASE_URL=postgres://postgres:$POSTGRES_PASSWORD@127.0.0.1:5432/$database" \
    --env "MOMO_AGENT_SEED_MODE=$seed_mode" \
    --env MIGRATE_IDEMPOTENCY_CHECK=1 \
    --workdir /workspace \
    "$POSTGRES_CONTAINER" sh scripts/migrate.sh >/dev/null
  docker exec --interactive "$POSTGRES_CONTAINER" psql \
    -U postgres -d "$database" -v ON_ERROR_STOP=1 --no-psqlrc \
    -f /workspace/infra/e2e/bootstrap_roles.sql >/dev/null
}

migrate_database "$PROD_DB" none
migrate_database "$E2E_DB" e2e

free_port() {
  python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()'
}

start_server() {
  local database="$1"
  local port="$2"
  local log_file="$3"
  (
    cd "$REPO_ROOT"
    DATABASE_URL="postgres://momo_app:momo_app_dev_pw@127.0.0.1:$HOST_PORT/$database" \
    HOST=127.0.0.1 \
    PORT="$port" \
    swift run --package-path server MomoServer
  ) >"$log_file" 2>&1 &
  SERVER_PID="$!"

  for _ in $(seq 1 90); do
    if curl -fsS --connect-timeout 2 --max-time 3 "http://127.0.0.1:$port/health" >/dev/null 2>&1; then
      return 0
    fi
    if ! kill -0 "$SERVER_PID" >/dev/null 2>&1; then
      echo "[prod-seed-password] server exited before health ($database)" >&2
      tail -120 "$log_file" >&2 || true
      exit 1
    fi
    sleep 1
  done
  echo "[prod-seed-password] timed out waiting for server health ($database)" >&2
  tail -120 "$log_file" >&2 || true
  exit 1
}

login_status() {
  local port="$1"
  local password="$2"
  curl -sS --connect-timeout 3 --max-time 10 \
    -o "$TMP_DIR/login-response.json" \
    -w '%{http_code}' \
    -H 'Content-Type: application/json' \
    -d "$(jq -cn --arg password "$password" --arg workspace "$WORKSPACE_ID" \
      '{email:"demo@momo.local",password:$password,workspace:$workspace}')" \
    "http://127.0.0.1:$port/v1/auth/login"
}

PROD_PORT="$(free_port)"
start_server "$PROD_DB" "$PROD_PORT" "$TMP_DIR/prod-server.log"

status="$(login_status "$PROD_PORT" dev-password)"
if [ "$status" != "401" ]; then
  echo "[prod-seed-password] FAIL prod seed login before takeover: expected 401, got $status" >&2
  exit 1
fi
echo "[prod-seed-password] PASS prod seed dev-password is fail-closed (401)"

takeover_count="$(docker exec --interactive "$POSTGRES_CONTAINER" psql \
  -U postgres -d "$PROD_DB" -v ON_ERROR_STOP=1 --no-psqlrc -At <<SQL
BEGIN;
SET LOCAL app.workspace_id = '$WORKSPACE_ID';
WITH taken_over AS (
  UPDATE human
     SET email = 'owner-prod-verifier@momo.local',
         email_verified = true,
         password_hash = momo_password_hash('operator-owned-password')
   WHERE member_id = '$OWNER_MEMBER_ID'
   RETURNING 1
)
SELECT count(*) FROM taken_over;
COMMIT;
SQL
)"
if ! printf '%s\n' "$takeover_count" | grep -qx '1'; then
  echo "[prod-seed-password] FAIL owner takeover did not update exactly one row" >&2
  exit 1
fi

status="$(curl -sS --connect-timeout 3 --max-time 10 \
  -o "$TMP_DIR/takeover-login-response.json" \
  -w '%{http_code}' \
  -H 'Content-Type: application/json' \
  -d "$(jq -cn --arg workspace "$WORKSPACE_ID" \
    '{email:"owner-prod-verifier@momo.local",password:"operator-owned-password",workspace:$workspace}')" \
  "http://127.0.0.1:$PROD_PORT/v1/auth/login")"
if [ "$status" != "200" ]; then
  echo "[prod-seed-password] FAIL taken-over owner login: expected 200, got $status" >&2
  exit 1
fi
echo "[prod-seed-password] PASS takeover updated one owner and operator login succeeds (200)"

# Review #431 M1 + H1 regression: re-running the widened 012 lock predicate
# must (a) NEVER touch an operator-owned password (over-lock guard) and
# (b) lock ANY remaining dev-password human, not just the seeded owner.
lock_matrix="$(docker exec --interactive "$POSTGRES_CONTAINER" psql \
  -U postgres -d "$PROD_DB" -v ON_ERROR_STOP=1 --no-psqlrc -At <<SQL
BEGIN;
SET LOCAL app.workspace_id = '$WORKSPACE_ID';
INSERT INTO member (id, workspace_id, kind, display_name, handle, status)
VALUES ('00000000-0000-7000-8000-0000000004a1', '$WORKSPACE_ID', 'human', 'Legacy Backfilled', 'legacy-backfilled', 'active')
ON CONFLICT (id) DO NOTHING;
INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash)
VALUES ('00000000-0000-7000-8000-0000000004a1', '$WORKSPACE_ID', 'legacy-backfilled@momo.local', true, momo_password_hash('dev-password'))
ON CONFLICT (member_id) DO UPDATE SET password_hash = momo_password_hash('dev-password');
WITH locked AS (
  UPDATE human
     SET password_hash = NULL
   WHERE momo_password_verify('dev-password', password_hash)
   RETURNING member_id
)
SELECT
  (SELECT count(*) FROM locked) AS locked_rows,
  (SELECT count(*) FROM human
    WHERE member_id = '$OWNER_MEMBER_ID'
      AND momo_password_verify('operator-owned-password', password_hash)) AS owner_preserved;
COMMIT;
SQL
)"
if ! printf '%s\n' "$lock_matrix" | grep -qx '1|1'; then
  echo "[prod-seed-password] FAIL widened lock matrix: expected 'locked_rows=1|owner_preserved=1', got '$lock_matrix'" >&2
  exit 1
fi
echo "[prod-seed-password] PASS widened lock hits non-owner dev-password rows and never touches operator-owned passwords"
stop_server

E2E_PORT="$(free_port)"
start_server "$E2E_DB" "$E2E_PORT" "$TMP_DIR/e2e-server.log"
status="$(login_status "$E2E_PORT" dev-password)"
if [ "$status" != "200" ]; then
  echo "[prod-seed-password] FAIL e2e seed login regression: expected 200, got $status" >&2
  exit 1
fi
echo "[prod-seed-password] PASS e2e seed dev-password login remains available (200)"

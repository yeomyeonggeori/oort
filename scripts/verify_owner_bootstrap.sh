#!/usr/bin/env bash
# MOMO-561: migrate-image `set-owner` runtime verifier.
set -euo pipefail
umask 077

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

RUN_TAG="$(date -u +%Y%m%dT%H%M%SZ)-$$"
NETWORK="momo-owner-bootstrap-$RUN_TAG"
POSTGRES_CONTAINER="momo-owner-bootstrap-postgres-$RUN_TAG"
SET_OWNER_CONTAINER="momo-owner-bootstrap-command-$RUN_TAG"
MIGRATE_IMAGE="momo-migrate:owner-bootstrap-$RUN_TAG"
POSTGRES_PORT=28200
POSTGRES_PASSWORD="owner_bootstrap_db_$RUN_TAG"
OWNER_EMAIL="owner-$RUN_TAG@momo.local"
OWNER_PASSWORD="owner-bootstrap-password-$RUN_TAG"
ROTATED_EMAIL="rotated-$RUN_TAG@momo.local"
ROTATED_PASSWORD="rotated-owner-password-$RUN_TAG"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/momo-owner-bootstrap.XXXXXX")"
export POSTGRES_PASSWORD

fail() {
  printf '[owner-bootstrap] FAIL: %s\n' "$*" >&2
  exit 1
}

for command_name in docker python3; do
  command -v "$command_name" >/dev/null 2>&1 || fail "missing required command: $command_name"
done

python3 - "$POSTGRES_PORT" <<'PY'
import socket, sys
port = int(sys.argv[1])
sock = socket.socket()
try:
    sock.bind(("127.0.0.1", port))
except OSError:
    raise SystemExit(f"reserved verifier port is already in use: {port}")
finally:
    sock.close()
PY

cleanup() {
  docker rm -f "$SET_OWNER_CONTAINER" "$POSTGRES_CONTAINER" >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
  docker image rm "$MIGRATE_IMAGE" >/dev/null 2>&1 || true
  rm -rf -- "$TMP_DIR"
}
trap cleanup EXIT INT TERM

docker network create "$NETWORK" >/dev/null
docker run --detach --rm \
  --name "$POSTGRES_CONTAINER" \
  --network "$NETWORK" \
  --env POSTGRES_PASSWORD \
  --publish "127.0.0.1:${POSTGRES_PORT}:5432" \
  pgvector/pgvector:0.8.5-pg18-trixie@sha256:9d2e61c7352b9e9f4798df5fd9a498f043f4cda1cdacc707de3d198650f4321e >/dev/null

for _ in $(seq 1 60); do
  docker exec "$POSTGRES_CONTAINER" pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$POSTGRES_CONTAINER" pg_isready -U postgres >/dev/null || fail "PostgreSQL did not become ready"

docker build -f infra/prod/docker/internal-smoke-migrate.Dockerfile -t "$MIGRATE_IMAGE" . >/dev/null
DATABASE_URL="postgres://postgres:${POSTGRES_PASSWORD}@${POSTGRES_CONTAINER}:5432/postgres"
export DATABASE_URL

docker run --rm --network "$NETWORK" \
  --env DATABASE_URL \
  --env MOMO_AGENT_SEED_MODE=none \
  "$MIGRATE_IMAGE" >"$TMP_DIR/migrate.log" 2>&1

if docker run --rm --network "$NETWORK" \
  --env DATABASE_URL \
  "$MIGRATE_IMAGE" set-owner >"$TMP_DIR/missing-secret.log" 2>&1; then
  fail "set-owner accepted missing owner environment"
fi
grep -Fq 'set MOMO_INITIAL_OWNER_EMAIL' "$TMP_DIR/missing-secret.log" ||
  fail "missing owner environment did not fail with an actionable variable name"

MOMO_INITIAL_OWNER_EMAIL="$OWNER_EMAIL"
MOMO_INITIAL_OWNER_PASSWORD="$OWNER_PASSWORD"
export MOMO_INITIAL_OWNER_EMAIL MOMO_INITIAL_OWNER_PASSWORD
docker run --name "$SET_OWNER_CONTAINER" --network "$NETWORK" \
  --env DATABASE_URL \
  --env MOMO_INITIAL_OWNER_EMAIL \
  --env MOMO_INITIAL_OWNER_PASSWORD \
  "$MIGRATE_IMAGE" set-owner >"$TMP_DIR/set-owner.log" 2>&1

[ "$(docker inspect -f '{{json .Config.Cmd}}' "$SET_OWNER_CONTAINER")" = '["set-owner"]' ] ||
  fail "owner password leaked into the container command argv"
if grep -Fq "$OWNER_PASSWORD" "$TMP_DIR/set-owner.log"; then
  fail "owner password leaked into set-owner output"
fi
grep -Fq 'bootstrap owner credentials updated' "$TMP_DIR/set-owner.log" ||
  fail "set-owner did not report completion"

CHECK_EMAIL="$OWNER_EMAIL"
CHECK_PASSWORD="$OWNER_PASSWORD"
export CHECK_EMAIL CHECK_PASSWORD
owner_state="$(docker exec --interactive \
  --env CHECK_EMAIL \
  --env CHECK_PASSWORD \
  "$POSTGRES_CONTAINER" psql -qAt -U postgres -d postgres -v ON_ERROR_STOP=1 --no-psqlrc <<'SQL'
\getenv check_email CHECK_EMAIL
\getenv check_password CHECK_PASSWORD
SET app.workspace_id = '00000000-0000-7000-8000-000000000001';
SELECT count(*)
  FROM human h
  JOIN workspace_membership wm
    ON wm.workspace_id = h.workspace_id
   AND wm.member_id = h.member_id
 WHERE h.member_id = '00000000-0000-7000-8000-000000000101'
   AND h.email = lower(btrim(:'check_email'))
   AND h.email_verified
   AND momo_password_verify(:'check_password', h.password_hash)
   AND wm.role = 'owner';
SQL
)"
[ "$owner_state" = "1" ] || fail "set-owner did not update exactly one active bootstrap owner"

docker exec --interactive "$POSTGRES_CONTAINER" psql -q -U postgres -d postgres -v ON_ERROR_STOP=1 --no-psqlrc <<'SQL'
SET app.workspace_id = '00000000-0000-7000-8000-000000000001';
INSERT INTO token (workspace_id, kind, actor_member_id, token_hash)
VALUES (
  '00000000-0000-7000-8000-000000000001',
  'session',
  '00000000-0000-7000-8000-000000000101',
  decode('5615615615615615615615615615615615615615615615615615615615615615', 'hex')
);
SQL

docker rm "$SET_OWNER_CONTAINER" >/dev/null
MOMO_INITIAL_OWNER_EMAIL="$ROTATED_EMAIL"
MOMO_INITIAL_OWNER_PASSWORD="$ROTATED_PASSWORD"
export MOMO_INITIAL_OWNER_EMAIL MOMO_INITIAL_OWNER_PASSWORD
docker run --name "$SET_OWNER_CONTAINER" --network "$NETWORK" \
  --env DATABASE_URL \
  --env MOMO_INITIAL_OWNER_EMAIL \
  --env MOMO_INITIAL_OWNER_PASSWORD \
  "$MIGRATE_IMAGE" set-owner >"$TMP_DIR/rotate.log" 2>&1

CHECK_EMAIL="$ROTATED_EMAIL"
CHECK_PASSWORD="$ROTATED_PASSWORD"
export CHECK_EMAIL CHECK_PASSWORD
rotation_state="$(docker exec --interactive \
  --env CHECK_EMAIL \
  --env CHECK_PASSWORD \
  "$POSTGRES_CONTAINER" psql -qAt -U postgres -d postgres -v ON_ERROR_STOP=1 --no-psqlrc <<'SQL'
\getenv check_email CHECK_EMAIL
\getenv check_password CHECK_PASSWORD
SET app.workspace_id = '00000000-0000-7000-8000-000000000001';
SELECT
  (SELECT count(*) FROM human
    WHERE member_id = '00000000-0000-7000-8000-000000000101'
      AND email = lower(btrim(:'check_email'))
      AND momo_password_verify(:'check_password', password_hash)),
  (SELECT count(*) FROM token
    WHERE actor_member_id = '00000000-0000-7000-8000-000000000101'
      AND revoked_at IS NOT NULL);
SQL
)"
[ "$rotation_state" = "1|1" ] || fail "credential rotation did not update the owner and revoke active sessions"

if grep -Fq "$ROTATED_PASSWORD" "$TMP_DIR/rotate.log"; then
  fail "rotated owner password leaked into command output"
fi

printf '[owner-bootstrap] PASS: migrate set-owner is env-only, owner-exact, idempotent, and session-revoking (port %s)\n' "$POSTGRES_PORT"

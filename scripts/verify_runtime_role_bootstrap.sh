#!/usr/bin/env sh
# Verify the production fresh-deploy order for migration 009:
# roles absent -> migrate -> bootstrap_roles.sql -> app-only invite lookup.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
RUN_SUFFIX="$(date -u +%Y%m%dT%H%M%SZ)-$$"
CONTAINER_NAME="momo-role-bootstrap-$RUN_SUFFIX"
POSTGRES_DB="momo_role_bootstrap"
POSTGRES_PASSWORD="momo_role_bootstrap_pw"

cleanup() {
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT HUP INT TERM

echo "[role-bootstrap] starting isolated PostgreSQL 18"
docker run --detach --rm \
  --name "$CONTAINER_NAME" \
  --env "POSTGRES_DB=$POSTGRES_DB" \
  --env "POSTGRES_PASSWORD=$POSTGRES_PASSWORD" \
  --volume "$REPO_ROOT:/workspace:ro" \
  postgres:18 >/dev/null

ready=0
attempt=1
while [ "$attempt" -le 60 ]; do
  if docker exec "$CONTAINER_NAME" pg_isready -U postgres -d "$POSTGRES_DB" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
  attempt=$((attempt + 1))
done
if [ "$ready" -ne 1 ]; then
  echo "[role-bootstrap] PostgreSQL did not become ready" >&2
  exit 1
fi

runtime_role_count() {
  docker exec "$CONTAINER_NAME" psql \
    -U postgres -d "$POSTGRES_DB" -tA --no-psqlrc \
    -c "SELECT count(*) FROM pg_roles WHERE rolname IN ('momo_app','momo_relay','momo_worker');"
}

if [ "$(runtime_role_count)" != "0" ]; then
  echo "[role-bootstrap] fresh cluster unexpectedly contains runtime roles" >&2
  exit 1
fi
echo "[role-bootstrap] PASS runtime roles absent before migration"

docker exec \
  --env "DATABASE_URL=postgres://postgres:$POSTGRES_PASSWORD@127.0.0.1:5432/$POSTGRES_DB" \
  --env MOMO_AGENT_SEED_MODE=e2e \
  --env MIGRATE_IDEMPOTENCY_CHECK=1 \
  --workdir /workspace \
  "$CONTAINER_NAME" sh scripts/migrate.sh >/dev/null

if [ "$(runtime_role_count)" != "0" ]; then
  echo "[role-bootstrap] migration must not create runtime roles" >&2
  exit 1
fi
echo "[role-bootstrap] PASS migration 009 ran while runtime roles were absent"

docker exec --interactive --workdir /workspace "$CONTAINER_NAME" psql \
  -U postgres -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 --no-psqlrc \
  -f infra/e2e/bootstrap_roles.sql >/dev/null

docker exec --interactive "$CONTAINER_NAME" psql \
  -U postgres -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 --no-psqlrc >/dev/null <<'SQL'
BEGIN;
SET LOCAL app.workspace_id = '00000000-0000-7000-8000-000000000001';
INSERT INTO invite_code (
  id, workspace_id, code_hash, code_preview, role, max_uses,
  expires_at, created_by
) VALUES (
  '00000000-0000-7000-8000-000000009001',
  '00000000-0000-7000-8000-000000000001',
  public.digest('fresh-order-invite', 'sha256'),
  'vite',
  'member',
  1,
  now() + interval '1 hour',
  '00000000-0000-7000-8000-000000000101'
);
COMMIT;
SQL

resolved_workspace=$(docker exec \
  --env PGPASSWORD=momo_app_dev_pw \
  "$CONTAINER_NAME" psql \
  -h 127.0.0.1 -U momo_app -d "$POSTGRES_DB" -tA --no-psqlrc \
  -c "SELECT momo_join_private.invite_workspace_id('fresh-order-invite');")
if [ "$resolved_workspace" != "00000000-0000-7000-8000-000000000001" ]; then
  echo "[role-bootstrap] momo_app lookup returned unexpected workspace: $resolved_workspace" >&2
  exit 1
fi
echo "[role-bootstrap] PASS momo_app exact invite lookup after role bootstrap"

for denied_role in momo_relay momo_worker; do
  if docker exec \
    --env "PGPASSWORD=${denied_role}_dev_pw" \
    "$CONTAINER_NAME" psql \
    -h 127.0.0.1 -U "$denied_role" -d "$POSTGRES_DB" \
    -v ON_ERROR_STOP=1 --no-psqlrc \
    -c "SELECT momo_join_private.invite_workspace_id('fresh-order-invite');" \
    >/dev/null 2>&1; then
    echo "[role-bootstrap] $denied_role unexpectedly executed private lookup" >&2
    exit 1
  fi
  echo "[role-bootstrap] PASS $denied_role denied private invite lookup"
done

echo "[role-bootstrap] PASS fresh migration-before-role bootstrap contract"

#!/usr/bin/env sh
# Verify both supported production orders around migration 009:
# 1. internal smoke: roles absent -> migrate -> e2e bootstrap
# 2. production: external roles required -> fail before migration when absent,
#    then preprovision -> migrate without test credentials.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
RUN_SUFFIX="$(date -u +%Y%m%dT%H%M%SZ)-$$"
BOOTSTRAP_CONTAINER="momo-role-bootstrap-$RUN_SUFFIX"
PRODUCTION_CONTAINER="momo-role-production-$RUN_SUFFIX"
POSTGRES_PASSWORD="momo_role_verifier_$RUN_SUFFIX"

cleanup() {
  docker rm -f "$BOOTSTRAP_CONTAINER" "$PRODUCTION_CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT HUP INT TERM

start_postgres() {
  container=$1
  database=$2
  docker run --detach --rm \
    --name "$container" \
    --env "POSTGRES_DB=$database" \
    --env "POSTGRES_PASSWORD=$POSTGRES_PASSWORD" \
    --volume "$REPO_ROOT:/workspace:ro" \
    pgvector/pgvector:0.8.5-pg18@sha256:12a379b47ad65289572ea0756efc11b7c241a6662833e8af7038cd3b73d647e0 >/dev/null

  attempt=1
  while [ "$attempt" -le 60 ]; do
    if docker exec "$container" pg_isready -U postgres -d "$database" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
    attempt=$((attempt + 1))
  done
  echo "[role-bootstrap] PostgreSQL did not become ready: $container" >&2
  return 1
}

migrate() {
  container=$1
  database=$2
  docker exec \
    --env "DATABASE_URL=postgres://postgres:$POSTGRES_PASSWORD@127.0.0.1:5432/$database" \
    --env MOMO_AGENT_SEED_MODE=e2e \
    --env MIGRATE_IDEMPOTENCY_CHECK=1 \
    --workdir /workspace \
    "$container" sh scripts/migrate.sh
}

echo "[role-bootstrap] starting isolated PostgreSQL 18 for migration drift/bootstrap order"
BOOTSTRAP_DB="momo_role_bootstrap"
start_postgres "$BOOTSTRAP_CONTAINER" "$BOOTSTRAP_DB"

role_count=$(docker exec "$BOOTSTRAP_CONTAINER" psql \
  -U postgres -d "$BOOTSTRAP_DB" -tA --no-psqlrc \
  -c "SELECT count(*) FROM pg_roles WHERE rolname IN ('momo_app','momo_relay','momo_worker','momo_notifier');")
if [ "$role_count" != "0" ]; then
  echo "[role-bootstrap] fresh cluster unexpectedly contains runtime roles" >&2
  exit 1
fi

docker exec "$BOOTSTRAP_CONTAINER" psql \
  -U postgres -d "$BOOTSTRAP_DB" -v ON_ERROR_STOP=1 --no-psqlrc \
  -c "CREATE SCHEMA momo_join_private; CREATE FUNCTION momo_join_private.invite_workspace_id(text) RETURNS uuid LANGUAGE sql SECURITY DEFINER AS 'SELECT NULL::uuid';" >/dev/null
if migrate "$BOOTSTRAP_CONTAINER" "$BOOTSTRAP_DB" >/dev/null 2>&1; then
  echo "[role-bootstrap] migration 009 adopted a pre-existing private object" >&2
  exit 1
fi
migration_009_count=$(docker exec "$BOOTSTRAP_CONTAINER" psql \
  -U postgres -d "$BOOTSTRAP_DB" -tA --no-psqlrc \
  -c "SELECT count(*) FROM schema_migrations WHERE version = '009_workspace_tenant_rls.sql';")
if [ "$migration_009_count" != "0" ]; then
  echo "[role-bootstrap] failed migration 009 was recorded" >&2
  exit 1
fi
docker exec "$BOOTSTRAP_CONTAINER" psql \
  -U postgres -d "$BOOTSTRAP_DB" -v ON_ERROR_STOP=1 --no-psqlrc \
  -c "DROP SCHEMA momo_join_private CASCADE;" >/dev/null
echo "[role-bootstrap] PASS adversarial private-object preseed fails transactionally"

migrate "$BOOTSTRAP_CONTAINER" "$BOOTSTRAP_DB" >/dev/null
docker exec --interactive --workdir /workspace "$BOOTSTRAP_CONTAINER" psql \
  -U postgres -d "$BOOTSTRAP_DB" -v ON_ERROR_STOP=1 --no-psqlrc \
  -f infra/e2e/bootstrap_roles.sql >/dev/null

docker exec --interactive "$BOOTSTRAP_CONTAINER" psql \
  -U postgres -d "$BOOTSTRAP_DB" -v ON_ERROR_STOP=1 --no-psqlrc >/dev/null <<'SQL'
BEGIN;
SET LOCAL app.workspace_id = '00000000-0000-7000-8000-000000000001';
INSERT INTO invite_code (
  id, workspace_id, code_hash, code_preview, role, max_uses,
  expires_at, created_by
) VALUES (
  '00000000-0000-7000-8000-000000009001',
  '00000000-0000-7000-8000-000000000001',
  public.digest('fresh-order-invite', 'sha256'),
  'vite', 'member', 1, now() + interval '1 hour',
  '00000000-0000-7000-8000-000000000101'
);
COMMIT;
SQL

resolved_workspace=$(docker exec --env PGPASSWORD=momo_app_dev_pw \
  "$BOOTSTRAP_CONTAINER" psql -h 127.0.0.1 -U momo_app -d "$BOOTSTRAP_DB" \
  -tA --no-psqlrc -c "SELECT momo_join_private.invite_workspace_id('fresh-order-invite');")
if [ "$resolved_workspace" != "00000000-0000-7000-8000-000000000001" ]; then
  echo "[role-bootstrap] momo_app lookup returned unexpected workspace: $resolved_workspace" >&2
  exit 1
fi
for denied_role in momo_relay momo_worker momo_notifier; do
  if docker exec --env "PGPASSWORD=${denied_role}_dev_pw" \
    "$BOOTSTRAP_CONTAINER" psql -h 127.0.0.1 -U "$denied_role" -d "$BOOTSTRAP_DB" \
    -v ON_ERROR_STOP=1 --no-psqlrc \
    -c "SELECT momo_join_private.invite_workspace_id('fresh-order-invite');" >/dev/null 2>&1; then
    echo "[role-bootstrap] $denied_role unexpectedly executed private lookup" >&2
    exit 1
  fi
done
echo "[role-bootstrap] PASS migration-before-e2e-role-bootstrap contract"

echo "[role-bootstrap] starting isolated PostgreSQL 18 for production preprovision contract"
PRODUCTION_DB="momo_role_production"
start_postgres "$PRODUCTION_CONTAINER" "$PRODUCTION_DB"
PRODUCTION_URL="postgres://postgres:$POSTGRES_PASSWORD@127.0.0.1:5432/$PRODUCTION_DB"
if docker exec --env "DATABASE_URL=$PRODUCTION_URL" \
  --env MOMO_BOOTSTRAP_RUNTIME_ROLES=0 --workdir /workspace \
  "$PRODUCTION_CONTAINER" sh infra/prod/docker/internal-smoke-migrate.sh >/dev/null 2>&1; then
  echo "[role-bootstrap] production migration accepted absent runtime roles" >&2
  exit 1
fi
schema_migrations=$(docker exec "$PRODUCTION_CONTAINER" psql \
  -U postgres -d "$PRODUCTION_DB" -tA --no-psqlrc \
  -c "SELECT to_regclass('public.schema_migrations') IS NULL;")
if [ "$schema_migrations" != "t" ]; then
  echo "[role-bootstrap] production fail-fast happened after migration started" >&2
  exit 1
fi
echo "[role-bootstrap] PASS production role contract fails before migration"

docker exec --interactive "$PRODUCTION_CONTAINER" psql \
  -U postgres -d "$PRODUCTION_DB" -v ON_ERROR_STOP=1 --no-psqlrc \
  -v app_password="app-$RUN_SUFFIX" \
  -v relay_password="relay-$RUN_SUFFIX" \
  -v worker_password="worker-$RUN_SUFFIX" >/dev/null <<'SQL'
SELECT format(
  'CREATE ROLE momo_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
  :'app_password'
) \gexec
SELECT format(
  'CREATE ROLE momo_relay LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS PASSWORD %L',
  :'relay_password'
) \gexec
SELECT format(
  'CREATE ROLE momo_worker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS PASSWORD %L',
  :'worker_password'
) \gexec
SQL

docker exec --env "DATABASE_URL=$PRODUCTION_URL" \
  --env MOMO_BOOTSTRAP_RUNTIME_ROLES=0 \
  --env MOMO_AGENT_SEED_MODE=e2e \
  --env MIGRATE_IDEMPOTENCY_CHECK=1 \
  --workdir /workspace "$PRODUCTION_CONTAINER" \
  sh infra/prod/docker/internal-smoke-migrate.sh >/dev/null

docker exec "$PRODUCTION_CONTAINER" psql \
  -U postgres -d "$PRODUCTION_DB" -v ON_ERROR_STOP=1 --no-psqlrc >/dev/null <<'SQL'
DO $$
BEGIN
  IF NOT has_schema_privilege('momo_app', 'momo_join_private', 'USAGE')
     OR NOT has_function_privilege('momo_app', 'momo_join_private.invite_workspace_id(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'preprovisioned momo_app did not receive private lookup ACL';
  END IF;
  IF has_schema_privilege('momo_relay', 'momo_join_private', 'USAGE')
     OR has_schema_privilege('momo_worker', 'momo_join_private', 'USAGE')
     OR has_function_privilege('momo_relay', 'momo_join_private.invite_workspace_id(text)', 'EXECUTE')
     OR has_function_privilege('momo_worker', 'momo_join_private.invite_workspace_id(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'private lookup ACL widened to relay/worker';
  END IF;
END $$;
SQL
echo "[role-bootstrap] PASS production preprovision-then-migrate contract"

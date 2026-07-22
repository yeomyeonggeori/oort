#!/usr/bin/env sh
set -eu

cd /workspace

provision_roles=${MOMO_RUNTIME_ROLE_PROVISION:-0}
case "$provision_roles" in
  0) ;;
  1)
    psql "${DATABASE_URL:?set DATABASE_URL}" \
      -v ON_ERROR_STOP=1 \
      --no-psqlrc \
      -f infra/prod/bootstrap_runtime_roles.sql
    exit 0
    ;;
  *)
    echo "[migrate] MOMO_RUNTIME_ROLE_PROVISION must be exactly 0 or 1" >&2
    exit 1
    ;;
esac

bootstrap_roles=${MOMO_BOOTSTRAP_RUNTIME_ROLES:-1}
case "$bootstrap_roles" in
  0)
    role_contract=$(psql "${DATABASE_URL:?set DATABASE_URL}" \
      -tA -v ON_ERROR_STOP=1 --no-psqlrc \
      -c "SELECT count(*) = 3 AND bool_and(rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND CASE WHEN rolname = 'momo_app' THEN NOT rolbypassrls ELSE rolbypassrls END) FROM pg_roles WHERE rolname IN ('momo_app','momo_relay','momo_worker');")
    if [ "$role_contract" != "t" ]; then
      echo "[migrate] required externally provisioned runtime roles are absent or unsafe; refusing to migrate" >&2
      exit 1
    fi
    ;;
  1) ;;
  *)
    echo "[migrate] MOMO_BOOTSTRAP_RUNTIME_ROLES must be exactly 0 or 1" >&2
    exit 1
    ;;
esac

sh scripts/migrate.sh

if [ "$bootstrap_roles" = "1" ]; then
  psql "${DATABASE_URL:?set DATABASE_URL}" \
    -v ON_ERROR_STOP=1 \
    --no-psqlrc \
    -f infra/e2e/bootstrap_roles.sql
fi

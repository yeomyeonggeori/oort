#!/usr/bin/env sh
set -eu

cd /workspace
sh scripts/migrate.sh

if [ "${MOMO_BOOTSTRAP_RUNTIME_ROLES:-1}" = "1" ]; then
  psql "${DATABASE_URL:?set DATABASE_URL}" \
    -v ON_ERROR_STOP=1 \
    --no-psqlrc \
    -f infra/e2e/bootstrap_roles.sql
fi

#!/usr/bin/env sh
# MOMO-538: provision eve's Workflow world in a database isolated from momo.
set -eu

require_identifier() {
  value=$1
  label=$2
  case "$value" in
    ''|*[!a-z0-9_]*)
      echo "[eve-db-roles] $label must contain only lowercase letters, digits, and underscores" >&2
      exit 1
      ;;
    [0-9]*)
      echo "[eve-db-roles] $label must not begin with a digit" >&2
      exit 1
      ;;
  esac
}

eve_db=${EVE_WORLD_DB:-eve_world}
eve_user=${EVE_WORLD_USER:-eve_world}
eve_password=${EVE_WORLD_PASSWORD:-}
momo_db=${MOMO_DB_NAME:-momo}

require_identifier "$eve_db" EVE_WORLD_DB
require_identifier "$eve_user" EVE_WORLD_USER
require_identifier "$momo_db" MOMO_DB_NAME
[ -n "$eve_password" ] || {
  echo "[eve-db-roles] EVE_WORLD_PASSWORD is required" >&2
  exit 1
}

psql -v ON_ERROR_STOP=1 --no-psqlrc \
  -v eve_db="$eve_db" \
  -v eve_user="$eve_user" \
  -v eve_password="$eve_password" \
  -v momo_db="$momo_db" <<'SQL'
SELECT format(
  'CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
  :'eve_user', :'eve_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'eve_user') \gexec

SELECT format(
  'ALTER ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
  :'eve_user', :'eve_password'
) \gexec

SELECT format('CREATE DATABASE %I OWNER %I', :'eve_db', :'eve_user')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'eve_db') \gexec

SELECT format('ALTER DATABASE %I OWNER TO %I', :'eve_db', :'eve_user') \gexec
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'eve_db') \gexec
SELECT format('GRANT CONNECT, TEMPORARY ON DATABASE %I TO %I', :'eve_db', :'eve_user') \gexec

-- The eve credential is never granted a momo runtime role or object ACL. The
-- explicit revokes make reruns fail closed if an operator previously widened it.
SELECT format('REVOKE ALL ON DATABASE %I FROM %I', :'momo_db', :'eve_user') \gexec
SELECT format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', :'eve_user') \gexec
SELECT format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', :'eve_user') \gexec
SELECT format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM %I', :'eve_user') \gexec
SQL

psql -v ON_ERROR_STOP=1 --no-psqlrc --dbname "$eve_db" \
  -v eve_user="$eve_user" <<'SQL'
SELECT format('ALTER SCHEMA public OWNER TO %I', :'eve_user') \gexec
SELECT format('GRANT ALL ON SCHEMA public TO %I', :'eve_user') \gexec
SQL

echo "[eve-db-roles] eve world database ready: $eve_db (momo object grants: none)"

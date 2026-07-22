-- MOMO-554 production runtime role provisioning.
--
-- Run as the database owner before migrations on every install/upgrade. Secrets
-- arrive only through process environment and psql \getenv; the role passwords
-- never appear in argv, stdout, or this file. Re-running rotates them and
-- restores the least-privilege posture.

\getenv app_password MOMO_APP_POSTGRES_PASSWORD
\getenv relay_password RELAY_POSTGRES_PASSWORD
\getenv worker_password WORKER_POSTGRES_PASSWORD

SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', 'momo_app', :'app_password')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_app')
\gexec
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', 'momo_relay', :'relay_password')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_relay')
\gexec
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', 'momo_worker', :'worker_password')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_worker')
\gexec

ALTER ROLE momo_app
  WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
  PASSWORD :'app_password';
ALTER ROLE momo_relay
  WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS
  PASSWORD :'relay_password';
ALTER ROLE momo_worker
  WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS
  PASSWORD :'worker_password';

SELECT format(
  'GRANT CONNECT ON DATABASE %I TO momo_app, momo_relay, momo_worker',
  current_database()
) \gexec

GRANT USAGE ON SCHEMA public TO momo_app, momo_relay, momo_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public
  TO momo_app, momo_relay, momo_worker;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public
  TO momo_app, momo_relay, momo_worker;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO momo_app, momo_relay, momo_worker;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO momo_app, momo_relay, momo_worker;

-- The global catalog is migration-owned. API routes may read it but may mutate
-- only tenant-scoped install/grant rows. Keep this revoke here as well as in 037:
-- a later role-password rotation must not restore broad table writes.
DO $$
BEGIN
  IF to_regclass('public.plugin_registry') IS NOT NULL THEN
    REVOKE INSERT, UPDATE, DELETE ON TABLE plugin_registry FROM momo_app;
  END IF;
END
$$;

DO $$
BEGIN
  IF (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = 'momo_app') THEN
    RAISE EXCEPTION 'momo_app must be NOSUPERUSER NOBYPASSRLS';
  END IF;
  IF NOT (SELECT rolbypassrls AND NOT rolsuper FROM pg_roles WHERE rolname = 'momo_relay') THEN
    RAISE EXCEPTION 'momo_relay must be NOSUPERUSER BYPASSRLS';
  END IF;
  IF NOT (SELECT rolbypassrls AND NOT rolsuper FROM pg_roles WHERE rolname = 'momo_worker') THEN
    RAISE EXCEPTION 'momo_worker must be NOSUPERUSER BYPASSRLS';
  END IF;
END
$$;

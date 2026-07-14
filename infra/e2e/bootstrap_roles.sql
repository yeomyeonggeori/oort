-- MOMO-186 local e2e role bootstrap.
--
-- This is deterministic test-only SQL for infra/docker-compose.e2e.yml.
-- It mirrors the role boundary verified by scripts/verify_rls.sh without changing
-- schema_v0.sql: api=momo_app (NOBYPASSRLS), relay/worker=BYPASSRLS pollers.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_app') THEN
    CREATE ROLE momo_app LOGIN PASSWORD 'momo_app_dev_pw';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_relay') THEN
    CREATE ROLE momo_relay LOGIN PASSWORD 'momo_relay_dev_pw';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_worker') THEN
    CREATE ROLE momo_worker LOGIN PASSWORD 'momo_worker_dev_pw';
  END IF;
END
$$;

ALTER ROLE momo_app
  WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'momo_app_dev_pw';
ALTER ROLE momo_relay
  WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS PASSWORD 'momo_relay_dev_pw';
ALTER ROLE momo_worker
  WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS PASSWORD 'momo_worker_dev_pw';

DO $$
DECLARE
  db_name text := current_database();
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO momo_app, momo_relay, momo_worker', db_name);
END
$$;

GRANT USAGE ON SCHEMA public TO momo_app, momo_relay, momo_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public
  TO momo_app, momo_relay, momo_worker;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public
  TO momo_app, momo_relay, momo_worker;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO momo_app, momo_relay, momo_worker;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO momo_app, momo_relay, momo_worker;

-- Migration 009 can run before these runtime roles exist (the production
-- internal-smoke order). Reassert the locked join boundary after role creation:
-- only the NOBYPASSRLS API role may resolve one invite code to its workspace.
REVOKE ALL ON SCHEMA momo_join_private FROM PUBLIC, momo_relay, momo_worker;
REVOKE ALL ON FUNCTION momo_join_private.invite_workspace_id(text)
  FROM PUBLIC, momo_relay, momo_worker;
GRANT USAGE ON SCHEMA momo_join_private TO momo_app;
GRANT EXECUTE ON FUNCTION momo_join_private.invite_workspace_id(text) TO momo_app;

DO $$
BEGIN
  IF (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = 'momo_app') THEN
    RAISE EXCEPTION 'momo_app must not be superuser or BYPASSRLS';
  END IF;
  IF NOT (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'momo_relay') THEN
    RAISE EXCEPTION 'momo_relay must be BYPASSRLS';
  END IF;
  IF NOT (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'momo_worker') THEN
    RAISE EXCEPTION 'momo_worker must be BYPASSRLS';
  END IF;
  IF NOT has_schema_privilege('momo_app', 'momo_join_private', 'USAGE')
     OR NOT has_function_privilege(
       'momo_app',
       'momo_join_private.invite_workspace_id(text)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'momo_app must execute the locked invite lookup';
  END IF;
  IF has_schema_privilege('momo_relay', 'momo_join_private', 'USAGE')
     OR has_schema_privilege('momo_worker', 'momo_join_private', 'USAGE')
     OR has_function_privilege(
       'momo_relay',
       'momo_join_private.invite_workspace_id(text)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'momo_worker',
       'momo_join_private.invite_workspace_id(text)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'relay/worker must not execute the locked invite lookup';
  END IF;
END
$$;

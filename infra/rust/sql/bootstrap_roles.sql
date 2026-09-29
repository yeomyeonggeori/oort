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
  -- MOMO-404: push notifier consumer (outbox kind='push_candidate'). Its own
  -- credential (relay/worker precedent: one BYPASSRLS role per background
  -- consumer) so notifier DB access stays attributable and revocable.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_notifier') THEN
    CREATE ROLE momo_notifier LOGIN PASSWORD 'momo_notifier_dev_pw';
  END IF;
END
$$;

ALTER ROLE momo_app
  WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'momo_app_dev_pw';
ALTER ROLE momo_relay
  WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS PASSWORD 'momo_relay_dev_pw';
ALTER ROLE momo_worker
  WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS PASSWORD 'momo_worker_dev_pw';
ALTER ROLE momo_notifier
  WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS PASSWORD 'momo_notifier_dev_pw';

DO $$
DECLARE
  db_name text := current_database();
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO momo_app, momo_relay, momo_worker, momo_notifier', db_name);
END
$$;

GRANT USAGE ON SCHEMA public TO momo_app, momo_relay, momo_worker, momo_notifier;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public
  TO momo_app, momo_relay, momo_worker, momo_notifier;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public
  TO momo_app, momo_relay, momo_worker, momo_notifier;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO momo_app, momo_relay, momo_worker, momo_notifier;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO momo_app, momo_relay, momo_worker, momo_notifier;

-- #3161 team memory (ADR-0196): the mem_* write tables are written only through
-- the SECURITY DEFINER functions (mem_apply_digest / mem_advance_cursor /
-- mem_record_serving). The ALL TABLES grant above must not restore direct DML;
-- the RLS write policies are also restricted to mem_definer, this is the second wall.
DO $$
DECLARE r text; f text;
BEGIN
  IF to_regclass('public.mem_digest') IS NOT NULL THEN
    FOREACH r IN ARRAY ARRAY['momo_app', 'momo_relay', 'momo_worker', 'momo_notifier'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON TABLE mem_digest, mem_evidence, mem_cursor, mem_serving FROM %I', r);
      END IF;
    END LOOP;
    FOREACH f IN ARRAY ARRAY[
      'mem_digest_live(uuid)', 'mem_digest_audience_ok(uuid, uuid, uuid)',
      'mem_digest_rollup_inputs(uuid, uuid, text, bigint, bigint)',
      'mem_channel_switch(uuid)',
      'mem_apply_digest(uuid, uuid, text, bigint, bigint, text, uuid[], text, text, text, uuid[])',
      'mem_advance_cursor(uuid, bigint, uuid, timestamptz)',
      'mem_record_serving(uuid, uuid[], uuid[], integer, integer, integer)'
    ] LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO momo_app', f);
    END LOOP;
  END IF;
END
$$;

-- Migration 009 can run before these runtime roles exist (the production
-- internal-smoke order). Reassert the locked join boundary after role creation:
-- only the NOBYPASSRLS API role may resolve one invite code to its workspace.
REVOKE ALL ON SCHEMA momo_join_private FROM PUBLIC, momo_relay, momo_worker, momo_notifier;
REVOKE ALL ON FUNCTION momo_join_private.invite_workspace_id(text)
  FROM PUBLIC, momo_relay, momo_worker, momo_notifier;
GRANT USAGE ON SCHEMA momo_join_private TO momo_app;
GRANT EXECUTE ON FUNCTION momo_join_private.invite_workspace_id(text) TO momo_app;
DO $$
BEGIN
  IF to_regprocedure('momo_join_private.owner_claim_workspace_id(text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION momo_join_private.owner_claim_workspace_id(text)
      FROM PUBLIC, momo_relay, momo_worker, momo_notifier;
    GRANT EXECUTE ON FUNCTION momo_join_private.owner_claim_workspace_id(text) TO momo_app;
  END IF;
  IF to_regprocedure('momo_join_private.device_link_workspace_id(text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION momo_join_private.device_link_workspace_id(text)
      FROM PUBLIC, momo_relay, momo_worker, momo_notifier;
    GRANT EXECUTE ON FUNCTION momo_join_private.device_link_workspace_id(text) TO momo_app;
  END IF;
END $$;

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
  IF NOT (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'momo_notifier') THEN
    RAISE EXCEPTION 'momo_notifier must be BYPASSRLS';
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
     OR has_schema_privilege('momo_notifier', 'momo_join_private', 'USAGE')
     OR has_function_privilege(
       'momo_relay',
       'momo_join_private.invite_workspace_id(text)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'momo_worker',
       'momo_join_private.invite_workspace_id(text)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'momo_notifier',
       'momo_join_private.invite_workspace_id(text)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'relay/worker/notifier must not execute the locked invite lookup';
  END IF;
  IF to_regprocedure('momo_join_private.owner_claim_workspace_id(text)') IS NOT NULL THEN
    IF NOT has_function_privilege(
         'momo_app',
         'momo_join_private.owner_claim_workspace_id(text)',
         'EXECUTE'
       ) THEN
      RAISE EXCEPTION 'momo_app must execute the locked claim lookup';
    END IF;
    IF has_function_privilege(
         'momo_relay',
         'momo_join_private.owner_claim_workspace_id(text)',
         'EXECUTE'
       )
       OR has_function_privilege(
         'momo_worker',
         'momo_join_private.owner_claim_workspace_id(text)',
         'EXECUTE'
       )
       OR has_function_privilege(
         'momo_notifier',
         'momo_join_private.owner_claim_workspace_id(text)',
         'EXECUTE'
       ) THEN
      RAISE EXCEPTION 'relay/worker/notifier must not execute the locked claim lookup';
    END IF;
  END IF;
END
$$;

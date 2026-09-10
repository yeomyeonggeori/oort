-- MOMO-554 production runtime role provisioning.
--
-- Run as the database owner before migrations on every install/upgrade. Secrets
-- arrive only through process environment and psql \getenv; the role passwords
-- never appear in argv, stdout, or this file. Re-running rotates them and
-- restores the least-privilege posture.
--
-- momo-migrate applies this file twice on the self-host path: once before
-- migrations (CREATE ROLE + DEFAULT PRIVILEGES for app/relay/worker) and once
-- after (table-scoped GRANTs for momo_notifier, which need relations).

\getenv app_password MOMO_APP_POSTGRES_PASSWORD
\getenv relay_password RELAY_POSTGRES_PASSWORD
\getenv worker_password WORKER_POSTGRES_PASSWORD
\getenv notifier_password NOTIFIER_POSTGRES_PASSWORD

SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', 'momo_app', :'app_password')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_app')
\gexec
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', 'momo_relay', :'relay_password')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_relay')
\gexec
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', 'momo_worker', :'worker_password')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_worker')
\gexec
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', 'momo_notifier', :'notifier_password')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_notifier')
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
-- Cross-tenant push drain (claim has no workspace predicate). BYPASSRLS is
-- the documented exception for background consumers; tables stay FORCE RLS.
-- Table grants below are SELECT/INSERT/UPDATE only — no DELETE, no owner.
ALTER ROLE momo_notifier
  WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS
  PASSWORD :'notifier_password';

SELECT format(
  'GRANT CONNECT ON DATABASE %I TO momo_app, momo_relay, momo_worker, momo_notifier',
  current_database()
) \gexec

GRANT USAGE ON SCHEMA public TO momo_app, momo_relay, momo_worker, momo_notifier;
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

-- momo_notifier: table-scoped GRANTs only (no ALL TABLES, no DELETE).
-- Relations are absent on the pre-migrate pass; the post-migrate re-apply
-- of this file is what actually lands these grants (#2193).
-- Doctor `roles.momo_notifier` and scripts/tests/test_notifier_role_grants.sh
-- parse every `GRANT … ON TABLE <name> TO momo_notifier` line below — keep
-- that shape (one table per GRANT, no DELETE).
DO $$
BEGIN
  IF to_regclass('public.outbox') IS NOT NULL THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE outbox TO momo_notifier;
  END IF;
  IF to_regclass('public.outbox_id_seq') IS NOT NULL THEN
    GRANT USAGE, SELECT ON SEQUENCE outbox_id_seq TO momo_notifier;
  END IF;
  IF to_regclass('public.push_dispatch_log') IS NOT NULL THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE push_dispatch_log TO momo_notifier;
  END IF;
  IF to_regclass('public.device') IS NOT NULL THEN
    GRANT SELECT ON TABLE device TO momo_notifier;
  END IF;
  IF to_regclass('public.push_token') IS NOT NULL THEN
    GRANT SELECT ON TABLE push_token TO momo_notifier;
  END IF;
  IF to_regclass('public.message') IS NOT NULL THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE message TO momo_notifier;
  END IF;
  IF to_regclass('public.channel') IS NOT NULL THEN
    GRANT SELECT ON TABLE channel TO momo_notifier;
  END IF;
  IF to_regclass('public.membership') IS NOT NULL THEN
    GRANT SELECT ON TABLE membership TO momo_notifier;
  END IF;
  IF to_regclass('public.member') IS NOT NULL THEN
    GRANT SELECT ON TABLE member TO momo_notifier;
  END IF;
  IF to_regclass('public.notification_pref') IS NOT NULL THEN
    GRANT SELECT ON TABLE notification_pref TO momo_notifier;
  END IF;
  IF to_regclass('public.notification_rule') IS NOT NULL THEN
    GRANT SELECT ON TABLE notification_rule TO momo_notifier;
  END IF;
  IF to_regclass('public.approval') IS NOT NULL THEN
    GRANT SELECT, UPDATE ON TABLE approval TO momo_notifier;
  END IF;
  IF to_regclass('public.channel_seq') IS NOT NULL THEN
    GRANT SELECT, UPDATE ON TABLE channel_seq TO momo_notifier;
  END IF;
  IF to_regclass('public.read_state') IS NOT NULL THEN
    GRANT SELECT ON TABLE read_state TO momo_notifier;
  END IF;
  IF to_regclass('public.agent_run') IS NOT NULL THEN
    GRANT SELECT, UPDATE ON TABLE agent_run TO momo_notifier;
  END IF;
  IF to_regclass('public.agent') IS NOT NULL THEN
    GRANT SELECT ON TABLE agent TO momo_notifier;
  END IF;
  IF to_regclass('public.audit_log') IS NOT NULL THEN
    GRANT SELECT, INSERT ON TABLE audit_log TO momo_notifier;
  END IF;
  IF to_regclass('public.display_control_window') IS NOT NULL THEN
    GRANT SELECT, UPDATE ON TABLE display_control_window TO momo_notifier;
  END IF;
  -- `workspace` is not on the notifier call graph (#2448). The only
  -- `SELECT … FROM workspace` in momo-t3 is `topup_credit_in_tx`
  -- (billing.rs), called from momo-server credits — not from
  -- momo-notifier. Do not re-add without a cited reachable statement.
  IF to_regclass('public.work_cloud_host') IS NOT NULL THEN
    GRANT SELECT, UPDATE ON TABLE work_cloud_host TO momo_notifier;
  END IF;
  IF to_regclass('public.work_session') IS NOT NULL THEN
    GRANT SELECT, UPDATE ON TABLE work_session TO momo_notifier;
  END IF;
  IF to_regclass('public.work_control') IS NOT NULL THEN
    GRANT SELECT ON TABLE work_control TO momo_notifier;
  END IF;
  IF to_regclass('public.work_host') IS NOT NULL THEN
    GRANT SELECT, UPDATE ON TABLE work_host TO momo_notifier;
  END IF;
  IF to_regclass('public.work_host_usage') IS NOT NULL THEN
    GRANT SELECT, UPDATE ON TABLE work_host_usage TO momo_notifier;
  END IF;
  IF to_regclass('public.work_host_usage_interval') IS NOT NULL THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE work_host_usage_interval TO momo_notifier;
  END IF;
  -- `work_pool` is not on the notifier call graph (#2448).
  -- `acquire_row_ladder` INSERT/SELECT is behind `lock_work_pool`; every
  -- notifier ladder is `T3LockLadder::host` or `.with_workspace_credit()`
  -- (`lock_work_pool = false`). Slot admission (`reserve_provisioning_slot_in_tx`,
  -- `acquire_slot_in_tx`) is REST / agent-worker. Do not re-add without a
  -- cited reachable statement.
  IF to_regclass('public.work_tier_policy') IS NOT NULL THEN
    GRANT SELECT ON TABLE work_tier_policy TO momo_notifier;
  END IF;
  -- SELECT FOR UPDATE: terminate ladder (`acquire_row_ladder` when
  -- `lock_workspace_credit`, plus `t3_terminate` 058). INSERT+UPDATE:
  -- `apply_credit_entry` (045:122-136) runs as the invoker on
  -- `credit_entry` INSERT from `t3_terminate`. PostgreSQL requires INSERT
  -- for `INSERT … ON CONFLICT DO UPDATE` even when the existing row takes
  -- the UPDATE path — do not drop INSERT.
  IF to_regclass('public.workspace_credit') IS NOT NULL THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE workspace_credit TO momo_notifier;
  END IF;
  IF to_regclass('public.credit_entry') IS NOT NULL THEN
    GRANT INSERT ON TABLE credit_entry TO momo_notifier;
  END IF;
  IF to_regprocedure('acquire_t3_lifecycle_lock(uuid)') IS NOT NULL THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION acquire_t3_lifecycle_lock(uuid) TO momo_notifier';
  END IF;
  IF to_regprocedure('t3_claim_lifecycle_operation(uuid, interval)') IS NOT NULL THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION t3_claim_lifecycle_operation(uuid, interval) TO momo_notifier';
  END IF;
  IF to_regprocedure('t3_lifecycle_intent_is_current(uuid, uuid, bigint, text)') IS NOT NULL THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION t3_lifecycle_intent_is_current(uuid, uuid, bigint, text) TO momo_notifier';
  END IF;
  IF to_regprocedure('t3_terminate(uuid, uuid, text)') IS NOT NULL THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION t3_terminate(uuid, uuid, text) TO momo_notifier';
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
  IF NOT (SELECT rolbypassrls AND NOT rolsuper FROM pg_roles WHERE rolname = 'momo_notifier') THEN
    RAISE EXCEPTION 'momo_notifier must be NOSUPERUSER BYPASSRLS';
  END IF;
END
$$;

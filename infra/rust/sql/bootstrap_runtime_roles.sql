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
DO $$
BEGIN
  IF to_regclass('public.outbox') IS NOT NULL THEN
    GRANT SELECT, UPDATE ON TABLE outbox TO momo_notifier;
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
    GRANT SELECT ON TABLE message TO momo_notifier;
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
    GRANT SELECT ON TABLE approval TO momo_notifier;
  END IF;
  IF to_regclass('public.channel_seq') IS NOT NULL THEN
    GRANT SELECT ON TABLE channel_seq TO momo_notifier;
  END IF;
  IF to_regclass('public.read_state') IS NOT NULL THEN
    GRANT SELECT ON TABLE read_state TO momo_notifier;
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

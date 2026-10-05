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

-- BEGIN mem-lockdown (#3161 / #3186; ADR-0196 D6-6). Identical in 101_mem_lockdown_hardening.sql,
-- bootstrap_roles.sql and bootstrap_runtime_roles.sql; tests compare the text between the markers.
-- Runs after the runtime roles exist and after any ALL TABLES grant. Worker-only functions:
-- EXECUTE for momo_memory only; the BYPASSRLS roles never touch mem_* rows; momo_app reads (RLS)
-- and edits only its settings (no TRUNCATE / REFERENCES / TRIGGER even there). Tables, views and
-- materialized views named mem_* are all walked, so a later one is locked by default.
DO $$
DECLARE
  r text;
  t text;
  f text;
  runtime_roles text[] := ARRAY['momo_app', 'momo_relay', 'momo_worker', 'momo_notifier', 'momo_platform_admin'];
  worker_only text[] := ARRAY[
    'mem_add_item(uuid, text, text, text, uuid[], real, boolean, text, text)',
    'mem_adjust_tokens(bigint)',
    'mem_advance_cursor(uuid, bigint, uuid, timestamptz)',
    'mem_apply_digest(uuid, uuid, text, bigint, bigint, text, uuid[], text, text, text, uuid[], timestamptz[], timestamptz)',
    'mem_channel_eligible(uuid)',
    'mem_channel_switch(uuid)',
    'mem_cons_apply(uuid, uuid, text)',
    'mem_cons_begin(uuid, uuid, double precision, timestamptz)',
    'mem_cons_decay(uuid, integer)',
    'mem_cons_defer_pair(uuid, uuid)',
    'mem_cons_finish(uuid, uuid, boolean, integer)',
    'mem_cons_pairs(uuid, real, real, integer)',
    'mem_cons_purge_proposals(uuid)',
    'mem_cons_reconcile(uuid)',
    'mem_cons_renew(uuid, uuid, double precision)',
    'mem_cons_retention(uuid, integer, integer, integer)',
    'mem_cons_retire_dead(uuid, integer)',
    'mem_cons_revert(uuid)',
    'mem_cursor_state(uuid)',
    'mem_digest_audience_ok(uuid, uuid, uuid)',
    'mem_digest_index(uuid, text, bigint)',
    'mem_digest_live(uuid)',
    'mem_digest_rollup_inputs(uuid, uuid, text, bigint, bigint)',
    'mem_drop_digest(uuid)',
    'mem_embedding_stats(text)',
    'mem_item_audience_ok(uuid, uuid, uuid)',
    'mem_item_live(uuid)',
    'mem_item_readable_by(uuid, uuid)',
    'mem_items_to_embed(text, integer)',
    'mem_propose_item(uuid, text, text, text, uuid[])',
    'mem_record_serving(uuid, uuid, uuid[], uuid[], integer, integer, integer)',
    'mem_reserve_tokens(bigint, bigint)',
    'mem_search_items_for(uuid, text, integer, uuid)',
    'mem_serve_candidates(uuid, bigint, integer, integer)',
    'mem_serve_items_fused(uuid, integer, integer, text, text, real, real)',
    'mem_serve_items(uuid, integer, integer)',
    'mem_serve_query(uuid)',
    'mem_serve_requester(uuid)',
    'mem_serving_of(uuid)',
    'mem_serving_record_of(uuid)',
    'mem_set_item_embedding(uuid, text, text)',
    'mem_stale_digests(integer, integer)',
    'mem_suppressed_messages(uuid, uuid[])',
    'mem_token_budget(bigint)',
    'mem_topic_assign(uuid, uuid, text, integer)',
    'mem_topic_gc(uuid)',
    'mem_topic_leaves(uuid)',
    'mem_topic_revert(uuid)',
    'mem_topic_set_summary(uuid, text, uuid[], text, text)',
    'mem_topic_split_apply(uuid, text[], uuid[], integer[], integer)',
    'mem_topic_split_candidates(uuid, integer, integer)',
    'mem_topic_summary_work(uuid, integer, integer, integer)',
    'mem_topic_unassigned(uuid, integer)'
  ];
BEGIN
  IF to_regclass('public.mem_digest') IS NULL THEN
    RETURN;
  END IF;
  FOR t IN SELECT c.relname::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm') AND c.relname LIKE 'mem\_%' LOOP
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', t);
    FOREACH r IN ARRAY runtime_roles LOOP
      CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r);
      IF r = 'momo_app' AND t = 'mem_settings' THEN
        EXECUTE format('REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE public.%I FROM %I', t, r);
      ELSIF r = 'momo_app' AND t IN ('mem_topic', 'mem_topic_summary') THEN
        -- #3172 B-4: no read route exists yet, so the API role has no SELECT on the topic tables either.
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', t, r);
      ELSIF r = 'momo_app' THEN
        EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.%I FROM %I', t, r);
      ELSE
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', t, r);
      END IF;
    END LOOP;
  END LOOP;
  FOREACH f IN ARRAY worker_only LOOP
    -- L-9 (#3200): the list names every worker-only function of every migration; an older database that
    -- has not run a later migration yet simply does not have some of them.
    CONTINUE WHEN to_regprocedure(format('public.%s', f)) IS NULL;
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC', f);
    FOREACH r IN ARRAY runtime_roles LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM %I', f, r);
      END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_memory') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO momo_memory', f);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mem_definer') THEN
    FOREACH r IN ARRAY runtime_roles LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r)
         AND pg_has_role(r, 'mem_definer', 'MEMBER') THEN
        EXECUTE format('REVOKE mem_definer FROM %I', r);
      END IF;
    END LOOP;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_memory') THEN
    FOREACH r IN ARRAY runtime_roles LOOP
      IF r <> 'momo_worker' AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r)
         AND pg_has_role(r, 'momo_memory', 'MEMBER') THEN
        EXECUTE format('REVOKE momo_memory FROM %I', r);
      END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_worker') THEN
      GRANT momo_memory TO momo_worker WITH INHERIT FALSE, SET TRUE;
    END IF;
  END IF;
END
$$;

-- Membership self-check (fails loudly): no runtime role may be a member of mem_definer, and
-- momo_worker is the only one that may reach momo_memory (SET only, no inheritance). PUBLIC
-- cannot be a role member, so it is covered by the privilege matrix instead.
DO $$
DECLARE
  r text;
  runtime_roles text[] := ARRAY['momo_app', 'momo_relay', 'momo_worker', 'momo_notifier', 'momo_platform_admin'];
BEGIN
  IF to_regclass('public.mem_digest') IS NULL THEN
    RETURN;
  END IF;
  FOREACH r IN ARRAY runtime_roles LOOP
    CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mem_definer')
       AND pg_has_role(r, 'mem_definer', 'MEMBER') THEN
      RAISE EXCEPTION 'runtime role % must not be a member of mem_definer', r;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_memory') THEN
      IF r <> 'momo_worker' AND pg_has_role(r, 'momo_memory', 'MEMBER') THEN
        RAISE EXCEPTION 'runtime role % must not be a member of momo_memory', r;
      END IF;
      IF r = 'momo_worker' AND pg_has_role(r, 'momo_memory', 'USAGE') THEN
        RAISE EXCEPTION 'momo_worker must hold momo_memory with INHERIT FALSE (SET only)';
      END IF;
    END IF;
  END LOOP;
END
$$;
-- END mem-lockdown

-- BEGIN cloud-box-lockdown (#3500 security review M1; ADR-0197 D10). Identical in bootstrap_roles.sql and
-- bootstrap_runtime_roles.sql; idempotent (re-applied on every pre-deploy, and a no-op before migration 118).
-- The BYPASSRLS roles (relay/worker/notifier) never touch box rows: a runner polls inside a tenant tx as momo_app.
-- momo_app may SELECT/INSERT/UPDATE only; rows are never deleted by the API role (a box row is a tombstone
-- until `deleted`, and `deleted` rows are kept).
DO $$
DECLARE
  t text;
  r text;
BEGIN
  FOREACH t IN ARRAY ARRAY['cloud_box', 'cloud_box_control', 'cloud_box_runner'] LOOP
    CONTINUE WHEN to_regclass('public.' || t) IS NULL;
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', t);
    FOREACH r IN ARRAY ARRAY['momo_relay', 'momo_worker', 'momo_notifier'] LOOP
      CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r);
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', t, r);
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_app') THEN
      EXECUTE format('REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.%I FROM momo_app', t);
      EXECUTE format('GRANT SELECT, INSERT, UPDATE ON TABLE public.%I TO momo_app', t);
    END IF;
  END LOOP;
  IF to_regclass('public.cloud_box_control_seq_seq') IS NOT NULL THEN
    FOREACH r IN ARRAY ARRAY['momo_relay', 'momo_worker', 'momo_notifier'] LOOP
      CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r);
      EXECUTE format('REVOKE ALL ON SEQUENCE public.cloud_box_control_seq_seq FROM %I', r);
    END LOOP;
  END IF;
END
$$;
-- END cloud-box-lockdown

-- #3212 (migration 110): the memory reset and the team-notice read are API entry points reserved for momo_app
-- (not PUBLIC). Migration 110 can run before the runtime roles exist, so reassert the grant here.
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['mem_reset_workspace(bigint)', 'mem_summary_provider()'] LOOP
    IF to_regprocedure('public.' || f) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC', f);
      EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO momo_app', f);
    END IF;
  END LOOP;
END $$;

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
  -- INVOKER trigger `enforce_work_cloud_host_transition` (053:49-70) SELECTs
  -- this table on every `UPDATE work_cloud_host` (declare_destroy_intent /
  -- t3_terminate / confirm). Without SELECT the T3 stale sweep dies:
  -- `permission denied for table work_cloud_host_transition` (#2448 R2 F-1).
  IF to_regclass('public.work_cloud_host_transition') IS NOT NULL THEN
    GRANT SELECT ON TABLE work_cloud_host_transition TO momo_notifier;
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
  -- INVOKER 033: work_session status UPDATE (T3 stale sweep) and message
  -- INSERT/props UPDATE call enqueue_event_subscription_delivery, which
  -- `SELECT … FROM event_subscription`. Zero matching rows still need SELECT.
  IF to_regclass('public.event_subscription') IS NOT NULL THEN
    GRANT SELECT ON TABLE event_subscription TO momo_notifier;
  END IF;
  -- INVOKER 079: AFTER INSERT ON message → enqueue_unfurl_job may
  -- `INSERT INTO unfurl_job`. Privilege is checked if the body matches.
  IF to_regclass('public.unfurl_job') IS NOT NULL THEN
    GRANT INSERT ON TABLE unfurl_job TO momo_notifier;
  END IF;
  -- #3377 (v0.1.16 incident). The cross-tenant candidate READS of the two-pool
  -- sweeps run on the notifier pool; every write of those sweeps goes through the
  -- RLS-bound `momo_app` pool, so none of these is more than SELECT — and where
  -- the read touches a few columns of a table that also holds names or labels,
  -- the grant is column-level (parsed by test_notifier_role_grants.sh as
  -- `GRANT SELECT (cols) ON <table>`, a shape the table-grant parsers skip).
  --  * share retention (#2862): workspaces_with_expired_shares joins
  --    work_session_share to work_session (granted above) on workspace_id and
  --    session_id; repo_label / branch / PR / stage markers stay unreadable.
  --  * avatar reclaim (#3284): candidate_sql scans member_avatar_media and
  --    workspace_avatar_media (ids, status, timestamps, drive_file_id — not the
  --    file name, mime or member); the "is it somebody's current avatar" test
  --    reads member (granted above) and workspace.avatar_media_id, the one
  --    column of `workspace` the notifier may read (#2448: no table SELECT).
  --  * huddle ghost sweep (#2758): active_huddles_for_sweep selects huddle and
  --    huddle_participant (ids and timestamps). Latent since v0.1.10: it only
  --    runs with LiveKit configured on the notifier, which is why no deploy
  --    tripped on it yet.
  IF to_regclass('public.work_session_share') IS NOT NULL THEN
    GRANT SELECT (workspace_id, session_id) ON work_session_share TO momo_notifier;
  END IF;
  IF to_regclass('public.member_avatar_media') IS NOT NULL THEN
    GRANT SELECT (id, workspace_id, drive_file_id, status, created_at, drive_reclaimed_at)
      ON member_avatar_media TO momo_notifier;
  END IF;
  IF to_regclass('public.workspace_avatar_media') IS NOT NULL THEN
    GRANT SELECT (id, workspace_id, drive_file_id, status, created_at, drive_reclaimed_at)
      ON workspace_avatar_media TO momo_notifier;
  END IF;
  IF to_regclass('public.workspace') IS NOT NULL THEN
    GRANT SELECT (avatar_media_id) ON workspace TO momo_notifier;
  END IF;
  IF to_regclass('public.huddle') IS NOT NULL THEN
    GRANT SELECT ON TABLE huddle TO momo_notifier;
  END IF;
  IF to_regclass('public.huddle_participant') IS NOT NULL THEN
    GRANT SELECT ON TABLE huddle_participant TO momo_notifier;
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

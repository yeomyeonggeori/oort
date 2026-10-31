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

-- BEGIN scheduled-message-lockdown (#4214; ADR-0208 D3·D6). Identical in 145_scheduled_message.sql,
-- bootstrap_roles.sql and bootstrap_runtime_roles.sql; tests compare the text between the markers.
-- Idempotent and order-proof: a pass before the migration (no tables, no functions) or before the runtime
-- roles exist finishes what it can; the pass after lands the rest. The BYPASSRLS roles skip RLS, so their
-- table privileges are what keeps a pending body away from them. momo_app keeps all four (the tick and the
-- retention sweep DELETE as momo_app). Then the self-check fails loudly: without it the tick would read
-- nothing and report nothing.
DO $$
DECLARE
  t text;
  r text;
  f text;
  sealed text[] := ARRAY['momo_relay', 'momo_worker', 'momo_notifier', 'momo_platform_admin'];
BEGIN
  FOREACH t IN ARRAY ARRAY['scheduled_message', 'scheduled_message_attachment'] LOOP
    CONTINUE WHEN to_regclass('public.' || t) IS NULL;
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', t);
    FOREACH r IN ARRAY sealed LOOP
      CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r);
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', t, r);
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_app') THEN
      EXECUTE format('REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE public.%I FROM momo_app', t);
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO momo_app', t);
    END IF;
  END LOOP;
  IF to_regnamespace('momo_schedule_private') IS NOT NULL THEN
    REVOKE ALL ON SCHEMA momo_schedule_private FROM PUBLIC;
    FOREACH r IN ARRAY sealed LOOP
      CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r);
      EXECUTE format('REVOKE ALL ON SCHEMA momo_schedule_private FROM %I', r);
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_app') THEN
      GRANT USAGE ON SCHEMA momo_schedule_private TO momo_app;
    END IF;
  END IF;
  FOREACH f IN ARRAY ARRAY[
    'momo_schedule_private.due_scheduled_messages(integer)',
    'momo_schedule_private.expired_scheduled_messages(integer)'
  ] LOOP
    CONTINUE WHEN to_regprocedure(f) IS NULL;
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    FOREACH r IN ARRAY sealed LOOP
      CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r);
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', f, r);
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_app') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO momo_app', f);
    END IF;
  END LOOP;
END
$$;

DO $$
DECLARE
  t text;
  r text;
  f text;
  p text;
  sealed text[] := ARRAY['momo_relay', 'momo_worker', 'momo_notifier', 'momo_platform_admin'];
BEGIN
  FOREACH t IN ARRAY ARRAY['scheduled_message', 'scheduled_message_attachment'] LOOP
    CONTINUE WHEN to_regclass('public.' || t) IS NULL;
    FOREACH r IN ARRAY sealed LOOP
      CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r);
      FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
        IF has_table_privilege(r, format('public.%I', t), p) THEN
          RAISE EXCEPTION 'role % must hold no % on %', r, p, t;
        END IF;
      END LOOP;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_app') THEN
      FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
        IF NOT has_table_privilege('momo_app', format('public.%I', t), p) THEN
          RAISE EXCEPTION 'momo_app must hold % on %', p, t;
        END IF;
      END LOOP;
    END IF;
  END LOOP;
  IF to_regnamespace('momo_schedule_private') IS NOT NULL THEN
    FOREACH r IN ARRAY sealed LOOP
      CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r);
      IF has_schema_privilege(r, 'momo_schedule_private', 'USAGE') THEN
        RAISE EXCEPTION 'role % must not use schema momo_schedule_private', r;
      END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_app')
       AND NOT has_schema_privilege('momo_app', 'momo_schedule_private', 'USAGE') THEN
      RAISE EXCEPTION 'momo_app must use schema momo_schedule_private';
    END IF;
  END IF;
  FOREACH f IN ARRAY ARRAY[
    'momo_schedule_private.due_scheduled_messages(integer)',
    'momo_schedule_private.expired_scheduled_messages(integer)'
  ] LOOP
    CONTINUE WHEN to_regprocedure(f) IS NULL;
    IF has_function_privilege('public', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'PUBLIC must not execute %', f;
    END IF;
    FOREACH r IN ARRAY sealed LOOP
      CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r);
      IF has_function_privilege(r, f, 'EXECUTE') THEN
        RAISE EXCEPTION 'role % must not execute %', r, f;
      END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_app')
       AND NOT has_function_privilege('momo_app', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'momo_app must execute %', f;
    END IF;
    -- 소유자 posture: 최소 권한 정의자 역할, 본문 열 권한 없음, 어느 런타임 역할의 멤버도 아님.
    IF NOT EXISTS (
         SELECT 1 FROM pg_proc p JOIN pg_roles o ON o.oid = p.proowner
          WHERE p.oid = to_regprocedure(f)
            AND o.rolname = 'momo_sched_definer'
            AND NOT (o.rolsuper OR o.rolbypassrls OR o.rolcanlogin)
       ) THEN
      RAISE EXCEPTION '% must be owned by the NOLOGIN NOSUPERUSER NOBYPASSRLS role momo_sched_definer', f;
    END IF;
    IF has_column_privilege('momo_sched_definer', 'public.scheduled_message', 'body', 'SELECT') THEN
      RAISE EXCEPTION 'momo_sched_definer must not read scheduled_message.body';
    END IF;
    FOREACH r IN ARRAY (sealed || ARRAY['momo_app']) LOOP
      CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r);
      IF pg_has_role(r, 'momo_sched_definer', 'MEMBER') THEN
        RAISE EXCEPTION 'runtime role % must not be a member of momo_sched_definer', r;
      END IF;
    END LOOP;
  END LOOP;
END
$$;
-- END scheduled-message-lockdown

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

-- #4381 (migration 147): the ten API-side mem_* definer functions (six API entry points and the four RLS
-- policy helpers) are executable by momo_app only, not PUBLIC. Migration 147 can run before the runtime roles exist,
-- so reassert the grant here.
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'mem_accept_proposal(uuid)', 'mem_digest_evidence_ok(uuid)', 'mem_edit_item(uuid,text,text)',
    'mem_forget_item(uuid)', 'mem_item_evidence_ok(uuid)', 'mem_proposal_evidence_ok(uuid)',
    'mem_reject_proposal(uuid)', 'mem_revert_consolidation(uuid)',
    'mem_search_items(text,integer,uuid,text)', 'mem_topic_summary_ok(uuid)'
  ] LOOP
    IF to_regprocedure('public.' || f) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC', f);
      EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO momo_app', f);
    END IF;
  END LOOP;
END $$;

-- BEGIN catalog-readonly-lockdown (#4372; SEC-04 follow-up). Identical in bootstrap_roles.sql and
-- bootstrap_runtime_roles.sql; tests compare the text between the markers.
-- plugin_registry (013), schema_migrations (momo_db::migrate / migrate.sh) and work_cloud_host_transition
-- (053/057) carry no tenant rows and no RLS, and only migrations (the schema owner) ever write them: the
-- routes read plugin_registry, the T3 trigger only SELECTs the transition table. The ALL TABLES grant above
-- (and DEFAULT PRIVILEGES for tables a migration creates later) hands every runtime role DML on them, so a
-- compromised API session could add a plugin, rewrite the migration ledger or open an illegal host
-- transition. Revoke every write-class verb; SELECT stays. Reasserted on both passes of momo-migrate.
DO $$
DECLARE
  r text;
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['plugin_registry', 'schema_migrations', 'work_cloud_host_transition'] LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      CONTINUE;
    END IF;
    FOREACH r IN ARRAY ARRAY['momo_app', 'momo_relay', 'momo_worker', 'momo_notifier', 'momo_platform_admin'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.%I FROM %I', t, r);
      END IF;
    END LOOP;
  END LOOP;
END $$;
-- END catalog-readonly-lockdown

-- BEGIN self-media-token-lockdown (#4820 C2a security review L6; ADR-0218 G4). Identical in
-- 160_self_media_token.sql, bootstrap_roles.sql and bootstrap_runtime_roles.sql; tests compare the text
-- between the markers. A row of this table opens one requester's attachment to whoever presents the
-- token, and the BYPASSRLS roles skip RLS, so their table privileges are what keeps a forged row (any
-- run, requester and attachment) away from a role with no business writing one. Each runtime role gets
-- exactly what the flow uses: momo_worker mints (INSERT) and sweeps day-old rows (DELETE) and reads what
-- it writes (SELECT); momo_app spends a token (UPDATE ... RETURNING, so SELECT too) and never creates or
-- deletes one; relay, notifier and platform_admin do not touch it at all. A foreign-key cascade (attachment,
-- run, workspace) runs as the table's owner, so deleting a parent still clears its rows. Idempotent and
-- order-proof (a pass before the table or the roles exist finishes what it can, the pass after lands the
-- rest), and it fails loudly if the result is not what is written here.
DO $$
DECLARE
  r text;
  p text;
  allowed text[];
BEGIN
  IF to_regclass('public.self_media_token') IS NULL THEN
    RETURN;
  END IF;
  REVOKE ALL ON TABLE public.self_media_token FROM PUBLIC;
  FOREACH r IN ARRAY ARRAY['momo_app', 'momo_relay', 'momo_worker', 'momo_notifier', 'momo_platform_admin'] LOOP
    CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r);
    allowed := CASE r
      WHEN 'momo_app' THEN ARRAY['SELECT', 'UPDATE']
      WHEN 'momo_worker' THEN ARRAY['SELECT', 'INSERT', 'DELETE']
      ELSE ARRAY[]::text[]
    END;
    EXECUTE format('REVOKE ALL ON TABLE public.self_media_token FROM %I', r);
    IF cardinality(allowed) > 0 THEN
      EXECUTE format('GRANT %s ON TABLE public.self_media_token TO %I', array_to_string(allowed, ', '), r);
    END IF;
    FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
      IF has_table_privilege(r, 'public.self_media_token', p) IS DISTINCT FROM (p = ANY (allowed)) THEN
        RAISE EXCEPTION 'role % must % % on self_media_token',
          r, CASE WHEN p = ANY (allowed) THEN 'hold' ELSE 'not hold' END, p;
      END IF;
    END LOOP;
  END LOOP;
END $$;
-- END self-media-token-lockdown

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

-- BEGIN helper-read (#3894; ADR-0201 증보 v2 H4-2). Identical in bootstrap_roles.sql and
-- bootstrap_runtime_roles.sql; a no-op before migration 138. The team AI's read tools run as the
-- worker with `SET LOCAL ROLE momo_helper_read` (NOBYPASSRLS, SELECT only), so momo_worker may SET
-- that role but never inherits it, and no other runtime role is a member.
DO $$
DECLARE
  r text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_helper_read') THEN
    RETURN;
  END IF;
  FOREACH r IN ARRAY ARRAY['momo_app', 'momo_relay', 'momo_notifier'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r)
       AND pg_has_role(r, 'momo_helper_read', 'MEMBER') THEN
      EXECUTE format('REVOKE momo_helper_read FROM %I', r);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_worker') THEN
    GRANT momo_helper_read TO momo_worker WITH INHERIT FALSE, SET TRUE;
    IF pg_has_role('momo_worker', 'momo_helper_read', 'USAGE') THEN
      RAISE EXCEPTION 'momo_worker must hold momo_helper_read with INHERIT FALSE (SET only)';
    END IF;
  END IF;
  IF (SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = 'momo_helper_read') THEN
    RAISE EXCEPTION 'momo_helper_read must be NOSUPERUSER NOBYPASSRLS';
  END IF;
END
$$;
-- END helper-read

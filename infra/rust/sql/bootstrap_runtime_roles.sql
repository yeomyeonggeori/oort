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

-- momo_notifier: table-scoped GRANTs only (no ALL TABLES, no DELETE).
-- Relations are absent on the pre-migrate pass; the post-migrate re-apply
-- of this file is what actually lands these grants (#2193).
-- Doctor `roles.momo_notifier` and scripts/tests/test_notifier_role_grants.sh
-- parse every `GRANT … ON TABLE <name> TO momo_notifier` line below — keep
-- that shape (one table per GRANT, no DELETE).
DO $$
BEGIN
  IF to_regclass('public.expression_draft') IS NOT NULL THEN
    GRANT SELECT (workspace_id,state,expires_at) ON expression_draft TO momo_notifier;
  END IF;
  -- ADR-0218 G3.6 (#4820 C1b): the held assemblies' TTL is swept with the drafts', so the
  -- notifier discovers the tenants with something expired from the same three columns.
  IF to_regclass('public.expression_assembly') IS NOT NULL THEN
    GRANT SELECT (workspace_id,state,expires_at) ON expression_assembly TO momo_notifier;
  END IF;
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
    -- ADR-0204 D9 / #3930: APNs 410 / BadDeviceToken / DeviceTokenNotForTopic
    -- invalidate the token (`UPDATE push_token SET invalidated_at = now(),
    -- updated_at = now() WHERE id = $1 AND workspace_id = $2 AND invalidated_at IS
    -- NULL`, settled with the dispatch receipt). Two COLUMNS, never the table: the
    -- notifier must not be able to rewrite `apns_token`, `member_id` or `device_id`.
    -- The WHERE columns are covered by the table-level SELECT above. The dev file
    -- hands the notifier every verb on every table, so only the production-role
    -- suite (scripts/verify_notifier_prod_roles.sh) can see this line go missing.
    -- Column shape (no `ON TABLE`): the doctor's table parser must not read it as a
    -- table grant; scripts/tests/test_notifier_role_grants.sh judges it per column.
    GRANT UPDATE (invalidated_at, updated_at) ON push_token TO momo_notifier;
  END IF;
  IF to_regclass('public.message') IS NOT NULL THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE message TO momo_notifier;
  END IF;
  -- ADR-0199 / #3680: the message INSERT above fires the inbox projection trigger
  -- (migration 126, SECURITY INVOKER), which upserts inbox_item as the writer.
  -- Without this the notifier's own message writes would die with
  -- `permission denied for table inbox_item`. No DELETE: retention runs on the
  -- RLS-bound momo_app pool.
  IF to_regclass('public.inbox_item') IS NOT NULL THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE inbox_item TO momo_notifier;
  END IF;
  IF to_regclass('public.channel') IS NOT NULL THEN
    GRANT SELECT ON TABLE channel TO momo_notifier;
  END IF;
  IF to_regclass('public.membership') IS NOT NULL THEN
    GRANT SELECT ON TABLE membership TO momo_notifier;
  END IF;
  IF to_regclass('public.dm_agent_admission') IS NOT NULL THEN
    GRANT SELECT ON TABLE dm_agent_admission TO momo_notifier;
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
  -- ADR-0204 증보 3 / #4018: the push judgment reads the presence heartbeat.
  IF to_regclass('public.channel_viewing') IS NOT NULL THEN
    GRANT SELECT ON TABLE channel_viewing TO momo_notifier;
  END IF;
  -- ADR-0206 증보 1 F1 / #4889 2단계 (migration 165): the `thread_reply` arm of the push
  -- judgment reads who follows the thread. SELECT only — the rows are made by momo_app
  -- (follow API) and momo_worker (the agent worker's send), never by the notifier: its own
  -- message writes are ThreadPolicy::Skip and never reach the automatic follow.
  IF to_regclass('public.thread_follow') IS NOT NULL THEN
    GRANT SELECT ON TABLE thread_follow TO momo_notifier;
  END IF;
  IF to_regclass('public.agent_run') IS NOT NULL THEN
    GRANT SELECT, UPDATE ON TABLE agent_run TO momo_notifier;
  END IF;
  -- ADR-0200 / #3740: the approval-expiry sweep's UPDATE of approval/agent_run fires
  -- the run-event ledger triggers (migration 128, SECURITY INVOKER), which append to
  -- agent_run_event as the writer. Without this the sweep would die with
  -- `permission denied for table agent_run_event`. No UPDATE/DELETE: only the stage
  -- cap (momo_app) deletes.
  IF to_regclass('public.agent_run_event') IS NOT NULL THEN
    GRANT SELECT, INSERT ON TABLE agent_run_event TO momo_notifier;
  END IF;
  IF to_regclass('public.agent_run_event_seq') IS NOT NULL THEN
    GRANT USAGE, SELECT ON SEQUENCE agent_run_event_seq TO momo_notifier;
  END IF;
  -- ADR-0200 증보 2026-10-15 / #3840: the run-event retention sweep's cross-tenant
  -- read (`workspaces_with_expired_run_events`) also finds a finished run by its oort
  -- tool-call tally. SELECT only — the tally DELETE runs on the RLS-bound momo_app pool.
  IF to_regclass('public.agent_run_tool_tally') IS NOT NULL THEN
    GRANT SELECT ON TABLE agent_run_tool_tally TO momo_notifier;
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
  --  * hosted work-run existence test (#3553, v0.1.18): the push judgment's
  --    `wrun` arm (judgment.rs, #3517) and migration 120's `agent_run` status
  --    trigger (fired by the approval-expiry and control-window sweeps' UPDATEs)
  --    both ask only `EXISTS (… hc.workspace_id = … AND hc.agent_member_id = …)`.
  --    The table also holds pairing_challenge_hash, active_token_id and the
  --    cleanup manifest, so the grant is exactly those two columns.
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
  --  * attachment reclaim (#4443, ADR-0151 증보 2): workspaces_with_reclaim_candidates asks
  --    `attachment` ONE cross-tenant question — which workspaces hold a completed file no
  --    message and no schedule holds — and answers workspace ids only (`GROUP BY
  --    workspace_id`). It reads the status, the message link, the two reservation columns
  --    migration 150 mirrors from the owner-scoped scheduled_message_attachment, and the
  --    upload time. Not the attachment id, drive_file_id, name, mime, size or the
  --    uploader: the momo_app tenant transactions list, count (files and bytes), re-check
  --    and delete. The reservation table itself stays sealed from this role (ADR-0208 D3).
  --    This file also runs BEFORE a release's migrations (Railway pre-deploy, compose
  --    `runtime-roles`), and `reserved` / `unreserved_at` arrive in migration 150: on an
  --    upgrade that first pass finds the table but not the columns, and naming them would
  --    stop the whole file (ON_ERROR_STOP). So the grant waits for the columns; migration
  --    150 grants them as it adds them, and the second pass repeats it.
  IF EXISTS (SELECT 1 FROM pg_attribute
              WHERE attrelid = to_regclass('public.attachment')
                AND attname = 'unreserved_at' AND NOT attisdropped) THEN
    GRANT SELECT (workspace_id, status, message_id, reserved, unreserved_at, created_at)
      ON attachment TO momo_notifier;
  END IF;
  --  * woken-not-collected verdict (ADR-0200 증보 3 E7, #4284): the run stall sweep reads,
  --    per candidate run and ONLY as column grants, what `woken_uncollected_verdict`
  --    needs. No write, no DELETE.
  --      hosted_agent_connection: `id`, `status` (active connection), `approved_scopes`
  --        (the job's `agent:jobs:read`), and `approved_channel_ids`,
  --        `approved_dm_channel_ids`, `confirmed_by`, which the INVOKER function
  --        `hosted_connection_channel_ids()` reads for the run's channel.
  --      hosted_agent_liveness: the work signals and the last refusal. Not
  --        `agent_member_id`, `last_tool_call_at`, `last_tool_error_code`.
  --      hosted_agent_doorbell_ring: when a person last asked to wake the agent again.
  --      agent_provider_pin: `kind` (the trial stop clause, `trial_members_stop_sql!`).
  --    NOT granted, on purpose: `token` (a BYPASSRLS role never reads a credential — the
  --    verdict drops the token conditions of the claim predicate for this reason) and
  --    `hosted_agent_doorbell` (`url`, `secret_sealed`; the verdict needs no fire time).
  IF to_regclass('public.hosted_agent_connection') IS NOT NULL THEN
    GRANT SELECT (workspace_id, agent_member_id, id, status, approved_scopes,
                  approved_channel_ids, approved_dm_channel_ids, confirmed_by)
      ON hosted_agent_connection TO momo_notifier;
  END IF;
  IF to_regclass('public.hosted_agent_liveness') IS NOT NULL THEN
    GRANT SELECT (workspace_id, connection_id, last_inbox_read_at, last_claim_at,
                  last_run_event_at, last_ping_at, last_ping_state, last_tool_error_at)
      ON hosted_agent_liveness TO momo_notifier;
  END IF;
  IF to_regclass('public.hosted_agent_doorbell_ring') IS NOT NULL THEN
    GRANT SELECT (workspace_id, connection_id, requested_at)
      ON hosted_agent_doorbell_ring TO momo_notifier;
  END IF;
  IF to_regclass('public.agent_provider_pin') IS NOT NULL THEN
    GRANT SELECT (workspace_id, agent_member_id, kind)
      ON agent_provider_pin TO momo_notifier;
  END IF;
  -- ADR-0204 D7 / #3928: an approval's push goes to the people who MAY approve it,
  -- and "may" starts with the workspace role. `momo_messaging::active_workspace_role`
  -- — the very read the decision route's `require_admin` makes — selects `role`
  -- where `workspace_id` and `member_id` match (and joins `member`, already
  -- granted). Exactly those three columns; `joined_at` / `updated_at` are not read.
  IF to_regclass('public.workspace_membership') IS NOT NULL THEN
    GRANT SELECT (workspace_id, member_id, role) ON workspace_membership TO momo_notifier;
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

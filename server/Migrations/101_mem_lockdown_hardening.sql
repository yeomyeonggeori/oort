-- =============================================================================
-- 101_mem_lockdown_hardening.sql — #3186 (#3185 3차 검수 Medium/Low 후속)
--
-- 100_mem_digest.sql 은 머지됐으므로 고치지 않는다. 잠금 블록을 강화해 다시 돌린다.
--   M-1  momo_app 의 mem_settings 에서도 TRUNCATE · REFERENCES · TRIGGER 를 회수한다.
--   M-3  mem_definer 멤버 회수 + PUBLIC 테이블 ACL 회수(권한 매트릭스는 시험이 본다).
--   L-1  mem_definer 소유 SECURITY DEFINER 함수 허용 목록 자기검사(아래).
--   L-4  momo_memory · mem_definer 멤버십 자기검사(블록 안; 부트스트랩에도 같다).
--   L-5  mem_* 이름의 뷰·물화 뷰(relkind v, m)도 순회한다.
-- 아래 BEGIN/END 사이는 bootstrap_roles.sql · bootstrap_runtime_roles.sql 과 글자 그대로
-- 같다(시험이 글자 단위로 대조한다). 스키마 객체는 만들지 않는다. 재실행해도 같다.
-- =============================================================================

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
    'mem_apply_digest(uuid, uuid, text, bigint, bigint, text, uuid[], text, text, text, uuid[], timestamptz[], timestamptz)',
    'mem_advance_cursor(uuid, bigint, uuid, timestamptz)',
    'mem_record_serving(uuid, uuid, uuid[], uuid[], integer, integer, integer)',
    'mem_digest_rollup_inputs(uuid, uuid, text, bigint, bigint)',
    'mem_channel_switch(uuid)',
    'mem_digest_live(uuid)',
    'mem_digest_audience_ok(uuid, uuid, uuid)'
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
      ELSIF r = 'momo_app' THEN
        EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.%I FROM %I', t, r);
      ELSE
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', t, r);
      END IF;
    END LOOP;
  END LOOP;
  FOREACH f IN ARRAY worker_only LOOP
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

-- ── L-1: mem_definer 소유 SECURITY DEFINER 함수 허용 목록 ───────────────────────
-- 새 정의자 함수를 만들면 이 목록과 시험(mem_schema_conformance_pg.rs 의 DEFINER_ALLOW_LIST)에
-- 이름을 올려야 한다. 목록 밖 함수는 RLS 를 우회하는 새 통로이므로 여기서 멈춘다.
-- 부트스트랩 블록에는 넣지 않는다(이후 마이그레이션이 함수를 추가해도 부트스트랩이 깨지지 않게).
DO $$
DECLARE
  f text;
  allow text[] := ARRAY[
    'mem_digest_evidence_ok', 'mem_digest_live', 'mem_digest_audience_ok',
    'mem_digest_rollup_inputs', 'mem_channel_switch',
    'mem_apply_digest', 'mem_advance_cursor', 'mem_record_serving'
  ];
BEGIN
  FOR f IN SELECT p.oid::regprocedure::text FROM pg_proc p
            WHERE p.prosecdef AND pg_get_userbyid(p.proowner) = 'mem_definer'
              AND p.proname <> ALL (allow) LOOP
    RAISE EXCEPTION 'SECURITY DEFINER function % owned by mem_definer is not in the allow-list', f;
  END LOOP;
END $$;

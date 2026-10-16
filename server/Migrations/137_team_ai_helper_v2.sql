-- =============================================================================
-- 137_team_ai_helper_v2.sql — #3894 (ADR-0201 증보 2026-10-16 v2, H12-S1·S3·S4)
--
-- 성재 요청(2026-10-16): 「@claude나 @oort @오르트 같은걸로 해당 팀 api key로 호출 및 전역 설정,
-- 검색 및 도구 호출 …」. 결정 기록은 ADR-0201 끝의 「증보 2026-10-16 (#3888) v2」(PR #3892).
-- 이 파일 하나가 그 증보의 DB 계약 세 가지를 담는다(번호가 부딪히면 한 번만 다시 매기도록 한 파일).
--
-- 1. member_handle_alias (H2) — 도우미를 부르는 별칭. v2는 `oort`·`오르트`·`claude` 셋으로 고정
--    (CHECK). 핸들 칸은 그대로 ASCII(`[a-z0-9_-]`)라 한글 별칭은 핸들이 될 수 없어 표를 따로 둔다.
--      * UNIQUE (workspace_id, alias_norm) — 별칭 하나는 한 멤버의 것.
--      * 실제 멤버가 이긴다(H2-4): 누군가 그 이름의 「핸들」로 가입·생성·변경하면 아래 트리거가
--        같은 tx 에서 별칭을 지우고 `team_ai_alias_status` 와 audit(`team_ai.alias.released`)을
--        남긴다. 핸들을 쓰는 모든 경로(가입·에이전트 생성·이름 변경·웹훅 설치·시드)가 이 한 곳을 지난다.
--        가입·이름 변경은 별칭 때문에 거절되지 않는다. 표시 이름 변경은 별칭을 건드리지 않는다.
--      * RLS ENABLE + FORCE + ws_isolation(app.workspace_id).
--
-- 2. momo_helper_read (H4-2, H9-I3) — 도우미 읽기 도구가 tx 마다 `SET LOCAL ROLE` 하는 역할.
--    NOLOGIN NOBYPASSRLS, 읽기 도구가 닿는 테이블에만 SELECT(쓰기 없음). momo_worker(BYPASSRLS)가
--    SET 만 할 수 있게 INHERIT FALSE 로 준다(momo_memory 와 같은 모양). 테넌트 표의 ws_isolation
--    정책은 TO 절이 없어(PUBLIC) 이 역할에도 걸린다 — 그래서 워크스페이스 경계를 RLS FORCE 가 막는다.
--    채널 시야는 각 도메인 함수의 요청자 술어가 막는다.
--
-- 3. usage_ledger.web_search_requests (H5) — 공급자 내장 웹 검색 횟수. 일일 검색 상한
--    (TEAM_AI_DAILY_SEARCH_CAP)이 이 합을 읽는다.
--
-- schema_v0.sql 은 건드리지 않는다. 모든 문장이 가드되어 다시 적용해도 무해하다.
-- =============================================================================

-- ── 1. member_handle_alias ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS member_handle_alias (
  workspace_id  uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  member_id     uuid NOT NULL,
  alias         text NOT NULL,
  alias_norm    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT member_handle_alias_pk PRIMARY KEY (workspace_id, alias_norm),
  CONSTRAINT member_handle_alias_member_fk FOREIGN KEY (workspace_id, member_id)
    REFERENCES member (workspace_id, id) ON DELETE CASCADE,
  -- 핸들 문자 또는 한글 음절, 2~16자, 소문자.
  CONSTRAINT member_handle_alias_shape_ck
    CHECK (alias_norm = lower(alias_norm) AND alias_norm ~ '^[a-z0-9_가-힣-]{2,16}$'),
  -- v2 는 셋으로 고정(H2-2). 늘리는 것은 증보 + 새 migration.
  CONSTRAINT member_handle_alias_v2_set_ck CHECK (alias_norm IN ('oort', '오르트', 'claude'))
);

CREATE INDEX IF NOT EXISTS member_handle_alias_member_idx
  ON member_handle_alias (workspace_id, member_id);

COMMENT ON TABLE member_handle_alias IS
  '#3894 ADR-0201 증보 v2 H2: 도우미(oort 도우미)를 부르는 별칭(oort·오르트·claude). 실제 멤버의 핸들이 언제나 이긴다(트리거 member_handle_alias_release). 서버만 쓴다.';

ALTER TABLE member_handle_alias ENABLE ROW LEVEL SECURITY;
ALTER TABLE member_handle_alias FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                  WHERE schemaname = 'public' AND tablename = 'member_handle_alias'
                    AND policyname = 'ws_isolation') THEN
    CREATE POLICY ws_isolation ON member_handle_alias
      USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
      WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_app') THEN
    GRANT SELECT, INSERT, DELETE ON TABLE member_handle_alias TO momo_app;
  END IF;
  -- The worker resolves mentions in an agent's reply (A2A) against the same table.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_worker') THEN
    GRANT SELECT ON TABLE member_handle_alias TO momo_worker;
  END IF;
END $$;

-- 실제 멤버가 이긴다(H2-4). 핸들을 쓰는 모든 쓰기 경로의 한 곳.
CREATE OR REPLACE FUNCTION member_handle_alias_release()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  released text;
BEGIN
  IF NEW.deleted_at IS NOT NULL OR NEW.handle IS NULL THEN
    RETURN NEW;
  END IF;
  FOR released IN
    DELETE FROM public.member_handle_alias a
     WHERE a.workspace_id = NEW.workspace_id
       AND a.alias_norm = lower(NEW.handle)
       AND a.member_id <> NEW.id
    RETURNING a.alias_norm
  LOOP
    UPDATE public.workspace
       SET settings = jsonb_set(
             COALESCE(settings, '{}'::jsonb),
             '{team_ai_alias_status}',
             COALESCE(settings -> 'team_ai_alias_status', '{}'::jsonb)
               || jsonb_build_object(released, 'taken'),
             true),
           updated_at = now()
     WHERE id = NEW.workspace_id;
    -- 별칭 이름만. 누가 가져갔는지는 subject 로 충분하다.
    INSERT INTO public.audit_log
      (workspace_id, subject_member_id, action, target_type, target_id, detail)
    VALUES
      (NEW.workspace_id, NEW.id, 'team_ai.alias.released', 'member', NEW.id,
       jsonb_build_object('schema', 'momo.team_ai_alias.v1', 'alias', released,
                          'reason', 'handle_taken'));
  END LOOP;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS member_handle_alias_release_trg ON member;
CREATE TRIGGER member_handle_alias_release_trg
  AFTER INSERT OR UPDATE OF handle, deleted_at ON member
  FOR EACH ROW EXECUTE FUNCTION member_handle_alias_release();

-- ── 2. momo_helper_read ────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_helper_read') THEN
    CREATE ROLE momo_helper_read NOLOGIN;
  END IF;
  ALTER ROLE momo_helper_read NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
END $$;

GRANT USAGE ON SCHEMA public TO momo_helper_read;

-- SELECT only, and only what the eight read tools' domain functions touch
-- (search, channel/thread pages with their thread/quote/attachment joins, roster,
-- run lists/details/ledger, plugin catalogue, settings). Nothing here is a
-- credential table: no token, provider_link, human (e-mail/password), invite.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'workspace', 'workspace_membership', 'member', 'channel', 'membership', 'message',
    'thread', 'attachment', 'agent', 'agent_profile', 'agent_run', 'agent_run_event',
    'hosted_agent_connection', 'plugin_registry', 'workspace_plugin_install', 'plugin_grant',
    'plugin_capability_projection'
  ] LOOP
    CONTINUE WHEN to_regclass('public.' || t) IS NULL;
    EXECUTE format('GRANT SELECT ON TABLE public.%I TO momo_helper_read', t);
  END LOOP;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_worker') THEN
    GRANT momo_helper_read TO momo_worker WITH INHERIT FALSE, SET TRUE;
  END IF;
END $$;

-- ── 3. usage_ledger.web_search_requests ────────────────────────────────────────
ALTER TABLE usage_ledger
  ADD COLUMN IF NOT EXISTS web_search_requests integer NOT NULL DEFAULT 0;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'usage_ledger_web_search_requests_ck') THEN
    ALTER TABLE usage_ledger
      ADD CONSTRAINT usage_ledger_web_search_requests_ck CHECK (web_search_requests >= 0);
  END IF;
END $$;

COMMENT ON COLUMN usage_ledger.web_search_requests IS
  '#3894 ADR-0201 증보 v2 H5: 이 run 이 공급자 내장 웹 검색을 부른 횟수(공급자가 보고한 값). 일일 검색 상한이 합을 읽는다.';

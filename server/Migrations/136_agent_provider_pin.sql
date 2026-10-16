-- =============================================================================
-- 136_agent_provider_pin.sql — #3873 (ADR-0147 증보 2026-10-16 「에이전트별 키 고정」)
--
-- 성재 결재 2026-10-16: 「Max (크레딧 쓰기)」·「키+팀 AI 먼저 (추천)」·「같은 프로젝트·도구 끔
-- (추천)」. 팀 AI는 팀 Anthropic 키(provider_link)를 쓰고, 같은 서버의 Hermes 에이전트는
-- 운영자 env 링크(HERMES_BASE_URL)를 쓴다. 지금은 DB 링크가 env를 이기는 「머리 자리」가 하나라
-- 둘이 함께 살 수 없다. 이 표는 에이전트 한 명이 어느 링크를 쓰는지를 팀 기본과 무관하게 고정한다.
--
--   agent_provider_pin   에이전트당 최대 한 줄. 행이 없으면 「팀 기본을 따른다」(지금과 같다).
--     kind = 'operator_env'  운영자 env 링크(HERMES_BASE_URL·HERMES_API_KEY). 라벨 없음 —
--                            「운영자가 정한 그 링크」가 뜻이다.
--     kind = 'team_link'     캐스케이드 위치(0 = provider_link 싱글턴 「자체」, env 폴백 아님;
--                            1+ = provider_link_chain hop) + 고를 때의 가린 endpoint label.
--                            042 의 PUT …/chain 은 hop 을 지우고 다시 넣으므로 위치는 안정된
--                            id 가 아니다. 라벨 스냅샷이 「그 위치가 다른 provider 를 가리킨다」를
--                            읽는 쪽이 알아채게 한다(093 과 같은 이유).
--
-- 이 표는 자격 물질이 없다: 키·봉투·URL·경로·토큰 칸이 없다. 관리자는 URL 을 쓰지 않는다 —
-- 이미 검증된 hop 또는 운영자 env 호스트를 「이름」할 뿐이라 egress 규칙은 그대로다.
--
-- RLS (ENABLE + FORCE)
--   * 읽기: 같은 워크스페이스(ws_read). 프로필 화면이 「이 에이전트는 어느 연결로 고정」을 보인다.
--   * 쓰기(INSERT·UPDATE·DELETE): 워크스페이스 일치 AND app.provider_link_admin = 'on'.
--     그 GUC 는 라우트가 인스턴스 운영자 게이트(MOMO-583)를 통과한 뒤에만
--     with_provider_link_admin_tx 로 켠다(110_mem_reset.sql 의 경고: 일반 멤버 tx 에 켜지 않는다).
--     그래서 워크스페이스 관리자의 일반 tx 는 이 표에 쓰지 못한다 — 라우트 게이트가 빠져도 DB 가 막는다.
--   * 전 테넌트 워커(momo_worker, BYPASSRLS)는 설계상 읽는다 — provider_link·personal_provider_link 와
--     같은 기존 예외다. 새 BYPASSRLS 경로는 없다.
--
-- 소유자 전용(owner_only) 에이전트는 두뇌가 정해져 있다(구독 또는 소유자의 개인 키; 089·117).
-- 팀 링크를 고정할 수 없다: 트리거가 거부하고, 워커도 그런 턴에는 이 표를 읽지 않는다.
--
-- schema_v0.sql 은 건드리지 않는다. 모든 문장이 가드되어 다시 적용해도 무해하다.
-- =============================================================================

CREATE TABLE IF NOT EXISTS agent_provider_pin (
  agent_member_id      uuid PRIMARY KEY REFERENCES agent(member_id) ON DELETE CASCADE,
  workspace_id         uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  kind                 text NOT NULL,
  link_position        integer NULL,
  link_endpoint_label  text NULL,
  pinned_by            uuid REFERENCES member(id) ON DELETE SET NULL,
  pinned_at            timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_provider_pin_kind_ck
    CHECK (kind IN ('operator_env', 'team_link')),
  -- team_link ⇔ position + label; operator_env carries neither.
  CONSTRAINT agent_provider_pin_shape_ck CHECK (
    (kind = 'team_link' AND link_position IS NOT NULL AND link_endpoint_label IS NOT NULL)
    OR (kind = 'operator_env' AND link_position IS NULL AND link_endpoint_label IS NULL)
  ),
  CONSTRAINT agent_provider_pin_position_ck
    CHECK (link_position IS NULL OR link_position >= 0),
  CONSTRAINT agent_provider_pin_label_ck
    CHECK (link_endpoint_label IS NULL
           OR (length(btrim(link_endpoint_label)) > 0 AND length(link_endpoint_label) <= 512))
);

COMMENT ON TABLE agent_provider_pin IS
  '#3873 ADR-0147 증보 2026-10-16: 에이전트별 AI 연결 고정. 행 없음 = 팀 기본을 따른다. operator_env = 운영자 env 링크(HERMES_BASE_URL), team_link = 캐스케이드 위치 + 고를 때의 가린 endpoint label. 자격 물질 없음. 쓰기는 app.provider_link_admin 정책(인스턴스 운영자 라우트)만.';

-- Same workspace as the agent (the FK alone would let a row name another tenant's workspace_id),
-- and a team link can never be pinned on an owner_only agent.
CREATE OR REPLACE FUNCTION agent_provider_pin_guard()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  a_workspace uuid;
  a_scope     text;
BEGIN
  SELECT a.workspace_id, a.invocation_scope INTO a_workspace, a_scope
    FROM public.agent a
   WHERE a.member_id = NEW.agent_member_id;
  IF a_workspace IS NULL OR a_workspace IS DISTINCT FROM NEW.workspace_id THEN
    RAISE EXCEPTION 'agent_provider_pin must name an agent of its own workspace (ADR-0147 증보 2026-10-16)'
      USING ERRCODE = 'check_violation';
  END IF;
  IF a_scope = 'owner_only' THEN
    RAISE EXCEPTION 'an owner_only agent runs on its owner''s own brain and cannot be pinned to a team link (ADR-0147 증보 2026-10-16)'
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.agent_member_id IS DISTINCT FROM OLD.agent_member_id
                           OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id) THEN
    RAISE EXCEPTION 'agent_provider_pin agent and workspace cannot change (ADR-0147 증보 2026-10-16)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

-- UPDATE OF the identifying and meaning columns only: the FK's `ON DELETE SET NULL` on
-- `pinned_by` (the pinning operator left) is also an UPDATE, and it must never be blocked
-- by an agent that became owner_only after the pin was made (independent security review).
DROP TRIGGER IF EXISTS agent_provider_pin_guard ON agent_provider_pin;
CREATE TRIGGER agent_provider_pin_guard
  BEFORE INSERT OR UPDATE OF agent_member_id, workspace_id, kind, link_position, link_endpoint_label
  ON agent_provider_pin
  FOR EACH ROW EXECUTE FUNCTION agent_provider_pin_guard();

ALTER TABLE agent_provider_pin ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_provider_pin FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_provider_pin_read ON agent_provider_pin;
CREATE POLICY agent_provider_pin_read ON agent_provider_pin
  FOR SELECT
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid);

DROP POLICY IF EXISTS agent_provider_pin_insert ON agent_provider_pin;
CREATE POLICY agent_provider_pin_insert ON agent_provider_pin
  FOR INSERT
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid
              AND current_setting('app.provider_link_admin', true) = 'on');

DROP POLICY IF EXISTS agent_provider_pin_update ON agent_provider_pin;
CREATE POLICY agent_provider_pin_update ON agent_provider_pin
  FOR UPDATE
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid
         AND current_setting('app.provider_link_admin', true) = 'on')
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid
              AND current_setting('app.provider_link_admin', true) = 'on');

DROP POLICY IF EXISTS agent_provider_pin_delete ON agent_provider_pin;
CREATE POLICY agent_provider_pin_delete ON agent_provider_pin
  FOR DELETE
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid
         AND current_setting('app.provider_link_admin', true) = 'on');

-- Granted here so an install that does not re-run bootstrap_roles.sql after this migration
-- keeps working: the worker reads this table on EVERY non-owner-key agent turn, and a
-- missing privilege would stall all of them (the same reason 128/131/133 grant).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE agent_provider_pin TO momo_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_worker') THEN
    GRANT SELECT ON TABLE agent_provider_pin TO momo_worker;
  END IF;
END $$;

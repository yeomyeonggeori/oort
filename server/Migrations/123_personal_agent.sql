-- =============================================================================
-- 123_personal_agent.sql — #3591 P2 (ADR-0198 증보 1 D7, 결재 2026-10-07 1~3)
--
-- 개인 에이전트: 소유자가 연동한 하네스(Claude Code·Codex)를 별칭으로 켠 `member.kind='agent'`
-- 멤버. 두뇌는 소유자의 member host에서 도는 하네스이고 서버는 토큰을 갖지 않는다.
--
-- 새 테이블은 없다. 089가 만든 owner_only 모양(`invocation_scope='owner_only'`,
-- `subscription_harness`, `owner_human_id`)을 그대로 재사용한다. T5(`work_spawns.rs`)가
-- 에이전트를 이름으로 받을 때 요구하는 조건(요청자 소유의 살아 있는 owner_only, 하네스 일치)을
-- 개인 에이전트가 그대로 만족하고, #3567이 kwak-claude를 같은 멤버 id로 전환할 때도
-- `UPDATE agent SET personal_agent = true` 한 줄이면 된다(과거 메시지·작성자 표기 보존).
--
--   agent.personal_agent        D7 개인 에이전트 표지. 기존 호스티드 구독 에이전트(Agent Port
--                               레인)와 읽기 경로가 구분해야 한다: 개인 에이전트는 호스티드 연결이
--                               없고, `MOMO_CLAUDE_SUBSCRIPTION_AGENTS_ENABLED`가 켜고 끄는 값이
--                               아니다(ADR-0198 증보 1 「D18 갈래 표」 마지막 행). 판정에 쓰는 SQL이
--                               걸러 내는 값이라 JSONB(`agent.config`)가 아니라 타입·CHECK가 있는
--                               컬럼이다(089와 같은 이유).
--   agent.personal_disabled_at  소유자가 「끄기」를 누른 시각. NULL이면 소유자가 끈 적 없다.
--                               끄기는 `member.status = 'suspended'`로 표현하고(과거 메시지는 그대로
--                               author로 남는다), 이 열은 「소유자가 끈 것」과 「관리자가 정지한
--                               것」을 구분한다: 소유자는 자기가 끈 것만 다시 켠다.
--
-- 별칭 = `member.handle`이다. 유일성은 001의 `member_handle_uniq (workspace_id, handle)`이
-- 이미 지킨다(사람·에이전트·비활성 멤버의 핸들과 겹치지 않는다). 별칭 열·테이블을 따로 두지 않는다.
--
-- (workspace, owner, harness)당 개인 에이전트는 하나다. 끄고 켜도 같은 멤버 id를 쓰므로
-- 과거 메시지·작성자 표기를 잃지 않는다.
--
-- RLS: `agent`는 001_init.sql의 테넌트 테이블이고 FORCE RLS + ws_isolation 대상이다. 컬럼·부분
-- 유니크 인덱스 추가는 그 정책을 그대로 물려받는다. 새 테이블·새 권한 없음. schema_v0.sql 무접촉.
-- 089의 owner_only 불변 트리거는 이 열들을 건드리지 않는다.
-- =============================================================================

ALTER TABLE agent
  ADD COLUMN personal_agent boolean NOT NULL DEFAULT false,
  ADD COLUMN personal_disabled_at timestamptz;

-- 개인 에이전트는 소유자의 구독 하네스이지 개인 API 키(117)가 아니다.
ALTER TABLE agent
  ADD CONSTRAINT agent_personal_shape CHECK (
    (NOT personal_agent OR (invocation_scope = 'owner_only' AND NOT uses_owner_key))
    AND (personal_disabled_at IS NULL OR personal_agent)
  );

CREATE UNIQUE INDEX agent_personal_owner_harness_uidx
  ON agent (workspace_id, owner_human_id, subscription_harness)
  WHERE personal_agent;

COMMENT ON COLUMN agent.personal_agent IS
  '#3591 ADR-0198 증보 1 D7: owner_only 구독 하네스를 소유자가 별칭으로 켠 개인 에이전트. 호스티드 연결 없음, 실행은 소유자 member host(서명 spawn). (workspace, owner, harness)당 하나.';
COMMENT ON COLUMN agent.personal_disabled_at IS
  '#3591: 소유자가 끈 시각. member.status = suspended와 함께 쓴다. 관리자 정지(이 열 NULL)는 소유자가 다시 켤 수 없다.';

-- 삭제·정지와의 상호작용 (독립 보안 검수 M2·M3)
--
-- M2: 부분 유니크 인덱스는 `member.deleted_at`을 모른다. 멤버가 삭제되면(deleted_at 또는
--     status 'deleted') 같은 (소유자, 하네스)로 새로 켜려는 호출이 유니크 위반(500)이 되지 않도록
--     삭제 시점에 이 행의 개인 에이전트 표지를 해제한다. 행과 핸들은 남는다(과거 메시지 author).
-- M3: `personal_disabled_at`은 「소유자가 껐다」의 증거다. 소유자 경로(세션 로컬 GUC
--     `momo.personal_owner_toggle = on`을 켠 문장)가 아닌 곳에서 member.status가 쓰이면(관리자
--     정지·복구 등) 그 증거를 지운다. 그러면 소유자 `enable`이 관리자 정지를 풀 수 없고, 소유자가
--     먼저 끈 뒤 관리자가 정지해도 마찬가지다.
CREATE FUNCTION personal_agent_member_guard()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.kind = 'agent' THEN
    IF NEW.deleted_at IS NOT NULL OR NEW.status = 'deleted' THEN
      UPDATE public.agent
         SET personal_agent = false, personal_disabled_at = NULL
       WHERE workspace_id = NEW.workspace_id AND member_id = NEW.id AND personal_agent;
    ELSIF COALESCE(current_setting('momo.personal_owner_toggle', true), '') <> 'on' THEN
      UPDATE public.agent
         SET personal_disabled_at = NULL
       WHERE workspace_id = NEW.workspace_id AND member_id = NEW.id
         AND personal_disabled_at IS NOT NULL;
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER personal_agent_member_guard
AFTER UPDATE OF status, deleted_at ON member
FOR EACH ROW EXECUTE FUNCTION personal_agent_member_guard();

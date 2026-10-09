-- =============================================================================
-- 125_subscription_retire.sql — #3567 T2 (ADR-0198 증보 1 D2 변경·D7)
--
-- 구독 에이전트 이행의 서버 쪽 두 사실을 DB가 지키게 한다.
--
--   agent.subscription_retired_at  「이전 구독 에이전트」 표식. 은퇴 도구(`momo-subscription-migrate
--                                  retire`)만 쓴다. 은퇴한 멤버는 삭제하지 않고
--                                  `member.status = 'suspended'`로 두므로(과거 메시지의 작성자
--                                  표기 보존) 「정지」와 「은퇴」를 구분하는 값이 따로 필요하다.
--                                  읽기 경로(`subscriptionRetired`)와 아래 트리거가 거르는 값이라
--                                  JSONB(`agent.config`)가 아니라 컬럼이다(089·123과 같은 이유).
--
-- 호스티드 연결을 다시 세울 수 없게 한다.
--   전환(kwak-claude → 개인 에이전트)과 은퇴는 연결을 `expired`로 닫는다. 그런데
--   `regenerate_pairing_in_tx`는 `expired`를 `pairing_pending`으로 되살릴 수 있고(관리자
--   「다시 연결」), 그러면 전환했거나 은퇴한 행에 Agent Port 레인이 다시 열린다. 069의
--   sentinel 트리거는 `agent_member_id` 컬럼 변경에만 걸려 status 변경은 막지 않는다.
--   그래서 개인 에이전트이거나 은퇴한 에이전트의 연결이 살아 있는 상태
--   (`pairing_pending`·`detected`·`active`)로 INSERT되거나 그 상태로 바뀌는 것을 거절한다.
--   `cleanup_pending`·`disconnected`·`expired`는 닫는 방향이라 막지 않는다.
--
-- RLS: `agent`·`hosted_agent_connection`은 FORCE RLS + ws_isolation 대상이고 컬럼·트리거 추가는
-- 그 정책을 그대로 물려받는다. 새 테이블·새 권한 없음. schema_v0.sql 무접촉. 트리거는 SECURITY
-- INVOKER라 호출 역할이 `agent`를 읽을 수 있어야 하는데, 세 런타임 역할 모두 `agent` SELECT가 있다
-- (bootstrap_runtime_roles.sql의 ALL TABLES 부여).
-- =============================================================================

ALTER TABLE agent
  ADD COLUMN subscription_retired_at timestamptz;

-- 개인 에이전트로 전환한 행은 은퇴한 행이 아니다. 둘은 서로 다른 끝이다.
ALTER TABLE agent
  ADD CONSTRAINT agent_retired_not_personal CHECK (
    subscription_retired_at IS NULL OR NOT personal_agent
  );

COMMENT ON COLUMN agent.subscription_retired_at IS
  '#3567 ADR-0198 증보 1 D2: 「이전 구독 에이전트」 은퇴 표식. member.status = suspended와 함께 쓴다(삭제 없음, 과거 메시지 author 보존). 은퇴한 행의 호스티드 연결은 다시 살릴 수 없다(hosted_agent_connection_closed_guard).';

CREATE FUNCTION hosted_agent_connection_closed_guard()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.status IN ('pairing_pending', 'detected', 'active') AND EXISTS (
    SELECT 1 FROM public.agent a
     WHERE a.workspace_id = NEW.workspace_id AND a.member_id = NEW.agent_member_id
       AND (a.personal_agent OR a.subscription_retired_at IS NOT NULL)
  ) THEN
    RAISE EXCEPTION
      'a personal or retired subscription agent cannot hold a live hosted connection (ADR-0198 D2)';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER hosted_agent_connection_closed_guard
BEFORE INSERT OR UPDATE OF status ON hosted_agent_connection
FOR EACH ROW EXECUTE FUNCTION hosted_agent_connection_closed_guard();

COMMENT ON FUNCTION hosted_agent_connection_closed_guard() IS
  '#3567: 개인 에이전트로 전환했거나 은퇴한 구독 에이전트에는 살아 있는 호스티드 연결(pairing_pending·detected·active)을 만들거나 되살릴 수 없다.';

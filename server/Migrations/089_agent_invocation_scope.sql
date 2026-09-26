-- =============================================================================
-- 089_agent_invocation_scope.sql — #2815 OB2-9 (ADR-0193 D4·D5·D6)
--
-- 구독으로 도는 에이전트는 소유자만 부른다.
--
-- ADR-0193 D2는 구독 경로를 「이 맥의 공식 CLI」 하나로 좁혔고, D4는 그 경로로
-- 합류한 에이전트를 소유자(`agent.owner_human_id`, schema_v0) 한 사람만 부를 수
-- 있게 했다. 이 파일은 그 사실을 기록할 자리를 만든다.
--
--   agent.invocation_scope      'workspace'(기존 모든 에이전트) | 'owner_only'
--   agent.subscription_harness  owner_only일 때만: 'claude_code' | 'codex'.
--                               오프라인 문구(D5)가 「Claude Code」/「Codex」를
--                               고르는 근거다.
--
-- 왜 JSONB(`agent.config`)가 아니라 컬럼인가
--   * 전달 경로의 SQL(인박스 fan-out, 웰컴 대상)이 이 값으로 행을 거른다. 타입과
--     CHECK가 있는 컬럼이면 오타가 「workspace로 열림」으로 새지 않는다.
--   * 「소유자는 바꿀 수 없다」(D4)를 API가 없다는 사실이 아니라 DB가 지킨다.
--     아래 트리거가 owner_only를 다시 여는 UPDATE, owner_only 행의 소유자·하네스
--     변경을 거절한다. `agent.config`는 여러 경로가 통째로 쓰는 가방이라 그런
--     보장을 걸 자리가 아니다.
--
-- RLS: `agent`는 001_init.sql의 테넌트 테이블 목록에 있고 FORCE RLS +
-- ws_isolation 정책 대상이다. 컬럼 추가는 그 정책을 그대로 물려받는다. 새
-- 테이블·새 정책·새 권한 없음. schema_v0.sql 무접촉.
-- =============================================================================

ALTER TABLE agent
  ADD COLUMN invocation_scope text NOT NULL DEFAULT 'workspace'
    CHECK (invocation_scope IN ('workspace', 'owner_only')),
  ADD COLUMN subscription_harness text
    CHECK (subscription_harness IS NULL OR subscription_harness IN ('claude_code', 'codex'));

-- 모양: owner_only ⇔ 하네스가 있다, 그리고 owner_only면 소유자가 있다.
ALTER TABLE agent
  ADD CONSTRAINT agent_owner_only_shape CHECK (
    (invocation_scope = 'owner_only') = (subscription_harness IS NOT NULL)
    AND (invocation_scope <> 'owner_only' OR owner_human_id IS NOT NULL)
  );

COMMENT ON COLUMN agent.invocation_scope IS
  '#2815 ADR-0193 D4: owner_only = only owner_human_id may invoke (mention, DM, thread reply, work request). One-way: an owner_only row can never be reopened (agent_owner_only_is_final trigger).';
COMMENT ON COLUMN agent.subscription_harness IS
  '#2815 ADR-0193 D5: which official CLI the owner runs (claude_code | codex). Present exactly when invocation_scope = owner_only.';

CREATE FUNCTION agent_owner_only_is_final()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.invocation_scope = 'owner_only' THEN
    IF NEW.invocation_scope IS DISTINCT FROM OLD.invocation_scope THEN
      RAISE EXCEPTION 'owner_only agent cannot be reopened to the workspace (ADR-0193 D4)';
    END IF;
    IF NEW.owner_human_id IS DISTINCT FROM OLD.owner_human_id THEN
      RAISE EXCEPTION 'owner_only agent owner cannot change (ADR-0193 D4)';
    END IF;
    IF NEW.subscription_harness IS DISTINCT FROM OLD.subscription_harness THEN
      RAISE EXCEPTION 'owner_only agent harness cannot change (ADR-0193 D4)';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER agent_owner_only_final_guard
BEFORE UPDATE OF invocation_scope, owner_human_id, subscription_harness ON agent
FOR EACH ROW EXECUTE FUNCTION agent_owner_only_is_final();

-- =============================================================================
-- 139_agent_connector_owner.sql — #3938 C-S2 (ADR-0113 증보 2 E3)
--
-- 앱(커넥터)을 붙인 에이전트는 소유자 본인만 부른다.
--
-- 앱을 붙인 에이전트가 남의 요청에 쓰이면 소유자의 Gmail·Drive 권한이 남의 요청에
-- 쓰인다. oort가 벤더 쪽 도구를 막을 수는 없으니, 막을 수 있는 유일한 자리인
-- **배달**에서 막는다. 이 컬럼이 그 표시다.
--
--   agent.connector_owner_human_id  NULL = 평소 에이전트.
--                                   값 = 「앱 실행 장소」. 서버는 트리거 작성자가
--                                   이 사람일 때만 작업을 배달한다(멘션·DM·작업
--                                   요청·수신함 fan-out).
--
-- 왜 `invocation_scope = 'owner_only'`를 쓰지 않는가
--   089의 `agent_owner_only_shape` CHECK가 owner_only를 `subscription_harness`에
--   묶고, `agent_owner_only_is_final` 트리거가 되돌리기를 막는다. 구독 하네스가 아닌
--   에이전트(Hermes·그록봇 연결)에는 붙일 수 없고, 끄기는 언제나 즉시여야 한다.
--   그래서 같은 술어(「작성자 = 소유자」)를 새 표시로 둔다.
--
-- 소유자 고정
--   CHECK는 표시 값이 그 에이전트의 소유자(`owner_human_id`) 본인일 때만 허용한다.
--   「켜고 끄는 사람은 소유자 본인」(E3)을 API뿐 아니라 DB도 지킨다. 소유자가 없는
--   에이전트에는 켤 수 없다. FK에 ON DELETE 동작을 두지 않는다: 사라진 소유자가
--   표시를 NULL로 되돌려 에이전트를 모두에게 여는 일이 없어야 한다.
--
-- RLS: `agent`는 001_init.sql의 테넌트 테이블 목록에 있고 FORCE RLS + ws_isolation
-- 정책 대상이다. 컬럼 추가는 그 정책을 그대로 물려받는다. 새 테이블·정책·권한 없음.
-- schema_v0.sql 무접촉.
-- =============================================================================

ALTER TABLE agent
  ADD COLUMN connector_owner_human_id uuid REFERENCES member(id);

ALTER TABLE agent
  ADD CONSTRAINT agent_connector_owner_is_owner CHECK (
    connector_owner_human_id IS NULL
    OR (owner_human_id IS NOT NULL AND connector_owner_human_id = owner_human_id)
  );

COMMENT ON COLUMN agent.connector_owner_human_id IS
  '#3938 ADR-0113 aug.2 E3: non-NULL = this agent runs the owner''s connected apps; the server delivers a trigger only when its author is this human. Must equal owner_human_id (agent_connector_owner_is_owner). Off (NULL) is immediate and needs no trigger.';

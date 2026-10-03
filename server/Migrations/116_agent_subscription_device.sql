-- =============================================================================
-- 116_agent_subscription_device.sql — #3392 AIH-2 (ADR-0193 증보 2026-10-03)
--
-- 「로그인 직후 대행 등록」의 멱등 키 (소유자, 하네스, 기기)를 기록할 자리.
--
-- 데스크탑이 「Claude Code로 로그인」 직후 `POST …/subscription-agents/register`를
-- 부르면 서버는 이 사람·이 CLI·이 맥의 구독 에이전트가 이미 있는지 먼저 본다.
-- 있으면 같은 에이전트를 돌려주고(새 에이전트 0건), 없으면 만든다. 그 판정이
-- 경합(두 창, 재시도)에서도 하나의 행으로 수렴하도록 DB가 지킨다.
--
--   agent.subscription_device_id  앱이 만든 임의 설치 식별자(하드웨어 ID 아님).
--                                 비밀이 아니다. owner_only 행에만 있다.
--
-- RLS: `agent`는 001_init.sql의 테넌트 테이블이고 FORCE RLS + ws_isolation 대상이다.
-- 컬럼·부분 유니크 인덱스 추가는 그 정책을 그대로 물려받는다. 새 테이블·새 권한
-- 없음. schema_v0.sql 무접촉. 089의 owner_only 불변 트리거는 이 컬럼을 건드리지
-- 않는다(기기 id는 소유자·하네스처럼 권한의 근거가 아니라 중복 방지 키다).
-- =============================================================================

ALTER TABLE agent
  ADD COLUMN subscription_device_id text
    CHECK (subscription_device_id IS NULL
           OR (char_length(subscription_device_id) BETWEEN 8 AND 64
               AND subscription_device_id ~ '^[A-Za-z0-9._-]+$'));

ALTER TABLE agent
  ADD CONSTRAINT agent_subscription_device_requires_owner_only CHECK (
    subscription_device_id IS NULL OR invocation_scope = 'owner_only'
  );

CREATE UNIQUE INDEX agent_subscription_device_uidx
  ON agent (workspace_id, owner_human_id, subscription_harness, subscription_device_id)
  WHERE subscription_device_id IS NOT NULL;

COMMENT ON COLUMN agent.subscription_device_id IS
  '#3392 ADR-0193 증보: 대행 등록 멱등 키의 기기 몫(앱이 만든 임의 설치 id). owner_only 행에만. (workspace, owner, harness, device) 유니크.';

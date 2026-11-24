-- =============================================================================
-- 191_agent_reaction_count.sql — #6068 (ADR-0162 증보 8, Accepted 2026-11-23)
--
-- 에이전트가 스스로 고르는 반응(oort_reaction_set)의 run 하나당 달기 셈 자리 하나.
--
--   agent_run.agent_reaction_count  그 run 에서 이 도구로 반응을 단 횟수(R7, 3번까지). run 행에 묶여
--                                   있고 에이전트가 줄이는 길이 없다 — 떼어도 돌아오지 않는다(달았다
--                                   뗐다로 프레임을 늘릴 수 없다). 0..3 CHECK. 반응 행을 실제로 쓴 tx
--                                   에서만 1 올리고, 그 tx 는 run 행을 이미 잠그고 있다(lock_gateway_run).
--                                   updated_at 은 건드리지 않는다(스위프가 그 값을 읽는다 — 188 과 같다).
--                                   서버가 다는 눈 · 체크의 셈(188 status_eye_attach_count)과 따로다.
--
-- 바뀌지 않는 것
--   * 역할 권한(infra/rust/sql/bootstrap_*)은 그대로다. 새 열은 agent_run 의 표 단위 권한을 이미 가진
--     역할만 쓴다.
--   * 새 표 · 새 트리거 · 새 SECURITY DEFINER 함수 없음. agent_run 의 기존 트리거는 status 열의 변화에만
--     걸려 있어 셈 열을 올려도 돌지 않는다(128 · 120).
--   * 반응 행 · 프레임 · 감사 줄의 모양은 사람의 반응과 같다(reaction 표 그대로).
-- =============================================================================

ALTER TABLE agent_run
  ADD COLUMN IF NOT EXISTS agent_reaction_count smallint NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agent_run_agent_reaction_count_ck'
  ) THEN
    ALTER TABLE agent_run
      ADD CONSTRAINT agent_run_agent_reaction_count_ck
      CHECK (agent_reaction_count BETWEEN 0 AND 3);
  END IF;
END
$$;

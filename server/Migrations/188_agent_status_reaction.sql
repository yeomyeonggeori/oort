-- =============================================================================
-- 188_agent_status_reaction.sql — #6067 (ADR-0200 증보 8, Accepted 2026-11-23)
--
-- 에이전트의 상태 반응(가져가면 눈 · 성공으로 끝나면 체크)이 쓰는 자리 둘과 뒤따르는 정리의 색인 하나.
--
--   agent.agent_reactions            에이전트 값(L10). NULL = 워크스페이스 값을 따른다. 세 낱말만
--                                    (off · status · free) — CHECK. 유효 값은 워크스페이스 값과 이 값
--                                    가운데 좁은 쪽이다(서버가 읽을 때 정한다, 저장은 거절하지 않음).
--                                    사람 세션의 프로필 저장 길에서만 쓴다.
--   agent_run.status_eye_attach_count run 하나에 서버가 눈을 단 횟수(L3, 3번까지). run 행에 묶여 있고
--                                    에이전트가 쓰는 길이 없다. 0..3 CHECK. 눈을 실제로 단 tx에서만
--                                    1 올린다. updated_at은 건드리지 않는다(스위프가 그 값을 읽는다).
--   agent_run_trigger_pair_idx       눈 행마다 그 (글, 에이전트)의 run을 찾는 질의(가장 새 run · 가져간
--                                    run 있는지)를 받치는 부분 색인. 부른 글이 있는 run만 싣는다.
--                                    agent_run의 기존 색인 관례(187 agent_run_work_item_idx)대로
--                                    migration tx 안의 보통 CREATE INDEX다.
--   reaction_status_eye_idx          뒤따르는 정리(L7 5)가 「눈 행」에서 출발해 찾는 색인. 시간 창이
--                                    없으므로 api가 오래 꺼져 있던 뒤에도 오래전에 끝난 run의 눈을
--                                    놓치지 않는다.
--
-- 바뀌지 않는 것
--   * 역할 권한(infra/rust/sql/bootstrap_*)은 그대로다. 새 열은 표 단위 권한을 이미 가진 역할만 쓴다.
--     notifier는 reaction 표에 권한이 없고 이 파일도 주지 않는다(LA12).
--   * 새 표 · 새 트리거 · 새 SECURITY DEFINER 함수 없음. agent_run의 기존 트리거는 status 열의
--     변화에만 걸려 있어 셈 열을 올려도 돌지 않는다(128 · 120).
--   * 워크스페이스 값은 열이 아니라 workspace.settings 묶음의 키 agent_reactions다(L10).
-- =============================================================================

ALTER TABLE agent
  ADD COLUMN IF NOT EXISTS agent_reactions text NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agent_agent_reactions_ck'
  ) THEN
    ALTER TABLE agent
      ADD CONSTRAINT agent_agent_reactions_ck
      CHECK (agent_reactions IS NULL OR agent_reactions IN ('off', 'status', 'free'));
  END IF;
END
$$;

ALTER TABLE agent_run
  ADD COLUMN IF NOT EXISTS status_eye_attach_count smallint NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agent_run_status_eye_attach_count_ck'
  ) THEN
    ALTER TABLE agent_run
      ADD CONSTRAINT agent_run_status_eye_attach_count_ck
      CHECK (status_eye_attach_count BETWEEN 0 AND 3);
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS reaction_status_eye_idx
  ON reaction (workspace_id, message_id, member_id)
  WHERE emoji = '👀';

CREATE INDEX IF NOT EXISTS agent_run_trigger_pair_idx
  ON agent_run (workspace_id, trigger_message_id, agent_member_id, created_at DESC, id DESC)
  WHERE trigger_message_id IS NOT NULL;

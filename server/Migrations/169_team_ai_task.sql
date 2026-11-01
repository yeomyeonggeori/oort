-- =============================================================================
-- 169_team_ai_task.sql — #4967 (ADR-0201 증보 v3 B5·B13-I7·B14-S4, Accepted 2026-11-01)
--
-- 도우미 「작업 모드」의 표지. 호출한 Mention·ThreadReply run을 단계 job으로 이어 가는 긴 조사가
-- 어느 run에서 몇 단계째인지, 단계 사이에 무엇이 남는지를 서버가 쥔다.
--
-- 표지 = **행의 존재**다. payload나 job 모양이 아니라 이 행이 작업 모드 판정이라서, 재개·재claim에서도
-- 같은 판정이 나온다(`momo_agent::team_ai_task`). 한 단계를 두 번 실행하지 않는 장치도 이 행이 쥔다:
--   * `steps_done`  — 끝낸 단계 수(첫 요청이 1단계). 단계 커밋은 `steps_done = 직전 값` 조건부 UPDATE(CAS).
--   * `claim_token` / `claim_until` — 한 단계를 실행 중인 worker의 임대(claim 하나가 job 임대 id).
--                      만료되면 다른 worker가 이어받고, 살아 있으면 다른 worker는 그 단계를 실행하지 않는다.
--
-- 단계 사이에 남는 것은 **계획(닫힌 JSON ≤8항목)과 노트(≤2,000자)** 뿐이다. 대화 전문·도구 결과는
-- 저장하지 않는다(다음 단계가 필요하면 읽기 도구로 다시 가져오고, 요청자 권한·청중 규칙이 매번 다시 걸린다).
-- 노트는 모델이 쓴 글이라 읽은 내용이 섞일 수 있는 서버 내부 상태다 — 어느 API도 읽지 않고,
-- **끝난 행에는 노트·계획·임대가 있을 수 없다**(`team_ai_task_ended_ck`). 「종결 뒤 노트 삭제」를 앱 규율이
-- 아니라 DB가 보장하므로, 끝내는 문장이 노트를 지우지 않으면 UPDATE 자체가 실패한다.
--
-- 권한: RLS ENABLE + FORCE + ws_isolation(141·164와 같은 모양). 이 migration이 **직접 주는** 것은 서버 쪽 역할 둘뿐이다 —
--   momo_app    api. `live_run_count_in_tx`(작업 run은 동시 실행 칸에서 뺀다)가 행의 존재를 읽고,
--               취소 라우트(`cancel_run_in_tx`)가 같은 tx에서 작업을 끝낸다.
--   momo_worker agent-worker. 단계 임대·커밋·종결을 쓴다(BYPASSRLS라서 쓰는 문장이 workspace_id를 직접 명시한다).
-- 둘에게 주는 것은 SELECT, INSERT, UPDATE이고, 앱 코드에는 이 표의 DELETE 문장이 없다(행은 지우지 않고 끝낸다 —
-- 노트만 사라진다. run이 지워지면 CASCADE로 함께 사라진다). PUBLIC에서는 거둔다.
-- **시험이 재는 것**(worker t12): PUBLIC은 아무것도 없고, 도우미 읽기 역할 momo_helper_read(명시한 표만 SELECT)는
-- SELECT도 못 하며, 다른 워크스페이스의 행은 읽지도 쓰지도 못한다.
-- **이 migration이 정하지 못하는 것**: 실제로 역할이 가진 권한은 다른 테넌트 표와 똑같이 역할 부트스트랩의
-- `GRANT … ON ALL TABLES`·`ALTER DEFAULT PRIVILEGES`가 덧붙인다(thread_follow 등과 같은 방식). 그래서 momo_app·momo_worker·
-- momo_relay는 DELETE까지, 개발용 bootstrap_roles.sql에서는 momo_notifier도 이 표의 권한을 갖는다. 이 표를 읽고 쓰는
-- 코드는 api와 worker뿐이다. 더 좁히려면 mem-lockdown 같은 REVOKE 블록이 부트스트랩 파일에 필요하다(이 칸에서는 안 했다 —
-- migration에서 REVOKE해도 부트스트랩을 다시 돌리면 되돌아간다).
--
-- schema_v0.sql 은 건드리지 않는다. 다시 적용해도 무해하다.
-- =============================================================================

CREATE TABLE IF NOT EXISTS team_ai_task (
  workspace_id    uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  run_id          uuid NOT NULL REFERENCES agent_run(id) ON DELETE CASCADE,
  agent_member_id uuid NOT NULL REFERENCES member(id) ON DELETE CASCADE,
  state           text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'ended')),
  -- 끝난 까닭(닫힌 어휘는 앱이 쥔다: done · task_limit · task_cancelled · task_requester_gone ·
  -- task_provider_error · task_role_off · …). 활성 행에는 없다.
  end_reason      text CHECK (end_reason IS NULL OR char_length(end_reason) BETWEEN 1 AND 48),
  steps_done      integer NOT NULL DEFAULT 0 CHECK (steps_done >= 0),
  model_calls     integer NOT NULL DEFAULT 0 CHECK (model_calls >= 0),
  tool_calls      integer NOT NULL DEFAULT 0 CHECK (tool_calls >= 0),
  web_searches    integer NOT NULL DEFAULT 0 CHECK (web_searches >= 0),
  plan            jsonb CHECK (plan IS NULL OR (jsonb_typeof(plan) = 'array' AND jsonb_array_length(plan) <= 8)),
  note            text CHECK (note IS NULL OR char_length(note) <= 2000),
  claim_token     uuid,
  claim_until     timestamptz,
  started_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  ended_at        timestamptz,
  PRIMARY KEY (workspace_id, run_id),
  CONSTRAINT team_ai_task_claim_ck CHECK ((claim_token IS NULL) = (claim_until IS NULL)),
  CONSTRAINT team_ai_task_ended_ck CHECK (
    (state = 'active' AND end_reason IS NULL AND ended_at IS NULL)
    OR (state = 'ended' AND end_reason IS NOT NULL AND ended_at IS NOT NULL
        AND plan IS NULL AND note IS NULL AND claim_token IS NULL AND claim_until IS NULL)
  )
);

-- 워크스페이스·요청자별 동시 작업 수(상한 3/1)를 세는 입구. 활성 행만 훑는다.
CREATE INDEX IF NOT EXISTS team_ai_task_active_idx ON team_ai_task (workspace_id) WHERE state = 'active';

COMMENT ON TABLE team_ai_task IS
  'ADR-0201 증보 v3 B5 (#4967): marker of the team AI task mode, one row per run. The ROW''S EXISTENCE is the '
  'judgement (re-claim and resume read the same fact). steps_done + claim_token/claim_until guarantee one execution '
  'per step. plan (<=8 items) and note (<=2000 chars) are server-internal state between steps and are gone once the '
  'row is ended (team_ai_task_ended_ck). Granted to momo_app and momo_worker only; no API reads it.';

ALTER TABLE team_ai_task ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_ai_task FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ws_isolation ON team_ai_task;
CREATE POLICY ws_isolation ON team_ai_task
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

REVOKE ALL ON TABLE team_ai_task FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_app') THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE team_ai_task TO momo_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_worker') THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE team_ai_task TO momo_worker;
  END IF;
END $$;

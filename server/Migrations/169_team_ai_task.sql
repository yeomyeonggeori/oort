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
-- 권한 (보안 검수 r1 M1): RLS ENABLE + FORCE + ws_isolation(141·164와 같은 모양). 노트는 읽은 글이 섞인 모델 글이고
--   BYPASSRLS 역할(relay·worker·notifier)은 RLS를 건너뛰므로 표 권한이 마지막 문이다. 그래서 아래
--   team-ai-task-lockdown 블록이 역할마다 **코드가 쓰는 권한만** 남긴다(self-media-token-lockdown과 같은 모양):
--     momo_app     SELECT·UPDATE         api. `live_run_count_in_tx`가 행의 존재를 읽고(작업 run은 동시 실행 칸에서 뺀다),
--                                        취소 라우트(`cancel_run_in_tx`)가 같은 tx에서 작업을 끝낸다. 행을 만들지 않는다
--     momo_worker  SELECT·INSERT·UPDATE  agent-worker. 작업 시작(INSERT)·단계 임대·커밋·종결·청소(UPDATE)를 쓴다
--                                        (BYPASSRLS라서 쓰는 문장이 workspace_id를 직접 명시한다)
--     relay·notifier·platform_admin  없음
--   DELETE는 어느 역할에도 없다(앱 코드에 이 표의 DELETE 문장이 없다: 행은 지우지 않고 끝낸다 — 노트만 사라진다).
--   run·워크스페이스가 지워지면 외래 키 CASCADE가 표 소유자 권한으로 함께 지운다. PUBLIC에서도 거둔다.
--   블록은 이 파일·bootstrap_roles.sql·bootstrap_runtime_roles.sql에 같은 글자로 있다(두 bootstrap 파일은 마이그레이션 뒤에
--   ALL TABLES 권한을 다시 주므로, 이 파일에서만 거두면 다음 bootstrap이 되돌린다).
-- **시험이 재는 것**(worker t12·t19·t20, momo-agent `team_ai_task_static_guards`): PUBLIC·도우미 읽기 역할 momo_helper_read는
--   아무것도 못 하고, 다섯 역할이 가진 권한이 위 표와 정확히 같고, 세 파일의 블록이 같은 글자이고, 다른 워크스페이스의
--   행은 읽지도 쓰지도 못하며, 다른 워크스페이스의 run·멤버를 가리키는 행은 만들 수 없다(아래 복합 외래 키, 보안 검수 r1 L2).
--
-- schema_v0.sql 은 건드리지 않는다. 다시 적용해도 무해하다.
-- =============================================================================

CREATE TABLE IF NOT EXISTS team_ai_task (
  workspace_id    uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  run_id          uuid NOT NULL,
  agent_member_id uuid NOT NULL,
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
  -- 보안 검수 r1 L2: 복합 외래 키(030·133과 같은 모양). 단일 열 FK는 run·멤버 id 값만 보고 통과시켜서 다른
  -- 워크스페이스의 run을 가리키는 행이 만들어졌다(RLS의 WITH CHECK는 workspace_id 열만 본다).
  CONSTRAINT team_ai_task_run_fk FOREIGN KEY (workspace_id, run_id)
    REFERENCES agent_run (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT team_ai_task_agent_fk FOREIGN KEY (workspace_id, agent_member_id)
    REFERENCES member (workspace_id, id) ON DELETE CASCADE,
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
  'row is ended (team_ai_task_ended_ck). Privileges are exactly what the code uses (team-ai-task-lockdown): momo_app '
  'SELECT, UPDATE; momo_worker SELECT, INSERT, UPDATE; no other role, no DELETE for anyone; no API reads it.';

ALTER TABLE team_ai_task ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_ai_task FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ws_isolation ON team_ai_task;
CREATE POLICY ws_isolation ON team_ai_task
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

-- BEGIN team-ai-task-lockdown (#4967 security review r1 M1; ADR-0201 증보 v3 B13-I7). Identical in
-- 169_team_ai_task.sql, bootstrap_roles.sql and bootstrap_runtime_roles.sql; tests compare the text
-- between the markers. A row's note is model-written text that may carry what the helper read for one
-- requester, and the BYPASSRLS roles skip RLS, so their table privileges are what keeps every tenant's
-- notes away from a role with no business reading them. Each runtime role gets exactly what the code
-- does: momo_worker runs the task (INSERT starts one, UPDATE claims, commits, ends and sweeps, SELECT
-- reads it); momo_app only counts the concurrency slot (SELECT) and ends the task a cancel stops
-- (UPDATE); nobody deletes a row (an ended row is kept, its note gone — a foreign-key cascade from the
-- run or the workspace runs as the table's owner, so deleting a parent still clears its rows); relay,
-- notifier and platform_admin do not touch it at all. Idempotent and order-proof (a pass before the
-- table or the roles exist finishes what it can, the pass after lands the rest), and it fails loudly
-- if the result is not what is written here.
DO $$
DECLARE
  r text;
  p text;
  allowed text[];
BEGIN
  IF to_regclass('public.team_ai_task') IS NULL THEN
    RETURN;
  END IF;
  REVOKE ALL ON TABLE public.team_ai_task FROM PUBLIC;
  FOREACH r IN ARRAY ARRAY['momo_app', 'momo_relay', 'momo_worker', 'momo_notifier', 'momo_platform_admin'] LOOP
    CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r);
    allowed := CASE r
      WHEN 'momo_app' THEN ARRAY['SELECT', 'UPDATE']
      WHEN 'momo_worker' THEN ARRAY['SELECT', 'INSERT', 'UPDATE']
      ELSE ARRAY[]::text[]
    END;
    EXECUTE format('REVOKE ALL ON TABLE public.team_ai_task FROM %I', r);
    IF cardinality(allowed) > 0 THEN
      EXECUTE format('GRANT %s ON TABLE public.team_ai_task TO %I', array_to_string(allowed, ', '), r);
    END IF;
    FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
      IF has_table_privilege(r, 'public.team_ai_task', p) IS DISTINCT FROM (p = ANY (allowed)) THEN
        RAISE EXCEPTION 'role % must % % on team_ai_task',
          r, CASE WHEN p = ANY (allowed) THEN 'hold' ELSE 'not hold' END, p;
      END IF;
    END LOOP;
  END LOOP;
END $$;
-- END team-ai-task-lockdown

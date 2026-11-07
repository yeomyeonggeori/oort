-- =============================================================================
-- 177_team_ai_task_delegation.sql — #5370 (ADR-0201 증보 v4 P4·P7·I6, P14-S2, Accepted 2026-11-05)
--
-- 도우미가 팀 Hermes에 일을 맡기는 걸음(「위임」)의 표지. 위임은 작업 모드의 한 걸음이라서 새 표를 만들지
-- 않고 team_ai_task 행에 열을 더한다(169의 행 존재 = 작업 모드 판정이 그대로 위임에도 쓰인다).
--
-- 열
--   delegation_kind          'web_search' | 'image'. 위임 행에만 있다(일반 작업 행은 NULL).
--   delegation_state         'pending' → 'called' → 'done' | 'failed'.
--                            `called` = 「Hermes를 부르겠다」를 **부르기 전에** 커밋한 표지(at-most-once, I5).
--                            이 표지가 `called` 이상이면 재claim은 Hermes를 다시 부르지 않는다.
--   delegation_called_at     `called` 시각. 한도(하루·요청자 10분·동시) 계수의 출처다(P7) — 표지와 함께
--                            종결 뒤에도 남는다. `pending`일 때만 NULL.
--   delegation_target        부른 Hermes의 멤버 id. `called`와 같은 문장에서 쓰인다(원장 Hermes 행의 주인).
--                            외래 키는 두지 않는다: 멤버 삭제가 위임 기록을 지우면 안 된다.
--   delegation_request       도우미가 Hermes에 보낼 **요청 문장 하나**(2~1,200자). 사람이 아닌 모델이 쓴 글이라
--                            이 행에만 있다(감사·로그·원장·props·job payload 어디에도 없다, I6).
--
-- 규칙을 DB가 쥐는 곳(앱 코드가 틀려도 지켜지는 것)
--   * team_ai_task_ended_ck 에 `delegation_request IS NULL`을 넣었다: **끝난 행에는 요청 문장이 있을 수 없다**
--     (종결·취소·고아 청소·requester_gone·agent_gone 어느 길로 끝나도). 끝내는 문장이 문장을 지우지 않으면
--     UPDATE 자체가 실패한다. (169의 제약을 이 파일이 지우고 다시 만든다 — 169는 고치지 않는다.)
--   * team_ai_task_delegation_ck: 위임 열 다섯 개는 모두 NULL이거나(일반 작업) 모양이 맞게 함께 있다.
--     `pending`은 호출 시각·대상이 없고, 그 밖의 상태는 둘 다 있다.
--
-- 권한 (보안 검수 r1 M1을 이어서)
--   momo_app 은 이제 표 단위 SELECT가 없다. UPDATE(취소가 작업을 끝낸다: 문장도 같은 문장에서 지운다)와
--   **delegation_request 만 뺀 열 단위 SELECT**를 가진다. api가 요청 문장을 읽을 길을 DB가 막는다.
--   momo_worker 는 그대로 SELECT·INSERT·UPDATE(문장을 보내는 유일한 역할). 나머지는 없음, DELETE는 누구도 없음.
--   블록은 이 파일·bootstrap_roles.sql·bootstrap_runtime_roles.sql에 같은 글자로 있다(두 bootstrap 파일은
--   마이그레이션 뒤에 ALL TABLES 권한을 다시 주므로, 이 파일에서만 거두면 다음 bootstrap이 되돌린다).
--   169의 블록은 그대로 남는다(이미 적용된 파일). 이 파일의 블록이 그 뒤에 적용되어 이긴다.
--
-- RLS: 이 표는 169에서 ENABLE + FORCE + ws_isolation 이다. 새 열은 같은 정책 아래에 있다.
--
-- schema_v0.sql 은 건드리지 않는다. 다시 적용해도 무해하다.
-- =============================================================================

ALTER TABLE team_ai_task
  ADD COLUMN IF NOT EXISTS delegation_kind      text,
  ADD COLUMN IF NOT EXISTS delegation_state     text,
  ADD COLUMN IF NOT EXISTS delegation_called_at timestamptz,
  ADD COLUMN IF NOT EXISTS delegation_target    uuid,
  ADD COLUMN IF NOT EXISTS delegation_request   text;

ALTER TABLE team_ai_task DROP CONSTRAINT IF EXISTS team_ai_task_delegation_ck;
ALTER TABLE team_ai_task ADD CONSTRAINT team_ai_task_delegation_ck CHECK (
  (delegation_kind IS NULL AND delegation_state IS NULL AND delegation_called_at IS NULL
     AND delegation_target IS NULL AND delegation_request IS NULL)
  OR (delegation_kind IS NOT NULL AND delegation_state IS NOT NULL   -- (a NULL in an IN list passes a CHECK)
      AND delegation_kind IN ('web_search', 'image')
      AND delegation_state IN ('pending', 'called', 'done', 'failed')
      AND ((delegation_state = 'pending') = (delegation_called_at IS NULL))
      AND ((delegation_state = 'pending') = (delegation_target IS NULL))
      AND (delegation_request IS NULL OR char_length(delegation_request) BETWEEN 2 AND 1200))
);

-- 끝난 행에는 노트·계획·임대에 더해 요청 문장도 있을 수 없다(169의 제약을 같은 이름으로 다시 만든다).
ALTER TABLE team_ai_task DROP CONSTRAINT IF EXISTS team_ai_task_ended_ck;
ALTER TABLE team_ai_task ADD CONSTRAINT team_ai_task_ended_ck CHECK (
  (state = 'active' AND end_reason IS NULL AND ended_at IS NULL)
  OR (state = 'ended' AND end_reason IS NOT NULL AND ended_at IS NOT NULL
      AND plan IS NULL AND note IS NULL AND claim_token IS NULL AND claim_until IS NULL
      AND delegation_request IS NULL)
);

-- 위임 한도 계수(오늘·요청자 10분·동시)의 입구. 호출된 행만 훑는다.
CREATE INDEX IF NOT EXISTS team_ai_task_delegation_idx
  ON team_ai_task (workspace_id, delegation_called_at)
  WHERE delegation_called_at IS NOT NULL;

COMMENT ON TABLE team_ai_task IS
  'ADR-0201 증보 v3 B5 (#4967): marker of the team AI task mode, one row per run. The ROW''S EXISTENCE is the '
  'judgement (re-claim and resume read the same fact). steps_done + claim_token/claim_until guarantee one execution '
  'per step. plan (<=8 items) and note (<=2000 chars) are server-internal state between steps and are gone once the '
  'row is ended (team_ai_task_ended_ck). ADR-0201 증보 v4 (#5370): a delegation to the team Hermes is one such step; '
  'delegation_state pending/called/done/failed is the at-most-once marker and delegation_request is the one request '
  'sentence, gone once the row is ended. Privileges are exactly what the code uses (team-ai-task-lockdown): '
  'momo_app UPDATE and SELECT of every column but delegation_request; momo_worker SELECT, INSERT, UPDATE; '
  'no other role, no DELETE for anyone; no API reads the sentence.';

-- BEGIN team-ai-task-lockdown (#4967 security review r1 M1; ADR-0201 증보 v3 B13-I7; v2 = #5370, ADR-0201
-- 증보 v4 P4·I6). Identical in 177_team_ai_task_delegation.sql, bootstrap_roles.sql and
-- bootstrap_runtime_roles.sql; tests compare the text between the markers. A row's note is model-written
-- text that may carry what the helper read for one requester, and a delegating row's request sentence is
-- the one sentence the helper hands to Hermes; the BYPASSRLS roles skip RLS, so their table privileges are
-- what keeps every tenant's notes away from a role with no business reading them. Each runtime role gets
-- exactly what the code does: momo_worker runs the task (INSERT starts one, UPDATE claims, commits, ends
-- and sweeps, SELECT reads it, the request sentence included — it is the only role that sends it);
-- momo_app counts the concurrency slot and reads the marker (SELECT of every column but the request
-- sentence: delegation_request is NOT in its column list) and ends the task a cancel stops (UPDATE, which
-- clears the sentence); nobody deletes a row (an ended row is kept, its note and its sentence gone — a
-- foreign-key cascade from the run or the workspace runs as the table's owner, so deleting a parent still
-- clears its rows); relay, notifier and platform_admin do not touch it at all. Idempotent and order-proof
-- (a pass before the table, the new column or the roles exist finishes what it can, the pass after lands
-- the rest), and it fails loudly if the result is not what is written here.
DO $$
DECLARE
  r text;
  p text;
  c text;
  allowed text[];
  app_columns text[] := ARRAY[
    'workspace_id', 'run_id', 'agent_member_id', 'state', 'end_reason', 'steps_done', 'model_calls',
    'tool_calls', 'web_searches', 'plan', 'note', 'claim_token', 'claim_until', 'started_at',
    'updated_at', 'ended_at', 'delegation_kind', 'delegation_state', 'delegation_called_at',
    'delegation_target'];
BEGIN
  IF to_regclass('public.team_ai_task') IS NULL THEN
    RETURN;
  END IF;
  -- (a separate statement: a cast of the name to regclass is evaluated even when the first test above
  -- would have returned, and fails if the table is not there yet)
  IF NOT EXISTS (SELECT 1 FROM pg_attribute
                  WHERE attrelid = to_regclass('public.team_ai_task')
                    AND attname = 'delegation_request' AND NOT attisdropped) THEN
    RETURN;
  END IF;
  REVOKE ALL ON TABLE public.team_ai_task FROM PUBLIC;
  FOREACH r IN ARRAY ARRAY['momo_app', 'momo_relay', 'momo_worker', 'momo_notifier', 'momo_platform_admin'] LOOP
    CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r);
    allowed := CASE r
      WHEN 'momo_app' THEN ARRAY['UPDATE']
      WHEN 'momo_worker' THEN ARRAY['SELECT', 'INSERT', 'UPDATE']
      ELSE ARRAY[]::text[]
    END;
    EXECUTE format('REVOKE ALL ON TABLE public.team_ai_task FROM %I', r);
    IF cardinality(allowed) > 0 THEN
      EXECUTE format('GRANT %s ON TABLE public.team_ai_task TO %I', array_to_string(allowed, ', '), r);
    END IF;
    IF r = 'momo_app' THEN
      EXECUTE format(
        'GRANT SELECT (%s) ON TABLE public.team_ai_task TO %I',
        (SELECT string_agg(quote_ident(x), ', ') FROM unnest(app_columns) AS x), r);
    END IF;
    FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
      IF has_table_privilege(r, 'public.team_ai_task', p) IS DISTINCT FROM (p = ANY (allowed)) THEN
        RAISE EXCEPTION 'role % must % % on team_ai_task',
          r, CASE WHEN p = ANY (allowed) THEN 'hold' ELSE 'not hold' END, p;
      END IF;
    END LOOP;
    FOR c IN SELECT attname::text FROM pg_attribute
              WHERE attrelid = 'public.team_ai_task'::regclass AND attnum > 0 AND NOT attisdropped LOOP
      IF has_column_privilege(r, 'public.team_ai_task', c, 'SELECT')
         IS DISTINCT FROM (r = 'momo_worker' OR (r = 'momo_app' AND c = ANY (app_columns))) THEN
        RAISE EXCEPTION 'role % must % SELECT on team_ai_task.%',
          r,
          CASE WHEN r = 'momo_worker' OR (r = 'momo_app' AND c = ANY (app_columns)) THEN 'hold' ELSE 'not hold' END,
          c;
      END IF;
    END LOOP;
  END LOOP;
END $$;
-- END team-ai-task-lockdown

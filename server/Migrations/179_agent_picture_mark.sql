-- =============================================================================
-- 179_agent_picture_mark.sql — #5530 (ADR-0151 증보 8 보충, 구현 보안 검수 M-1 (b), #5372 인계)
--
-- 왜
--   api 의 하루 백스톱(AGENT_PICTURES_DAILY_CEILING = 200)은 `attachment` 행을 세었다. momo_worker 는 그 표에
--   UPDATE·DELETE 가 있고(created_at·status 를 고치거나 행을 지우면 숫자가 되돌아간다), 셈이 기대는 member.kind
--   도 고칠 수 있다. 실 PG 로 재 보니 워커가 오늘 값을 줄이는 길은 이렇다(권한 시험 모두 momo_worker 로 한 것):
--     attachment.created_at 되돌리기 · status 바꾸기 · attachment 행 삭제 · 에이전트 member.kind 를 human 으로 ·
--     channel 삭제(FK 연쇄로 attachment 가 같이 지워진다) · workspace 삭제(연쇄로 전부)
--   첫 후보였던 「attachment_write_token 에서 쓴 토큰을 센다」도 같은 이유로 안 된다: 토큰 행은 run·channel·
--   workspace 의 FK 연쇄로 지워지고(연쇄는 **표 주인 권한**으로 돌아서 표 권한이 막지 못한다) 워커는 그 부모 표들의
--   DELETE 를 기본 권한으로 갖는다. 토큰 DELETE 를 거둬도 `agent_run` 을 지우면 토큰이 같이 사라진다.
--   그래서 세는 원본을 **FK 가 없는 덧붙이기 전용 표지 표**로 옮긴다.
--
-- 무엇
--   agent_picture_mark  api 가 에이전트의 그림 한 장을 보관소와 attachment 에 쓴 **같은 tx 에서** 한 줄 더한다.
--                       api 의 하루 상한은 이 표에서 최근 24시간(굴러가는 창, DB 시계 clock_timestamp())의 줄을 센다.
--                       열: workspace_id · attachment_id(PK 와 함께) · run_id · agent_member_id · written_at.
--                       **외래 키를 어느 방향으로도 두지 않는다**(workspace·run·channel·attachment·member 어느 것에도).
--                       FK 가 있으면 부모 삭제의 연쇄가 표 주인 권한으로 이 표를 지워서, 권한이 막은 DELETE 를 워커가
--                       부모 삭제로 되찾는다(위 측정). 그래서 참조 무결성 대신 PK (workspace_id, attachment_id)와
--                       트리거가 줄을 지킨다. 줄은 내용이 없다: 워크스페이스·첨부·run·에이전트 id 와 시각뿐이다.
--
-- 규칙을 DB가 쥐는 곳(앱 코드가 틀려도 지켜지는 것)
--   * 한 줄은 바뀌지 않는다: 어떤 UPDATE 도 트리거가 거절한다. 표를 비우는 TRUNCATE 도 문장 트리거가 거절한다
--     (행 트리거는 TRUNCATE 에 걸리지 않는다. 표 주인도 마찬가지 — #5530 구현 검수 L-1).
--   * 하루 창 안의 줄은 지울 수 없다: DELETE 는 written_at 이 24시간보다 오래된 줄만 통과한다(셈의 창과 같은 술어의
--     정확히 반대). api 의 청소가 창 값을 잘못 써도 오늘 값은 지워지지 않고 그 tx 가 실패한다.
--
-- RLS
--   attachment_write_token(175)과 같은 방식: ENABLE + FORCE + ws_isolation. api 는 비우회 역할 momo_app 이 경로의
--   워크스페이스로 묶은 tx 에서 세고 쓰고 청소한다.
--
-- 표 권한
--   아래 agent-picture-mark-lockdown 블록: momo_app = SELECT·INSERT·DELETE(셈·행 쓰기·청소). 그 밖의 모든 역할(워커·
--   relay·notifier·platform_admin, 워커가 SET ROLE 할 수 있는 helper 읽기 역할과 momo_memory)은 **아무것도** 없다.
--   워커는 읽지도 못한다. SET 으로만 닿는 두 역할을 블록이 이름으로 부르는 까닭: INHERIT FALSE 멤버십의 권한은
--   has_table_privilege('momo_worker', …)에 보이지 않는다(#5530 구현 검수 M-1).
--   attachment-write-token-lockdown 블록도 이 파일이 **다시 낸다**(175 의 첫 판은 이미 적용된 파일이라 고치지 않는다 —
--   169 → 177 의 team-ai-task-lockdown 과 같은 방식): momo_worker 는 DELETE 를 잃고(SELECT·INSERT), momo_app 은
--   하루 지난 토큰 청소를 위해 DELETE 를 얻는다(SELECT·UPDATE·DELETE). 두 블록은 이 파일·bootstrap_roles.sql·
--   bootstrap_runtime_roles.sql 에 같은 글자로 있다(두 bootstrap 파일은 마이그레이션 뒤에 ALL TABLES 권한을 다시 주므로,
--   이 파일에서만 거두면 다음 bootstrap 이 되돌린다).
--
-- 청소
--   api 가 토큰을 풀 때마다(풀기 tx 안, 같은 워크스페이스) 만료 하루 뒤의 토큰 행과 24시간 창의 두 배(48시간)보다
--   오래된 표지 줄을 지운다. 워커는 더 이상 지우지 않는다. api 는 테넌트를 나열할 수 없어서(attachment_reclaim.rs 머리말)
--   주기 작업 대신 이렇게 호출마다 자기 워크스페이스를 청소한다 — 175 의 「만들 때마다 청소」와 같은 모양이다.
--   삭제된 워크스페이스의 표지 줄은 청소할 호출이 없어 남는다(id 뿐인 줄이고 하루 상한 이하로 쌓이며 아무것도 이 줄을
--   가리키지 않는다).
--
-- schema_v0.sql 은 건드리지 않는다. 175 는 고치지 않는다. 다시 적용해도 무해하다(표는 한 번만 만들어진다).
-- =============================================================================

CREATE TABLE agent_picture_mark (
  workspace_id    uuid NOT NULL,
  attachment_id   uuid NOT NULL,
  run_id          uuid NOT NULL,
  agent_member_id uuid NOT NULL,
  written_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, attachment_id)
);

COMMENT ON TABLE agent_picture_mark IS
  '#5530: one append-only row per picture the api wrote for an agent, written in the transaction that writes the attachment. The api''s daily ceiling counts the rows of the last 24 hours. No foreign key in either direction on purpose (a cascade runs as the table owner and would let a role that may delete a parent shrink the count); momo_worker holds no privilege on it.';

-- 셈(최근 24시간)과 청소(48시간보다 오래된 줄) 용.
CREATE INDEX agent_picture_mark_window_idx ON agent_picture_mark (workspace_id, written_at);

-- 덧붙이기 전용: UPDATE·TRUNCATE 는 모두 거절, DELETE 는 하루 창 밖의 줄만. 창은 api 의 셈(agent_picture.rs)과 같은
-- 24시간이다. TRUNCATE 는 행 트리거를 거치지 않으므로 같은 함수를 문장 트리거로 한 번 더 건다(#5530 검수 L-1).
-- TG_OP 갈래가 먼저다: 문장 트리거에서는 OLD 가 NULL 이라, 창 비교가 먼저면 거짓이 되어 TRUNCATE 가 그대로 지나간다.
CREATE FUNCTION agent_picture_mark_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'agent_picture_mark is append-only' USING ERRCODE = '23514';
  END IF;
  IF OLD.written_at > clock_timestamp() - interval '24 hours' THEN
    RAISE EXCEPTION 'agent_picture_mark rows inside the counting window cannot be deleted' USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER agent_picture_mark_guard BEFORE UPDATE OR DELETE ON agent_picture_mark
  FOR EACH ROW EXECUTE FUNCTION agent_picture_mark_guard();
CREATE TRIGGER agent_picture_mark_no_truncate BEFORE TRUNCATE ON agent_picture_mark
  FOR EACH STATEMENT EXECUTE FUNCTION agent_picture_mark_guard();

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['agent_picture_mark'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY ws_isolation ON %I USING (workspace_id = current_setting(''app.workspace_id'',true)::uuid) WITH CHECK (workspace_id = current_setting(''app.workspace_id'',true)::uuid)',t);
  END LOOP;
END $$;

-- BEGIN agent-picture-mark-lockdown (#5530; ADR-0151 증보 8 보충, security review M-1 (b)). Identical in
-- 179_agent_picture_mark.sql, bootstrap_roles.sql and bootstrap_runtime_roles.sql; tests compare the text
-- between the markers. One row per picture the api wrote for an agent is what the api's daily ceiling counts,
-- and the BYPASSRLS roles skip RLS, so their table privileges are what keeps today's number out of reach of a
-- worker compromised at the database level: momo_worker, relay, notifier, platform_admin and the two roles the
-- worker may SET ROLE to (the helper's read role and momo_memory) hold nothing on it (a row of theirs, rewritten
-- or deleted, is what the old count could not survive). Those two are named here because a membership granted
-- WITH INHERIT FALSE is invisible to has_table_privilege('momo_worker', ...): a stray grant to either would
-- pass a block that did not name it and still be the worker's (#5530 implementation review M-1).
-- momo_app counts (SELECT), writes the row in the transaction that writes the attachment (INSERT) and sweeps
-- rows older than twice the window (DELETE; a trigger refuses a row inside the window whoever asks); nobody
-- updates or truncates a row (the same trigger refuses both, the owner included). The table has no foreign key
-- in either direction on purpose: a cascade runs as the table's owner, so a key to a run, channel, attachment
-- or workspace would hand a role that may delete a parent the delete the privileges withhold. Idempotent and
-- order-proof (a pass before the table or the roles exist finishes what it can, the pass after lands the
-- rest), and it fails loudly if the result is not what is written here.
DO $$
DECLARE
  r text;
  p text;
  allowed text[];
BEGIN
  IF to_regclass('public.agent_picture_mark') IS NULL THEN
    RETURN;
  END IF;
  REVOKE ALL ON TABLE public.agent_picture_mark FROM PUBLIC;
  FOREACH r IN ARRAY ARRAY['momo_app', 'momo_relay', 'momo_worker', 'momo_notifier', 'momo_platform_admin', 'momo_helper_read', 'momo_memory'] LOOP
    CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r);
    allowed := CASE r
      WHEN 'momo_app' THEN ARRAY['SELECT', 'INSERT', 'DELETE']
      ELSE ARRAY[]::text[]
    END;
    EXECUTE format('REVOKE ALL ON TABLE public.agent_picture_mark FROM %I', r);
    IF cardinality(allowed) > 0 THEN
      EXECUTE format('GRANT %s ON TABLE public.agent_picture_mark TO %I', array_to_string(allowed, ', '), r);
    END IF;
    FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
      IF has_table_privilege(r, 'public.agent_picture_mark', p) IS DISTINCT FROM (p = ANY (allowed)) THEN
        RAISE EXCEPTION 'role % must % % on agent_picture_mark',
          r, CASE WHEN p = ANY (allowed) THEN 'hold' ELSE 'not hold' END, p;
      END IF;
    END LOOP;
  END LOOP;
END $$;
-- END agent-picture-mark-lockdown

-- BEGIN attachment-write-token-lockdown (#5371; ADR-0151 증보 8 W1, security review M2; re-issued by #5530,
-- ADR-0151 증보 8 보충). Identical in 179_agent_picture_mark.sql, bootstrap_roles.sql and
-- bootstrap_runtime_roles.sql; tests compare the text between the markers. 175 carries the first copy (an
-- applied file is not edited) and this one, applied after it, wins. A row of this table lets whoever presents
-- the token write one re-encoded picture into an in-flight run's conversation as that run's agent, and the
-- BYPASSRLS roles skip RLS, so their table privileges are what keeps a forged row away from a role with no
-- business writing one. Each runtime role gets exactly what the flow uses: momo_worker mints (INSERT) and
-- reads what it writes and the attachment ids a run recorded (SELECT) and no longer deletes (it could free
-- its own spent slot that way; the day-old sweep moved to the api); momo_app spends a token and records the
-- attachment it made (UPDATE ... RETURNING, so SELECT too) and sweeps the rows a day past their expiry
-- (DELETE, in the spend's own transaction) and never creates one; relay, notifier and platform_admin do not
-- touch it at all. A foreign-key cascade (run, channel, workspace) runs as the table's owner, so deleting a
-- parent still clears its rows: this table is therefore not where the daily ceiling is counted
-- (agent_picture_mark is). Idempotent and order-proof (a pass before the table or the roles exist finishes
-- what it can, the pass after lands the rest), and it fails loudly if the result is not what is written here.
DO $$
DECLARE
  r text;
  p text;
  allowed text[];
BEGIN
  IF to_regclass('public.attachment_write_token') IS NULL THEN
    RETURN;
  END IF;
  REVOKE ALL ON TABLE public.attachment_write_token FROM PUBLIC;
  FOREACH r IN ARRAY ARRAY['momo_app', 'momo_relay', 'momo_worker', 'momo_notifier', 'momo_platform_admin'] LOOP
    CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r);
    allowed := CASE r
      WHEN 'momo_app' THEN ARRAY['SELECT', 'UPDATE', 'DELETE']
      WHEN 'momo_worker' THEN ARRAY['SELECT', 'INSERT']
      ELSE ARRAY[]::text[]
    END;
    EXECUTE format('REVOKE ALL ON TABLE public.attachment_write_token FROM %I', r);
    IF cardinality(allowed) > 0 THEN
      EXECUTE format('GRANT %s ON TABLE public.attachment_write_token TO %I', array_to_string(allowed, ', '), r);
    END IF;
    FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
      IF has_table_privilege(r, 'public.attachment_write_token', p) IS DISTINCT FROM (p = ANY (allowed)) THEN
        RAISE EXCEPTION 'role % must % % on attachment_write_token',
          r, CASE WHEN p = ANY (allowed) THEN 'hold' ELSE 'not hold' END, p;
      END IF;
    END LOOP;
  END LOOP;
END $$;
-- END attachment-write-token-lockdown

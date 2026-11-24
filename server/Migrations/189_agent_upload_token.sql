-- =============================================================================
-- 189_agent_upload_token.sql — #6013 (ADR-0151 증보 10 P2 · P5 · P7, ADR-0162 증보 7)
--
-- 왜
--   바깥에서 MCP로 붙는 에이전트(Agent Port)는 글만 올릴 수 있었다. 증보 10은 두 번째 길을 연다:
--   도구 oort_picture_upload_begin 이 1회용 올리기 주소(120초)를 주고, 에이전트가 자기 손으로 그림 한 장을
--   PUT /v1/agent-uploads/{ws}/{token} 에 한 번 보낸다. 그 주소의 뒷면이 이 표다: 토큰 하나 = 그림 한 장.
--   증보 8의 attachment_write_token(175)을 같이 쓰지 않는다 — 그 표는 run_id 가 필수이고 워커가 INSERT 한다.
--   「누가 만들었나」를 가르는 열을 한 표에 두면 그 술어를 한 곳만 빠뜨려도 워커가 만든 행이 공개 주소에서
--   풀린다(증보 8 기각 (c), 증보 10 P2).
--
-- 무엇
--   agent_upload_token  토큰의 해시(32바이트 SHA-256)만 담는다. 토큰 원문은 어떤 열에도 없다.
--                       연결 · 에이전트 · 채널에 묶인다. 풀 때와 행을 쓸 때 api 가 그 셋을 **지금** 다시 판정한다.
--                       attachment_id 는 api 가 행을 쓴 tx 가 **한 번** 적는 「이 토큰이 만든 첨부」다. 묶기
--                       (oort_message_post.attachmentIds)는 호출자가 이 길로 올린 id 인지를 이 열로 판정한다(P6).
--                       이 표는 하루 발급 셈 · 살아 있는 토큰 셈 · 묶이지 않은 그림 셈의 원본이기도 하다(P7).
--   agent_picture_mark.run_id  NOT NULL 을 푼다. 하루 그림 셈의 원본(179)을 두 길이 같이 쓰고, 이 길의 줄은
--                       run 이 없다(run_id NULL). 표의 권한 · 트리거 · 외래 키 없음은 그대로다.
--
-- 외래 키를 어느 방향으로도 두지 않는다(연결 · 멤버 · 채널 · 첨부 · 워크스페이스, P2)
--   이 표는 셈의 원본이라 부모 행이 지워질 때 연쇄로 따라 지워지면 셈이 줄고, 그 삭제를 막으면 안 된다
--   (179 가 외래 키를 뺀 까닭과 같다 — 연쇄는 표 주인 권한으로 돌아 표 권한이 막지 못한다). 대신 풀기 · 행 쓰기 ·
--   묶기가 매번 살아 있는 행을 직접 읽어 판정한다.
--
-- 규칙을 DB가 쥐는 곳(앱 코드가 틀려도 지켜지는 것)
--   * 토큰 해시는 정확히 32바이트다. 수명은 0 < ttl ≤ 10분이다(앱의 값은 120초).
--   * 한 번만 쓴다: UPDATE 는 used_at 이 NULL → 시각으로 가는 것 하나, 그리고 used_at 이 선 뒤 attachment_id
--     가 NULL → 값으로 가는 것 하나만 통과한다(175 와 같은 가드). 되돌리거나 다른 열을 고치는 UPDATE 는 거절된다.
--   * attachment_id 는 used_at 이 선 뒤에만 있을 수 있다.
--
-- RLS
--   175 · 179 와 같은 방식: ENABLE + FORCE + ws_isolation. 발급 · 풀기 · 행 쓰기 · 청소 모두 비우회 역할
--   momo_app 이 그 워크스페이스로 묶은 tx 에서 한다.
--
-- 표 권한
--   아래 agent-upload-token-lockdown 블록: momo_app = SELECT · INSERT · UPDATE · DELETE(발급 · 셈 · 풀기 ·
--   첨부 기록 · 하루 지난 행 청소). 그 밖의 모든 역할(워커 · relay · notifier · platform_admin, 워커가 SET ROLE 할 수
--   있는 helper 읽기 역할과 momo_memory)은 **아무것도** 없다 — 175 와 다른 점: 이 길의 토큰은 워커가 만들지 않는다.
--   블록은 이 파일 · bootstrap_roles.sql · bootstrap_runtime_roles.sql 에 같은 글자로 둔다(두 bootstrap 파일은
--   마이그레이션 뒤에 ALL TABLES 권한을 다시 주므로, 이 파일에서만 거두면 다음 bootstrap 이 되돌린다).
--
-- 청소
--   api 가 이 길의 토큰을 풀 때마다(풀기 tx 안, 같은 워크스페이스) 만료 하루 뒤의 행을 지운다. 그래서 하루 발급 셈
--   (최근 24시간)이 남고, 하루 지난 그림은 더는 묶이지 않는다(P6 의 의도한 수명).
--
-- schema_v0.sql 은 건드리지 않는다. 175 · 179 는 고치지 않는다.
-- =============================================================================

CREATE TABLE agent_upload_token (
  workspace_id    uuid NOT NULL,
  token_hash      bytea NOT NULL,
  connection_id   uuid NOT NULL,
  agent_member_id uuid NOT NULL,
  channel_id      uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at      timestamptz NOT NULL,
  used_at         timestamptz,
  attachment_id   uuid,
  PRIMARY KEY (workspace_id, token_hash),
  CONSTRAINT agent_upload_token_hash_ck CHECK (octet_length(token_hash) = 32),
  CONSTRAINT agent_upload_token_ttl_ck CHECK (expires_at > created_at AND expires_at <= created_at + interval '10 minutes'),
  CONSTRAINT agent_upload_token_used_ck CHECK (used_at IS NULL OR used_at >= created_at),
  CONSTRAINT agent_upload_token_attachment_ck CHECK (attachment_id IS NULL OR used_at IS NOT NULL)
);

COMMENT ON TABLE agent_upload_token IS
  '#6013: one short-lived, single-use address through which an Agent Port agent uploads ONE re-encoded picture for its own message in one approved channel. Holds the SHA-256 of the token only. No foreign key in either direction on purpose (it is also the source of the per-agent counts, and a cascade runs as the table owner). momo_app alone holds privileges on it.';

-- 에이전트별 셈(하루 발급 · 살아 있는 토큰 · 묶이지 않은 그림)과 청소용.
CREATE INDEX agent_upload_token_agent_idx ON agent_upload_token (workspace_id, agent_member_id, created_at);
-- 묶기 판정(이 id 가 이 길의 토큰 행에 기록돼 있는가)용.
CREATE INDEX agent_upload_token_attachment_idx ON agent_upload_token (workspace_id, attachment_id)
  WHERE attachment_id IS NOT NULL;

-- 한 번만: used_at 이 비어 있다가 값이 생기는 UPDATE 하나, 그 뒤 attachment_id 가 비어 있다가 값이 생기는 UPDATE 하나.
CREATE FUNCTION agent_upload_token_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.used_at IS NULL THEN
    IF NEW.used_at IS NULL
       OR (to_jsonb(NEW) - 'used_at') IS DISTINCT FROM (to_jsonb(OLD) - 'used_at') THEN
      RAISE EXCEPTION 'agent_upload_token is single-use and otherwise immutable' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF OLD.attachment_id IS NOT NULL
       OR NEW.attachment_id IS NULL
       OR (to_jsonb(NEW) - 'attachment_id') IS DISTINCT FROM (to_jsonb(OLD) - 'attachment_id') THEN
      RAISE EXCEPTION 'agent_upload_token records its attachment once and is otherwise immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER agent_upload_token_guard BEFORE UPDATE ON agent_upload_token
  FOR EACH ROW EXECUTE FUNCTION agent_upload_token_guard();

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['agent_upload_token'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY ws_isolation ON %I USING (workspace_id = current_setting(''app.workspace_id'',true)::uuid) WITH CHECK (workspace_id = current_setting(''app.workspace_id'',true)::uuid)',t);
  END LOOP;
END $$;

-- 이 길의 그림은 run 이 없다(P7): 하루 셈의 원본을 두 길이 같이 쓴다. 권한 · 트리거 · 외래 키 없음은 그대로다.
ALTER TABLE agent_picture_mark ALTER COLUMN run_id DROP NOT NULL;

-- BEGIN agent-upload-token-lockdown (#6013; ADR-0151 증보 10 P2, PA13). Identical in 189_agent_upload_token.sql,
-- bootstrap_roles.sql and bootstrap_runtime_roles.sql; tests compare the text between the markers. A row of this
-- table lets whoever presents the token upload one re-encoded picture as an Agent Port agent into one approved
-- channel, and it is also the source of that agent's daily issue count, live-token count and unlinked-picture
-- count, and the BYPASSRLS roles skip RLS, so their table privileges are what keeps a forged or deleted row away
-- from a role with no business touching one. Only the api uses this table: momo_app issues (INSERT), counts and
-- reads (SELECT), spends a token and records the attachment it made (UPDATE) and sweeps the rows a day past their
-- expiry (DELETE). Nobody else holds anything — not the worker (unlike attachment_write_token, this path's tokens
-- are never minted by the worker), relay, notifier, platform_admin, nor the two roles the worker may SET ROLE to
-- (the helper's read role and momo_memory; named because a membership granted WITH INHERIT FALSE is invisible to
-- has_table_privilege('momo_worker', ...)). The table has no foreign key in either direction on purpose (a cascade
-- runs as the table's owner). Idempotent and order-proof (a pass before the table or the roles exist finishes what
-- it can, the pass after lands the rest), and it fails loudly if the result is not what is written here.
DO $$
DECLARE
  r text;
  p text;
  allowed text[];
BEGIN
  IF to_regclass('public.agent_upload_token') IS NULL THEN
    RETURN;
  END IF;
  REVOKE ALL ON TABLE public.agent_upload_token FROM PUBLIC;
  FOREACH r IN ARRAY ARRAY['momo_app', 'momo_relay', 'momo_worker', 'momo_notifier', 'momo_platform_admin', 'momo_helper_read', 'momo_memory'] LOOP
    CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r);
    allowed := CASE r
      WHEN 'momo_app' THEN ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']
      ELSE ARRAY[]::text[]
    END;
    EXECUTE format('REVOKE ALL ON TABLE public.agent_upload_token FROM %I', r);
    IF cardinality(allowed) > 0 THEN
      EXECUTE format('GRANT %s ON TABLE public.agent_upload_token TO %I', array_to_string(allowed, ', '), r);
    END IF;
    FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
      IF has_table_privilege(r, 'public.agent_upload_token', p) IS DISTINCT FROM (p = ANY (allowed)) THEN
        RAISE EXCEPTION 'role % must % % on agent_upload_token',
          r, CASE WHEN p = ANY (allowed) THEN 'hold' ELSE 'not hold' END, p;
      END IF;
    END LOOP;
  END LOOP;
END $$;
-- END agent-upload-token-lockdown

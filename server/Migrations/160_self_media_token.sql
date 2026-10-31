-- =============================================================================
-- 160_self_media_token.sql — #4820 C2a (ADR-0218 증보 G4·G8, ADR-0203 증보 I2·I4)
--
-- 왜
--   owner 10-30 결정 ①: 공동 호스팅 Hermes의 그림 도구가 요청자가 올린 원본 사진을 바탕으로 편집한다.
--   그림 도구는 원본을 주소(image_url)로만 읽으므로, oort 서버가 그 첨부 한 장을 가리키는 **짧게 사는
--   자기 주소**를 요청 맥락에 실어 준다. 주소의 뒷면이 이 표다: 토큰 하나 = 첨부 하나.
--
-- 무엇
--   self_media_token  토큰의 해시(32바이트 SHA-256)만 담는다. 토큰 원문은 어떤 열에도 없다: 이 표를 읽을 수
--                     있는 역할(momo_app·momo_worker)이나 백업을 본 사람도 주소를 만들 수 없다.
--                     워크스페이스·런·에이전트·요청자·대화·첨부에 묶인다(자기 주소를 풀 때 같은 묶음을 다시 재판정).
--
-- 규칙을 DB가 쥐는 곳(앱 코드가 틀려도 지켜지는 것)
--   * 토큰 해시는 정확히 32바이트다.
--   * 수명은 0 < ttl ≤ 10분이다(앱의 값은 5분, 표의 천장은 10분).
--   * 한 번만 쓴다: UPDATE는 used_at 이 NULL → 시각으로 가는 것 하나만 통과한다. 다시 NULL 로 되돌리거나
--     묶음(런·첨부·요청자 …)을 고치는 UPDATE 는 트리거가 거절한다.
--
-- RLS
--   158 과 같은 방식: ENABLE + FORCE + ws_isolation(USING·WITH CHECK 모두 app.workspace_id). 풀기(소비)는 비우회
--   역할 momo_app 이 경로의 워크스페이스로 묶은 tx 에서 하고, 만들기는 agent-worker 가 momo_worker 로 tenant tx 에서
--   한다. 신규 테넌트 표라서 아래 DO 블록의 목록(158 의 「정책 대상 목록」과 같은 모양)에 넣었다.
--
-- 표 권한 (보안 검수 L6)
--   BYPASSRLS 역할(relay·worker·notifier)은 RLS 를 건너뛰므로 표 권한이 마지막 문이다. 해시만 담아 「읽어도 주소를
--   만들 수 없다」는 읽기만 막는다: 쓰기가 열려 있으면 DB 만 뚫린 역할이 임의의 (런·요청자·첨부) 행을 직접 넣어
--   api 의 Drive 자격으로 그 이미지를 읽게 할 수 있다(진행 중인 런이 있어야 하지만 첨부는 고를 수 있다). 그래서
--   아래 self-media-token-lockdown 블록이 역할마다 흐름이 쓰는 권한만 남긴다:
--     momo_worker    SELECT·INSERT·DELETE  만들기(INSERT … RETURNING)와 하루 지난 행 청소(DELETE … WHERE)
--     momo_app       SELECT·UPDATE         풀기(UPDATE … RETURNING). 만들거나 지우지 않는다
--     relay·notifier·platform_admin  없음
--   블록은 이 파일·bootstrap_roles.sql·bootstrap_runtime_roles.sql 에 같은 글자로 있다(두 bootstrap 파일은 마이그레이션
--   뒤에 ALL TABLES 권한을 다시 주므로, 이 파일에서만 거두면 다음 bootstrap 이 되돌린다).
--
-- 청소
--   만들 때마다 같은 워크스페이스의 하루 지난 행을 지운다(앱 코드, 새 notifier 스윕 없음). 행이 하루는 남아
--   「어느 런이 어느 첨부를 언제 풀었나」를 보여 준다(감사 행을 따로 만들지 않는다: 이 표가 기록이다).
-- =============================================================================

CREATE TABLE self_media_token (
  workspace_id        uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  token_hash          bytea NOT NULL,
  run_id              uuid NOT NULL REFERENCES agent_run(id) ON DELETE CASCADE,
  agent_member_id     uuid NOT NULL,
  requester_member_id uuid NOT NULL,
  channel_id          uuid NOT NULL,
  attachment_id       uuid NOT NULL REFERENCES attachment(id) ON DELETE CASCADE,
  created_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at          timestamptz NOT NULL,
  used_at             timestamptz,
  PRIMARY KEY (workspace_id, token_hash),
  CONSTRAINT self_media_token_hash_ck CHECK (octet_length(token_hash) = 32),
  CONSTRAINT self_media_token_ttl_ck CHECK (expires_at > created_at AND expires_at <= created_at + interval '10 minutes'),
  CONSTRAINT self_media_token_used_ck CHECK (used_at IS NULL OR used_at >= created_at)
);

COMMENT ON TABLE self_media_token IS
  '#4820 C2a: one short-lived, single-use address of ONE requester attachment for the co-hosted Hermes picture tool. Holds the SHA-256 of the token only; the token itself is never stored.';

-- 청소(만들 때 하루 지난 행 삭제)와 남은 행 훑기용.
CREATE INDEX self_media_token_expiry_idx ON self_media_token (workspace_id, expires_at);

-- 한 번만: used_at 이 비어 있다가 값이 생기는 UPDATE 하나만 허용한다.
CREATE FUNCTION self_media_token_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.used_at IS NOT NULL
     OR NEW.used_at IS NULL
     OR (to_jsonb(NEW) - 'used_at') IS DISTINCT FROM (to_jsonb(OLD) - 'used_at') THEN
    RAISE EXCEPTION 'self_media_token is single-use and otherwise immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER self_media_token_guard BEFORE UPDATE ON self_media_token
  FOR EACH ROW EXECUTE FUNCTION self_media_token_guard();

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['self_media_token'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY ws_isolation ON %I USING (workspace_id = current_setting(''app.workspace_id'',true)::uuid) WITH CHECK (workspace_id = current_setting(''app.workspace_id'',true)::uuid)',t);
  END LOOP;
END $$;

-- BEGIN self-media-token-lockdown (#4820 C2a security review L6; ADR-0218 G4). Identical in
-- 160_self_media_token.sql, bootstrap_roles.sql and bootstrap_runtime_roles.sql; tests compare the text
-- between the markers. A row of this table opens one requester's attachment to whoever presents the
-- token, and the BYPASSRLS roles skip RLS, so their table privileges are what keeps a forged row (any
-- run, requester and attachment) away from a role with no business writing one. Each runtime role gets
-- exactly what the flow uses: momo_worker mints (INSERT) and sweeps day-old rows (DELETE) and reads what
-- it writes (SELECT); momo_app spends a token (UPDATE ... RETURNING, so SELECT too) and never creates or
-- deletes one; relay, notifier and platform_admin do not touch it at all. A foreign-key cascade (attachment,
-- run, workspace) runs as the table's owner, so deleting a parent still clears its rows. Idempotent and
-- order-proof (a pass before the table or the roles exist finishes what it can, the pass after lands the
-- rest), and it fails loudly if the result is not what is written here.
DO $$
DECLARE
  r text;
  p text;
  allowed text[];
BEGIN
  IF to_regclass('public.self_media_token') IS NULL THEN
    RETURN;
  END IF;
  REVOKE ALL ON TABLE public.self_media_token FROM PUBLIC;
  FOREACH r IN ARRAY ARRAY['momo_app', 'momo_relay', 'momo_worker', 'momo_notifier', 'momo_platform_admin'] LOOP
    CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r);
    allowed := CASE r
      WHEN 'momo_app' THEN ARRAY['SELECT', 'UPDATE']
      WHEN 'momo_worker' THEN ARRAY['SELECT', 'INSERT', 'DELETE']
      ELSE ARRAY[]::text[]
    END;
    EXECUTE format('REVOKE ALL ON TABLE public.self_media_token FROM %I', r);
    IF cardinality(allowed) > 0 THEN
      EXECUTE format('GRANT %s ON TABLE public.self_media_token TO %I', array_to_string(allowed, ', '), r);
    END IF;
    FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
      IF has_table_privilege(r, 'public.self_media_token', p) IS DISTINCT FROM (p = ANY (allowed)) THEN
        RAISE EXCEPTION 'role % must % % on self_media_token',
          r, CASE WHEN p = ANY (allowed) THEN 'hold' ELSE 'not hold' END, p;
      END IF;
    END LOOP;
  END LOOP;
END $$;
-- END self-media-token-lockdown

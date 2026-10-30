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
--                     있는 BYPASSRLS 역할(worker·relay·notifier)이나 백업을 본 사람도 주소를 만들 수 없다.
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
--   역할 momo_app 이 경로의 워크스페이스로 묶은 tx 에서 하고, 만들기는 agent-worker 가 tenant tx 에서 한다.
--   신규 테넌트 표라서 아래 DO 블록의 목록(158 의 「정책 대상 목록」과 같은 모양)에 넣었다.
--   BYPASSRLS 역할의 표 권한을 봉인하지 않는다(145·cloud-box 의 lockdown 블록은 세 파일을 맞춰야 하고, worker 는
--   이 표에 INSERT 해야 한다). 대신 해시만 담아 읽어도 쓸 수 없게 했다.
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
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_app') THEN
      EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO momo_app',t);
    END IF;
  END LOOP;
END $$;

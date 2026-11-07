-- =============================================================================
-- 175_attachment_write_token.sql — #5371 (ADR-0151 증보 8: 워커의 첨부 쓰기, W1·W3·W9)
--
-- 왜
--   도우미가 팀 Hermes에 맡긴 그림은 최종 답에 data 주소로 오고, 지금 워커는 그것을 문장 하나로 바꾼다.
--   Railway에서 워커는 api의 보관소(local 볼륨·Google SA 키)에 쓸 수 없으므로, 그림을 첨부로 올리려면
--   **워커가 api의 사설 주소에 바이트를 한 번 PUT**해야 한다. 그 주소의 뒷면이 이 표다: 토큰 하나 = 그림 한 장.
--   160 의 self_media_token(읽기: 첨부가 이미 있다)의 거울이지만 표를 같이 쓰지 않는다 — 쓰기에는 첨부가
--   아직 없고(attachment_id NOT NULL FK 를 쓸 수 없다), 방향 술어를 한 곳이라도 빠뜨리면 읽기 토큰이 쓰기에
--   (또는 반대로) 통하기 때문이다(증보 8 「비교한 방식」 (c)).
--
-- 무엇
--   attachment_write_token  토큰의 해시(32바이트 SHA-256)만 담는다. 토큰 원문은 어떤 열에도 없다.
--                           워크스페이스·run·에이전트·슬롯에 묶인다. 요청자와 채널 열은 **일부러 없다**:
--                           풀 때 run 에서 도출한다(160 은 행에 적힌 값을 썼다). 열이 없으면 위조할 것도 없다.
--                           slot 은 한 run 이 쓸 수 있는 그림의 순번이다. UNIQUE (workspace, run, slot) 이라
--                           한 슬롯은 한 번만 발급된다(쓰이지 않고 만료돼도 되살리지 않는다: 한 번만 시도한다).
--                           표의 CHECK 는 4 까지 열어 두고, v1 의 상한(1)은 코드 상수다.
--                           attachment_id 는 api 가 행을 쓴 tx 가 **한 번** 적는 「이 run 이 만든 첨부」다.
--                           묶기(link)가 호출자가 정한 id 가 아니라 이 run 의 기록만 쓰게 하려는 것이다
--                           (검수 L2). 참조 열이 아니라서 FK 를 두지 않는다 — 증보 2 D4 의 「첨부 id 를 가리키는
--                           곳 전수」와 점검 SQL 4절을 늘리지 않는다.
--
-- 규칙을 DB가 쥐는 곳(앱 코드가 틀려도 지켜지는 것)
--   * 토큰 해시는 정확히 32바이트다. 슬롯은 1~4. 수명은 0 < ttl ≤ 10분이다(앱의 값은 60초).
--   * 한 번만 쓴다: UPDATE 는 used_at 이 NULL → 시각으로 가는 것 하나, 그리고 used_at 이 선 뒤 attachment_id
--     가 NULL → 값으로 가는 것 하나만 통과한다. 되돌리거나 다른 열을 고치는 UPDATE 는 트리거가 거절한다.
--   * attachment_id 는 used_at 이 선 뒤에만 있을 수 있다.
--
-- RLS
--   160 과 같은 방식: ENABLE + FORCE + ws_isolation. 풀기(소비)는 비우회 역할 momo_app 이 경로의 워크스페이스로
--   묶은 tx 에서 하고, 만들기는 agent-worker 가 momo_worker 로 tenant tx 에서 한다.
--
-- 표 권한 (증보 8 검수 M2)
--   BYPASSRLS 역할(relay·worker·notifier)은 RLS 를 건너뛰므로 표 권한이 마지막 문이다. 아래
--   attachment-write-token-lockdown 블록이 역할마다 흐름이 쓰는 권한만 남긴다:
--     momo_worker    SELECT·INSERT·DELETE  만들기·하루 지난 행 청소·슬롯 계산·run 이 기록한 첨부 id 읽기
--     momo_app       SELECT·UPDATE         풀기(UPDATE … RETURNING)와 만든 첨부 id 기록. 만들거나 지우지 않는다
--     relay·notifier·platform_admin  없음
--   블록은 이 파일·bootstrap_roles.sql·bootstrap_runtime_roles.sql 에 같은 글자로 있다(두 bootstrap 파일은
--   마이그레이션 뒤에 ALL TABLES 권한을 다시 주므로, 이 파일에서만 거두면 다음 bootstrap 이 되돌린다).
--   DB 수준으로 뚫린 워커는 agent_run·message·membership 에도 쓸 수 있어 이 표의 권한만으로 범위가 닫히지
--   않는다 — 그래서 api 가 행을 쓰는 tx 에서 워크스페이스별 일일 상한을 스스로 센다(증보 8 W12). 그 상한은
--   attachment 행을 세므로 그 표를 고칠 수 있는 워커의 숫자는 되돌릴 수 있다(T2, 구현 검수 M-1 (b)).
--
-- 청소
--   만들 때마다 같은 워크스페이스의 하루 지난 행을 지운다(앱 코드, 새 notifier 스윕 없음).
-- =============================================================================

CREATE TABLE attachment_write_token (
  workspace_id    uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  token_hash      bytea NOT NULL,
  run_id          uuid NOT NULL REFERENCES agent_run(id) ON DELETE CASCADE,
  agent_member_id uuid NOT NULL,
  slot            smallint NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at      timestamptz NOT NULL,
  used_at         timestamptz,
  attachment_id   uuid,
  PRIMARY KEY (workspace_id, token_hash),
  CONSTRAINT attachment_write_token_run_slot_uniq UNIQUE (workspace_id, run_id, slot),
  CONSTRAINT attachment_write_token_hash_ck CHECK (octet_length(token_hash) = 32),
  CONSTRAINT attachment_write_token_slot_ck CHECK (slot BETWEEN 1 AND 4),
  CONSTRAINT attachment_write_token_ttl_ck CHECK (expires_at > created_at AND expires_at <= created_at + interval '10 minutes'),
  CONSTRAINT attachment_write_token_used_ck CHECK (used_at IS NULL OR used_at >= created_at),
  CONSTRAINT attachment_write_token_attachment_ck CHECK (attachment_id IS NULL OR used_at IS NOT NULL)
);

COMMENT ON TABLE attachment_write_token IS
  '#5371: one short-lived, single-use address through which the agent-worker writes ONE picture into an in-flight run''s conversation as that run''s agent. Holds the SHA-256 of the token only. Requester and channel are derived from the run when the token is spent, never stored.';

-- 청소(만들 때 하루 지난 행 삭제)와 남은 행 훑기용.
CREATE INDEX attachment_write_token_expiry_idx ON attachment_write_token (workspace_id, expires_at);

-- 한 번만: used_at 이 비어 있다가 값이 생기는 UPDATE 하나, 그 뒤 attachment_id 가 비어 있다가 값이 생기는 UPDATE 하나.
CREATE FUNCTION attachment_write_token_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.used_at IS NULL THEN
    IF NEW.used_at IS NULL
       OR (to_jsonb(NEW) - 'used_at') IS DISTINCT FROM (to_jsonb(OLD) - 'used_at') THEN
      RAISE EXCEPTION 'attachment_write_token is single-use and otherwise immutable' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF OLD.attachment_id IS NOT NULL
       OR NEW.attachment_id IS NULL
       OR (to_jsonb(NEW) - 'attachment_id') IS DISTINCT FROM (to_jsonb(OLD) - 'attachment_id') THEN
      RAISE EXCEPTION 'attachment_write_token records its attachment once and is otherwise immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER attachment_write_token_guard BEFORE UPDATE ON attachment_write_token
  FOR EACH ROW EXECUTE FUNCTION attachment_write_token_guard();

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['attachment_write_token'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY ws_isolation ON %I USING (workspace_id = current_setting(''app.workspace_id'',true)::uuid) WITH CHECK (workspace_id = current_setting(''app.workspace_id'',true)::uuid)',t);
  END LOOP;
END $$;

-- BEGIN attachment-write-token-lockdown (#5371; ADR-0151 증보 8 W1, security review M2). Identical in
-- 175_attachment_write_token.sql, bootstrap_roles.sql and bootstrap_runtime_roles.sql; tests compare the
-- text between the markers. A row of this table lets whoever presents the token write one re-encoded
-- picture into an in-flight run's conversation as that run's agent, and the BYPASSRLS roles skip RLS, so
-- their table privileges are what keeps a forged row away from a role with no business writing one. Each
-- runtime role gets exactly what the flow uses: momo_worker mints (INSERT), sweeps day-old rows (DELETE)
-- and reads what it writes and the attachment ids a run recorded (SELECT); momo_app spends a token and
-- records the attachment it made (UPDATE ... RETURNING, so SELECT too) and never creates or deletes one;
-- relay, notifier and platform_admin do not touch it at all. A foreign-key cascade (run, workspace) runs
-- as the table's owner, so deleting a parent still clears its rows. Idempotent and order-proof (a pass
-- before the table or the roles exist finishes what it can, the pass after lands the rest), and it fails
-- loudly if the result is not what is written here.
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
      WHEN 'momo_app' THEN ARRAY['SELECT', 'UPDATE']
      WHEN 'momo_worker' THEN ARRAY['SELECT', 'INSERT', 'DELETE']
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

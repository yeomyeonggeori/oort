-- =============================================================================
-- 173_attachment_media.sql — #4673 C5 (ADR-0151 증보 5 D5, Accepted 2026-11-02)
--
-- 왜
--   영상 첨부의 길이·가로세로·포스터(대표 이미지)를 보내는 기기가 재서 올리면, 받는 쪽은 영상을 열기 전에
--   카드의 비율과 첫 화면을 그린다. 서버는 영상을 디코드하지도 변환하지도 않는다(메타는 선언값의 범위만 보고,
--   포스터 그림은 헤더만 읽는다). 포스터를 둘째 첨부 행으로 두면 「묶이지 않은 초안은 업로더만 읽고 30일 뒤
--   청소된다」는 규칙(증보 1·2)에 걸려 다른 멤버에게 안 보이거나 지워지므로 PG에 둔다.
--
-- 무엇
--   attachment_media  첨부 한 개에 1:1. 영상 첨부에만 생긴다(그 규칙은 앱이 PUT 때 지킨다).
--                     duration_ms / width / height  선언값. 범위만 DB가 쥔다.
--                     poster_*                      없을 수 있다(길이만 재고 첫 화면은 못 뽑은 기기). 네 열이
--                                                   모두 있거나 모두 없다(attachment_media_poster_ck).
--
-- 규칙을 DB가 쥐는 곳(앱 코드가 틀려도 지켜지는 것)
--   * 길이는 1 ms ~ 24시간, 가로세로는 1~16,384, 포스터 가로세로는 1~1,280, 포스터는 jpeg 또는 webp이고
--     1 B ~ 256 KiB.
--   * 복합 외래 키 (workspace_id, attachment_id) → attachment(workspace_id, id) ON DELETE CASCADE: 다른
--     워크스페이스의 첨부를 가리키는 행은 만들 수 없고(RLS의 WITH CHECK는 workspace_id 열만 본다), 첨부 행이
--     지워지면(회수 청소기·채널·워크스페이스 삭제) 이 행도 함께 사라진다. 이 FK는 점검 SQL 4절의 「알려진 FK」에
--     더했다(ADR-0151 증보 2 참조 전수 표 A6).
--
-- RLS
--   160과 같은 방식: ENABLE + FORCE + ws_isolation(USING·WITH CHECK 모두 app.workspace_id). 새 테넌트 표다.
--
-- 표 권한 (코드가 읽고 쓰는 최소만)
--   포스터는 사용자 영상의 한 장면이라 파일 내용처럼 다룬다. BYPASSRLS 역할(relay·worker·notifier)은 RLS를
--   건너뛰므로 표 권한이 마지막 문이다. 아래 attachment-media-lockdown 블록이 역할마다 흐름이 쓰는 권한만
--   남긴다:
--     momo_app          SELECT·INSERT·UPDATE   api. 쓰기(PUT …/media, 멱등 교체 = UPSERT), 포스터 읽기,
--                                              메시지 투영의 LEFT JOIN. DELETE는 없다(FK CASCADE가 지운다)
--     momo_helper_read  SELECT(포스터 바이트 열만 빼고)  도우미 읽기 도구(read_channel·read_thread)가 메시지 쪽을
--                                              읽는 문장이 투영에 이 표를 LEFT JOIN한다. 그 문장은 포스터
--                                              바이트를 고르지 않으므로 그 열은 주지 않는다
--     relay·worker·notifier·platform_admin  없음
--   블록은 이 파일·bootstrap_roles.sql·bootstrap_runtime_roles.sql에 같은 글자로 있다(두 bootstrap 파일은
--   마이그레이션 뒤에 ALL TABLES 권한을 다시 주므로, 이 파일에서만 거두면 다음 bootstrap이 되돌린다).
--
-- schema_v0.sql 은 건드리지 않는다. 다시 적용해도 무해하다.
-- =============================================================================

CREATE TABLE IF NOT EXISTS attachment_media (
  workspace_id   uuid        NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  attachment_id  uuid        NOT NULL,
  duration_ms    integer     NOT NULL,
  width          integer     NOT NULL,
  height         integer     NOT NULL,
  poster_mime    text,
  poster_width   integer,
  poster_height  integer,
  poster_bytes   bytea,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, attachment_id),
  CONSTRAINT attachment_media_attachment_fkey FOREIGN KEY (workspace_id, attachment_id)
    REFERENCES attachment (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT attachment_media_duration_ck CHECK (duration_ms BETWEEN 1 AND 86400000),
  CONSTRAINT attachment_media_dimensions_ck CHECK (width BETWEEN 1 AND 16384 AND height BETWEEN 1 AND 16384),
  CONSTRAINT attachment_media_poster_ck CHECK (
    (poster_mime IS NULL AND poster_width IS NULL AND poster_height IS NULL AND poster_bytes IS NULL)
    OR (poster_mime IN ('image/jpeg', 'image/webp')
        AND poster_width BETWEEN 1 AND 1280
        AND poster_height BETWEEN 1 AND 1280
        AND octet_length(poster_bytes) BETWEEN 1 AND 262144)
  )
);

COMMENT ON TABLE attachment_media IS
  'ADR-0151 증보 5 D5 (#4673): video length, size and poster of ONE attachment (1:1, composite FK, CASCADE). The '
  'server never decodes the video: duration/width/height are the sender''s declaration checked for range only, the '
  'poster is an image whose bytes were checked by magic number and header size. poster_* are all set or all null. '
  'The poster bytes are in no projection, frame or outbox payload; they are read by GET .../poster only. '
  'Privileges are exactly what the code uses (attachment-media-lockdown): momo_app SELECT, INSERT, UPDATE; '
  'momo_helper_read SELECT of every column but poster_bytes; no other role, no DELETE for anyone.';

ALTER TABLE attachment_media ENABLE ROW LEVEL SECURITY;
ALTER TABLE attachment_media FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ws_isolation ON attachment_media;
CREATE POLICY ws_isolation ON attachment_media
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

-- BEGIN attachment-media-lockdown (#4673 C5; ADR-0151 증보 5 D5). Identical in
-- 173_attachment_media.sql, bootstrap_roles.sql and bootstrap_runtime_roles.sql; tests compare the text
-- between the markers. The poster is one frame of a member's video and the BYPASSRLS roles skip RLS, so their
-- table privileges are what keeps every tenant's frames away from a role with no business reading them. Each
-- runtime role gets exactly what the code uses: momo_app writes the row (INSERT, and UPDATE for the idempotent
-- replace) and reads it (SELECT: the poster route and the projection's LEFT JOIN); momo_helper_read, the
-- role the team AI's read tools run as, reads every column but the poster bytes (the page statements it
-- runs join this table for the media summary and never select the bytes); nobody deletes a row (a foreign-key
-- cascade from the attachment, channel or workspace runs as the table's owner, so deleting a parent still
-- clears its rows); relay, worker, notifier and platform_admin do not touch it at all. Idempotent and
-- order-proof (a pass before the table or the roles exist finishes what it can, the pass after lands the
-- rest), and it fails loudly if the result is not what is written here.
DO $$
DECLARE
  r text;
  p text;
  c text;
  allowed text[];
BEGIN
  IF to_regclass('public.attachment_media') IS NULL THEN
    RETURN;
  END IF;
  REVOKE ALL ON TABLE public.attachment_media FROM PUBLIC;
  FOREACH r IN ARRAY ARRAY['momo_app', 'momo_relay', 'momo_worker', 'momo_notifier', 'momo_platform_admin', 'momo_helper_read'] LOOP
    CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r);
    allowed := CASE r
      WHEN 'momo_app' THEN ARRAY['SELECT', 'INSERT', 'UPDATE']
      ELSE ARRAY[]::text[]
    END;
    EXECUTE format('REVOKE ALL ON TABLE public.attachment_media FROM %I', r);
    IF cardinality(allowed) > 0 THEN
      EXECUTE format('GRANT %s ON TABLE public.attachment_media TO %I', array_to_string(allowed, ', '), r);
    END IF;
    IF r = 'momo_helper_read' THEN
      EXECUTE format(
        'GRANT SELECT (workspace_id, attachment_id, duration_ms, width, height, poster_mime, poster_width, poster_height, created_at) ON TABLE public.attachment_media TO %I',
        r);
    END IF;
    FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
      IF has_table_privilege(r, 'public.attachment_media', p) IS DISTINCT FROM (p = ANY (allowed)) THEN
        RAISE EXCEPTION 'role % must % % on attachment_media',
          r, CASE WHEN p = ANY (allowed) THEN 'hold' ELSE 'not hold' END, p;
      END IF;
    END LOOP;
    FOREACH c IN ARRAY ARRAY['workspace_id', 'attachment_id', 'duration_ms', 'width', 'height', 'poster_mime', 'poster_width', 'poster_height', 'poster_bytes', 'created_at'] LOOP
      IF has_column_privilege(r, 'public.attachment_media', c, 'SELECT')
         IS DISTINCT FROM (r = 'momo_app' OR (r = 'momo_helper_read' AND c <> 'poster_bytes')) THEN
        RAISE EXCEPTION 'role % must % SELECT on attachment_media.%',
          r, CASE WHEN r = 'momo_app' OR (r = 'momo_helper_read' AND c <> 'poster_bytes') THEN 'hold' ELSE 'not hold' END, c;
      END IF;
    END LOOP;
  END LOOP;
END $$;
-- END attachment-media-lockdown

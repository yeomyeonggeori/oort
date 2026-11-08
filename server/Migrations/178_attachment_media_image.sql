-- =============================================================================
-- 178_attachment_media_image.sql — #5469 (ADR-0151 증보 9, Proposed 2026-11-07)
--
-- 왜
--   첨부 사진·GIF 의 가로세로를 보내는 기기가 선언해 두면(영상의 길이·가로세로와 같은 길, 같은 PUT …/media),
--   받는 쪽은 그림이 오기 전에 칸의 크기를 안다. 처음 보는 사진도 첫 프레임부터 제 칸에 서서 대화 진입이
--   흔들리지 않는다. 서버는 사진을 열지 않는다(선언값의 범위와 파일의 종류·매직만 본다).
--
-- 무엇
--   attachment_media.duration_ms 의 NOT NULL 을 푼다. **길이가 없는 행 = 정지 그림(사진·GIF)의 가로세로
--   요약**이다. 새 열도 새 표도 새 권한도 없다 — 종류를 따로 적는 열(kind)을 만들지 않은 까닭이다: 새 열은
--   팀 AI 읽기 역할(momo_helper_read)의 열 단위 GRANT SELECT (…) 에 들어가야 해서 attachment-media-lockdown
--   블록(173·bootstrap_roles.sql·bootstrap_runtime_roles.sql 의 같은 글자)과 그 정적 시험을 고치게 된다.
--   투영은 am.duration_ms IS NULL 로 종류를 가른다.
--
-- 규칙을 DB가 쥐는 곳(앱 코드가 틀려도 지켜지는 것)
--   * 길이가 있으면 1 ms ~ 24시간(그대로), 없으면 정지 그림이다.
--   * attachment_media_still_ck: 길이가 없는 행에는 포스터가 없다(정지 그림에는 대표 프레임이 없다).
--     가로세로 범위 CHECK(1~16,384)와 복합 FK·CASCADE·RLS FORCE·ws_isolation 은 173 그대로다.
--
-- 표 권한: 건드리지 않는다(이 파일에는 GRANT·REVOKE 가 없다). 173 의 lockdown 블록이 쥔 권한이 그대로다.
--
-- schema_v0.sql 은 건드리지 않는다. 다시 적용해도 무해하다.
-- =============================================================================

ALTER TABLE attachment_media ALTER COLUMN duration_ms DROP NOT NULL;

-- 길이 범위는 길이가 있을 때만 본다. (CHECK 는 NULL 이면 통과하므로 173 의 식도 같은 뜻이지만, 읽는 사람이
-- 널을 물을 필요가 없게 식에 적는다.)
ALTER TABLE attachment_media DROP CONSTRAINT IF EXISTS attachment_media_duration_ck;
ALTER TABLE attachment_media ADD CONSTRAINT attachment_media_duration_ck
  CHECK (duration_ms IS NULL OR duration_ms BETWEEN 1 AND 86400000);

ALTER TABLE attachment_media DROP CONSTRAINT IF EXISTS attachment_media_still_ck;
ALTER TABLE attachment_media ADD CONSTRAINT attachment_media_still_ck
  CHECK (duration_ms IS NOT NULL OR poster_mime IS NULL);

COMMENT ON TABLE attachment_media IS
  'ADR-0151 증보 5 D5 (#4673) + 증보 9 (#5469): the media summary of ONE attachment (1:1, composite FK, CASCADE). A '
  'row with a duration is a video (length, size, optional poster); a row WITHOUT a duration is a still picture '
  '(photo or GIF: size only, never a poster: attachment_media_still_ck). The server never decodes the file: every '
  'number is the sender''s declaration checked for range only, a poster is an image whose bytes were checked by '
  'magic number and header size, a picture''s file is checked by its first bytes'' magic number. poster_* are all '
  'set or all null. The poster bytes are in no projection, frame or outbox payload; they are read by GET '
  '.../poster only. Privileges are exactly what the code uses (attachment-media-lockdown): momo_app SELECT, '
  'INSERT, UPDATE; momo_helper_read SELECT of every column but poster_bytes; no other role, no DELETE for anyone.';

-- =============================================================================
-- 163_unfurl_site_meta.sql — #4881 (ADR-0170 증보 2026-10-31 D6~D12)
--
-- 왜
--   링크 카드가 화면에 필요한 정보를 더 싣는다: 사이트 이름, 사이트 아이콘, 그림 크기,
--   동영상 표시. 079 의 두 표(`unfurl_url_cache` 24시간 캐시, `message_unfurl` 카드)에
--   같은 열 여섯을 더한다. 새 표는 없다.
--
-- 무엇 (두 표 모두)
--   site_name         text     og:site_name, 정리 뒤 100자 이하
--   icon_proxy_key    text     아이콘 원본 주소의 sha256(`image_proxy_key` 와 같은 모양)
--   icon_source_url   text     아이콘의 **원격** 주소. 서버 프록시만 쓰고 클라이언트에 나가지 않는다
--   image_width       integer  og:image:width, 없으면 프록시가 그림을 받을 때 잰 값
--   image_height      integer  같은 방식. 폭과 높이는 함께 있거나 함께 없다
--   is_video          boolean  og:type `video.*` 또는 twitter:card `player`
--
-- 규칙을 DB가 쥐는 곳(앱 코드가 틀려도 지켜지는 것)
--   * 사이트 이름은 1~100자(`char_length`), 아이콘 주소는 1~2048자(`source_url` 과 같은 상한),
--     아이콘 주소와 키는 함께 있거나 함께 없다.
--   * 그림 크기는 1~16384 의 정수 한 쌍이다. 화면이 칸을 잡는 비율로 쓰는 값이라 0·음수·터무니없는
--     값이 행에 남지 않게 한다.
--   * 기존 행은 모두 NULL(사이트 이름·아이콘·크기) / false(동영상)라 새 제약을 만족한다. 163 이전에
--     저장된 `unfurl_url_cache` 행은 새 필드 없이 24시간 안에 만료된다(다시 가져오지 않는다).
--   * 제약 여섯 개(표마다 셋)는 `NOT VALID` 로 더한다. 아래 「운영 메모(락)」가 이유다. NOT VALID 여도
--     새로 쓰는 행(INSERT·UPDATE)은 검사되므로 위 규칙은 그대로 DB가 쥔다(시험이 두 표 모두에서 재고,
--     `pg_constraint.convalidated` 가 거짓인 것도 단정한다).
--
-- 아이콘 원본 주소의 비노출(ADR-0170 D3·D5, 증보 D9)
--   `icon_source_url` 은 `image_url` 처럼 인증된 프록시만 읽는다. 응답에는 프록시 경로만 나간다.
--   아래 COMMENT 가 그 약속을 열에 적는다.
--
-- RLS
--   기존 표의 열 추가라서 정책·FORCE·권한은 그대로다(079 의 ws_isolation 과 momo_app/momo_relay
--   권한이 새 열에도 걸린다).
--
-- 운영 메모(락): `ALTER TABLE` 은 ACCESS EXCLUSIVE 를 커밋까지 잡는다. 상수 기본값(`false`)을 가진
-- 열 추가는 메타데이터만 바꾼다(PG 11+). CHECK 는 `NOT VALID` 로 더해 기존 행을 훑지 않는다 — 이 열들은
-- 방금 생겨 기존 행이 모두 NULL/false 라 어길 수 없고, 새로 쓰는 행(INSERT·UPDATE)은 NOT VALID 여도
-- 검사된다. 그래서 큰 표에서도 잠금이 메타데이터 변경 길이로 끝난다(162 와 같은 이유. CHECK 를 바로
-- 검증하는 처음 모양은 100만 행 표 두 개에서 문장당 약 0.12초 동안 읽기·쓰기를 모두 막았다: 보안 검수
-- 1회차 Low-1, #4881). `VALIDATE CONSTRAINT` 는 하지 않는다: 검증할 옛 행이 없다.
-- =============================================================================

ALTER TABLE unfurl_url_cache
  ADD COLUMN site_name       text,
  ADD COLUMN icon_proxy_key  text,
  ADD COLUMN icon_source_url text,
  ADD COLUMN image_width     integer,
  ADD COLUMN image_height    integer,
  ADD COLUMN is_video        boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT unfurl_url_cache_site_name_ck
    CHECK (site_name IS NULL OR char_length(site_name) BETWEEN 1 AND 100) NOT VALID,
  ADD CONSTRAINT unfurl_url_cache_icon_ck
    CHECK ((icon_source_url IS NULL) = (icon_proxy_key IS NULL)
           AND (icon_source_url IS NULL OR length(icon_source_url) BETWEEN 1 AND 2048)) NOT VALID,
  ADD CONSTRAINT unfurl_url_cache_image_size_ck
    CHECK ((image_width IS NULL) = (image_height IS NULL)
           AND (image_width IS NULL
                OR (image_width BETWEEN 1 AND 16384 AND image_height BETWEEN 1 AND 16384))) NOT VALID;

ALTER TABLE message_unfurl
  ADD COLUMN site_name       text,
  ADD COLUMN icon_proxy_key  text,
  ADD COLUMN icon_source_url text,
  ADD COLUMN image_width     integer,
  ADD COLUMN image_height    integer,
  ADD COLUMN is_video        boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT message_unfurl_site_name_ck
    CHECK (site_name IS NULL OR char_length(site_name) BETWEEN 1 AND 100) NOT VALID,
  ADD CONSTRAINT message_unfurl_icon_ck
    CHECK ((icon_source_url IS NULL) = (icon_proxy_key IS NULL)
           AND (icon_source_url IS NULL OR length(icon_source_url) BETWEEN 1 AND 2048)) NOT VALID,
  ADD CONSTRAINT message_unfurl_image_size_ck
    CHECK ((image_width IS NULL) = (image_height IS NULL)
           AND (image_width IS NULL
                OR (image_width BETWEEN 1 AND 16384 AND image_height BETWEEN 1 AND 16384))) NOT VALID;

COMMENT ON COLUMN message_unfurl.site_name IS
  'og:site_name, cleaned and capped at 100 characters (ADR-0170 amendment 2026-10-31 D7). Optional.';
COMMENT ON COLUMN message_unfurl.icon_source_url IS
  'Remote site-icon URL consumed only by the authenticated icon proxy (FetchKind::Icon, port 443 only); never returned to clients.';
COMMENT ON COLUMN message_unfurl.icon_proxy_key IS
  'Opaque sha256 of the normalised icon URL. The client fetches the icon through the server proxy path, never the remote host.';
COMMENT ON COLUMN message_unfurl.image_width IS
  'og:image:width of the first og:image, or the width the image proxy measured from the bytes. Set together with image_height; 1..16384.';
COMMENT ON COLUMN message_unfurl.image_height IS
  'Paired with image_width.';
COMMENT ON COLUMN message_unfurl.is_video IS
  'og:type video.* or twitter:card player. Absent in the client payload unless true.';

COMMENT ON COLUMN unfurl_url_cache.site_name IS
  'Cache copy of message_unfurl.site_name.';
COMMENT ON COLUMN unfurl_url_cache.icon_source_url IS
  'Remote site-icon URL consumed only by the authenticated icon proxy; never returned to clients (cache copy of message_unfurl.icon_source_url).';
COMMENT ON COLUMN unfurl_url_cache.icon_proxy_key IS
  'Cache copy of message_unfurl.icon_proxy_key.';
COMMENT ON COLUMN unfurl_url_cache.image_width IS
  'Cache copy of message_unfurl.image_width (declared by the page, or measured by the image proxy).';
COMMENT ON COLUMN unfurl_url_cache.image_height IS
  'Cache copy of message_unfurl.image_height.';
COMMENT ON COLUMN unfurl_url_cache.is_video IS
  'Cache copy of message_unfurl.is_video.';

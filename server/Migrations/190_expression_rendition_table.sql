-- =============================================================================
-- 190_expression_rendition_table.sql — #6071 (ADR-0218 §20 = 증보 14, Z1 · Z2-1 · Z2-6 · ZA4 · ZA7 · ZA10)
--
-- 왜
--   서버가 입력 바이트에서 새로 그리는 이모티콘 그림의 크기 표가 넓어진다: `thumb` 긴 변 256 · 512 KiB,
--   `large` 768 · 2 MiB, 그리고 움직이는 등록에만 새 변형 `still`(첫 장면의 정지 PNG, `large` 와 같은
--   치수 · 2 MiB). `small` 은 128 · 256 KiB 그대로다. 서버가 새 표로 저장하는 것은 운영자가
--   `EXPRESSION_RENDITION_TABLE=768` 로 켠 뒤뿐이고(Z2-7), 이 migration 은 그 행을 **받을 수 있게만** 한다.
--
-- 무엇
--   `expression_image` · `expression_draft_image` 두 표에서 158 이 만든 이름 없는 CHECK 넷(같은 이름이
--   두 표에 복사돼 있다: `expression_image_variant_check` · `expression_image_check`(용량) ·
--   `expression_image_check1`(긴 변) · `expression_image_check2`(모양))을 지우고 이름 있는 넷으로 다시 만든다:
--     - 변형: small · large · thumb · still
--     - 용량(변형마다): small 256 KiB · thumb 512 KiB · large 2 MiB · still 2 MiB
--     - 긴 변(변형마다): small 128 · thumb 256 · large 768 · still 768
--     - 모양: PNG 는 한 장면 · 0 ms. GIF 는 `thumb` 도 `still` 도 아니다(2~100 장면 · 20~10,000 ms 그대로)
--   옛 행(`large` 512 · `thumb` 128 이하 · `still` 없음)은 모두 새 제약의 안쪽이라 그대로 유효하다(ZA7).
--   앱의 인코더가 같은 상한을 지키지만, 이 CHECK 는 앱 검사와 따로 선다(ZA4: 앱 검사를 지워도 넘는 행이
--   들어가지 않는다).
--
-- 바뀌지 않는 것
--   조립 보관 `expression_assembly_image`(159)와 세트 보관 `expression_set_image`(176)는 158 의 제약을
--   `LIKE … INCLUDING CONSTRAINTS` 로 **복사해** 가졌으므로 여기서 건드리지 않는다: 그 두 길은 옛 표 그대로다
--   (Z2-4 · ZA10). 두 표의 같은 이름 제약은 그 표에만 붙어 있어 이 ALTER 가 닿지 않는다.
--   새 열 · 새 표 · 새 권한 · 새 역할은 없다. 158 의 ws_isolation · FORCE · 불변 트리거 · UNIQUE 는 그대로다.
--
-- RLS
--   새 표가 없다. 158 의 정책은 그대로다.
--
-- 되돌림
--   한 방향이다(Z7): `still` 행이나 512 를 넘는 `large` 가 하나라도 생긴 뒤에는 옛 제약으로 좁힐 수 없다.
--   서버 설정을 옛 표로 돌리면 그다음 등록부터 옛 크기로 저장할 뿐이다.
--
-- schema_v0.sql 은 건드리지 않는다. 다시 적용해도 무해하다(같은 이름을 지우고 같은 내용으로 다시 만든다).
-- =============================================================================

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['expression_image', 'expression_draft_image'] LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS expression_image_variant_check', t);
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS expression_image_check', t);
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS expression_image_check1', t);
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS expression_image_check2', t);
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS expression_image_rendition_variant', t);
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS expression_image_rendition_bytes', t);
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS expression_image_rendition_edge', t);
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS expression_image_rendition_shape', t);

    EXECUTE format($sql$ALTER TABLE %I ADD CONSTRAINT expression_image_rendition_variant
      CHECK (variant IN ('small', 'large', 'thumb', 'still'))$sql$, t);
    EXECUTE format($sql$ALTER TABLE %I ADD CONSTRAINT expression_image_rendition_bytes
      CHECK (octet_length(bytes) BETWEEN 1 AND CASE variant
        WHEN 'small' THEN 262144
        WHEN 'thumb' THEN 524288
        WHEN 'large' THEN 2097152
        WHEN 'still' THEN 2097152
      END)$sql$, t);
    EXECUTE format($sql$ALTER TABLE %I ADD CONSTRAINT expression_image_rendition_edge
      CHECK (greatest(width, height) <= CASE variant
        WHEN 'small' THEN 128
        WHEN 'thumb' THEN 256
        WHEN 'large' THEN 768
        WHEN 'still' THEN 768
      END)$sql$, t);
    EXECUTE format($sql$ALTER TABLE %I ADD CONSTRAINT expression_image_rendition_shape
      CHECK ((mime = 'image/png' AND frame_count = 1 AND duration_ms = 0) OR
             (mime = 'image/gif' AND variant IN ('small', 'large')
              AND frame_count BETWEEN 2 AND 100 AND duration_ms BETWEEN 20 AND 10000))$sql$, t);
  END LOOP;
END
$$;

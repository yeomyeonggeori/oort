-- =============================================================================
-- 161_expression_origin_source.sql — #4820 C2b (ADR-0218 증보 G1·G3.8·G7)
--
-- 왜
--   G1: AI가 원본 사진을 바탕으로 만든 표현은 「이 그림은 이 첨부를 바탕으로 만들었다」는 기록 포인터를
--   남긴다. G3.8: 그림을 만들지 못했거나 움직임을 입히지 못한 자리는 `manual_upload_required` + 닫힌 코드로
--   카드에 남는다. 둘 다 158 의 두 표에 열·코드를 더하는 일이다. 새 표는 없다.
--
-- 무엇
--   expression.origin_source_attachment_id        uuid NULL  (INSERT 뒤 불변, 외래키 없음)
--   expression_draft.origin_source_attachment_id  uuid NULL  (같은 열)
--   expression_draft.code                          158 의 여덟 코드 + G3.8 카드 코드 여섯
--
-- 규칙을 DB가 쥐는 곳(앱 코드가 틀려도 지켜지는 것)
--   * 포인터는 `origin.kind = 'generated'` 인 행에만 있을 수 있다(CHECK). 직접 올리기·링크·첨부 출처는
--     기록할 원본이 없고, 웹에서 가져온 그림을 「생성」으로 세탁하는 길도 이 열로 열리지 않는다(D5).
--   * 불변: 158 의 `expression_immutable()` 가 「열 목록 밖의 어떤 열도 바뀌면 거절」이라서, 새 열은 따로
--     손대지 않아도 INSERT 뒤 불변이다(`expression` 은 표시 이름·태그·상태·버전·숨김·삭제 시각만,
--     `expression_draft` 는 revision·state·code·제출·영수증만 바뀐다).
--   * 외래키가 없다: 첨부가 지워져도 표현의 기록은 바뀌지 않는다. 화면은 못 열면 「원본 사진 없음」이라고만
--     말한다. 원본 **바이트**는 어느 표에도 저장하지 않는다.
--
-- RLS
--   기존 표의 열 추가라서 정책·FORCE·권한은 그대로다(158 의 ws_isolation 이 새 열에도 걸린다).
-- =============================================================================

ALTER TABLE expression
  ADD COLUMN origin_source_attachment_id uuid,
  ADD CONSTRAINT expression_origin_source_generated_only
    CHECK (origin_source_attachment_id IS NULL OR origin->>'kind' = 'generated');

ALTER TABLE expression_draft
  ADD COLUMN origin_source_attachment_id uuid,
  ADD CONSTRAINT expression_draft_origin_source_generated_only
    CHECK (origin_source_attachment_id IS NULL OR origin->>'kind' = 'generated');

-- 158 이 열 정의에 인라인으로 둔 CHECK(자동 이름)를 같은 이름으로 다시 만든다. 기존 행은 모두 앞 여덟 코드
-- 또는 NULL 이라 새 제약을 만족한다.
ALTER TABLE expression_draft DROP CONSTRAINT expression_draft_code_check;
ALTER TABLE expression_draft ADD CONSTRAINT expression_draft_code_check CHECK (code IN (
  'source_blocked','source_unavailable','source_too_large','source_unsupported','source_timeout',
  'source_invalid_media','video_processing_unavailable','video_conversion_failed',
  'generation_failed','assembly_source_invalid','assembly_source_too_large',
  'assembly_output_too_large','assembly_timeout','assembly_busy'));

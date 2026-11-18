-- =============================================================================
-- 185_expression_draft_link_awaiting_approval.sql — #5899 (ADR-0170 증보 2026-11-14 의 불변식, ADR-0218 D5)
--
-- 왜
--   에이전트가 `expression.create` 카드에 그림 링크를 후보로 올리면, 그 링크는 사람이 그 후보를 승인한
--   뒤에만 가져온다(「사람이 누르지 않았는데 에이전트가 정한 주소로 서버가 나가는 요청이 없다」).
--   승인 전의 후보는 그림이 없는 `manual_upload_required` 이고, 그 까닭 코드가 하나 더 필요하다:
--   `source_awaiting_approval` (아직 가져오지 않음). 후보에만 쓰고, 사람이 직접 넣는 링크에는 쓰지 않는다.
--
-- 무엇
--   `expression_draft.code` 의 CHECK 목록에 그 코드 하나를 더한다(161 이 만든 같은 이름의 제약을 다시 만든다).
--   새 열·새 표·새 권한은 없다. 158 의 `(state = 'manual_upload_required') = (code IS NOT NULL)` 와
--   불변 트리거(`code` 는 바뀔 수 있는 열)는 그대로다.
--
-- RLS
--   새 표가 없다. 158 의 ws_isolation·FORCE·권한은 그대로다.
--
-- schema_v0.sql 은 건드리지 않는다. 다시 적용해도 무해하다(같은 제약을 지우고 같은 목록으로 다시 만든다).
-- =============================================================================

ALTER TABLE expression_draft DROP CONSTRAINT IF EXISTS expression_draft_code_check;
ALTER TABLE expression_draft ADD CONSTRAINT expression_draft_code_check CHECK (code IN (
  'source_blocked','source_unavailable','source_too_large','source_unsupported','source_timeout',
  'source_invalid_media','video_processing_unavailable','video_conversion_failed',
  'generation_failed','assembly_source_invalid','assembly_source_too_large',
  'assembly_output_too_large','assembly_timeout','assembly_busy',
  'source_awaiting_approval'));

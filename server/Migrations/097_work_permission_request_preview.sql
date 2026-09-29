-- =============================================================================
-- 097_work_permission_request_preview.sql — #3118 (ADR-0146 증보 2026-09-29,
-- R2 H1; ADR-0188 D5 미리보기)
--
-- A permission request's preview — the tool kind, title, locations and input
-- summary the host read from the agent's ACP request — travels with the
-- request, and an owner's allow signs its hash (`momo.human.control.v3`).
-- The host is the source: it relays the closed preview object and its
-- SHA-256; the server stores both here, serves the preview to the session
-- owner only, and rebuilds the allow it verifies with the stored hash. The
-- session thread's broadcast event keeps the hash and drops the preview
-- (D5: 「채널로 방송하지 않는다」).
--
-- Rows recorded before this migration, or relayed by a host that sends no
-- preview, keep both columns NULL; an allow for such a request is a v2
-- statement as before.
--
-- RLS: no table or policy is added; work_permission_request stays under 092's
-- ENABLE + FORCE + ws_isolation. schema_v0.sql is not modified.
-- Re-runnable statements.
-- =============================================================================

ALTER TABLE work_permission_request
  ADD COLUMN IF NOT EXISTS preview jsonb,
  ADD COLUMN IF NOT EXISTS preview_sha256 text;

ALTER TABLE work_permission_request
  DROP CONSTRAINT IF EXISTS work_permission_request_preview_ck;
ALTER TABLE work_permission_request
  ADD CONSTRAINT work_permission_request_preview_ck CHECK (
    (preview IS NULL AND preview_sha256 IS NULL)
    OR (
      preview IS NOT NULL
      AND jsonb_typeof(preview) = 'object'
      -- IS NOT NULL first: `NULL ~ …` is NULL, and a NULL CHECK passes.
      AND preview_sha256 IS NOT NULL
      AND preview_sha256 ~ '^[0-9a-f]{64}$'
    )
  );

COMMENT ON COLUMN work_permission_request.preview IS
  '#3118: the host-built closed preview (momo.work_permission.preview.v1); owner-only.';
COMMENT ON COLUMN work_permission_request.preview_sha256 IS
  '#3118: lowercase hex SHA-256 of the preview''s canonical JSON — the line a v3 allow signs.';

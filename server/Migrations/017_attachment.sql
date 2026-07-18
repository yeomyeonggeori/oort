-- =============================================================================
-- 017_attachment.sql — MOMO-474 / ADR-0113 workspace Drive archive
--
-- Attachment bytes live in the workspace shared drive. PostgreSQL owns the
-- tenant/channel/uploader binding and the pending -> complete -> message link
-- lifecycle; clients never publish attachment state through Centrifugo.
-- =============================================================================

CREATE TABLE attachment (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id        uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  channel_id          uuid NOT NULL REFERENCES channel(id) ON DELETE CASCADE,
  uploader_member_id  uuid NOT NULL REFERENCES member(id),
  message_id          uuid REFERENCES message(id) ON DELETE SET NULL,
  drive_file_id       text,
  name                text NOT NULL,
  mime                text NOT NULL,
  size_bytes          bigint NOT NULL,
  status              text NOT NULL DEFAULT 'pending',
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT attachment_name_ck CHECK (length(btrim(name)) BETWEEN 1 AND 255),
  CONSTRAINT attachment_mime_ck CHECK (length(btrim(mime)) BETWEEN 1 AND 255),
  CONSTRAINT attachment_size_ck CHECK (size_bytes BETWEEN 0 AND 104857600),
  CONSTRAINT attachment_status_ck CHECK (status IN ('pending', 'complete', 'failed')),
  CONSTRAINT attachment_drive_file_ck CHECK (
    (status = 'failed') OR drive_file_id IS NOT NULL
  )
);

CREATE UNIQUE INDEX attachment_drive_file_uniq
  ON attachment (drive_file_id)
  WHERE drive_file_id IS NOT NULL;
CREATE INDEX attachment_message_idx
  ON attachment (workspace_id, message_id)
  WHERE message_id IS NOT NULL;
-- Janitors can scan abandoned upload sessions without touching completed rows.
CREATE INDEX attachment_pending_cleanup_idx
  ON attachment (created_at)
  WHERE status = 'pending' AND message_id IS NULL;

ALTER TABLE attachment ENABLE ROW LEVEL SECURITY;
ALTER TABLE attachment FORCE ROW LEVEL SECURITY;
CREATE POLICY ws_isolation ON attachment
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

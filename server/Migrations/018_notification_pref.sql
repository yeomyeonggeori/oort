-- =============================================================================
-- 018_notification_pref.sql — MOMO-477 / ADR-0124 channel notification mute
--
-- A row suppresses push delivery for one (member, channel) pair. v0 writes
-- muted_until=NULL for indefinite mute; a future timestamp is reserved for a
-- scheduled-mute extension. Unread/read-state remains a separate ledger.
-- =============================================================================

CREATE TABLE notification_pref (
  workspace_id  uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  member_id     uuid NOT NULL REFERENCES member(id) ON DELETE CASCADE,
  channel_id    uuid NOT NULL REFERENCES channel(id) ON DELETE CASCADE,
  muted_until   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, member_id, channel_id)
);

CREATE INDEX notification_pref_channel_idx
  ON notification_pref (workspace_id, channel_id, member_id);

ALTER TABLE notification_pref ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_pref FORCE ROW LEVEL SECURITY;
CREATE POLICY ws_isolation ON notification_pref
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

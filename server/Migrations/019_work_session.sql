-- =============================================================================
-- 019_work_session.sql — MOMO-483 / ADR-0114 D2, D6, D8
--
-- Durable lifecycle only: the channel root message is the session card and its
-- existing thread is the collaboration surface. Host-local cwd/path/process and
-- provider credentials deliberately do not enter this ledger.
-- =============================================================================

CREATE TABLE work_session (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id     uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  channel_id       uuid NOT NULL REFERENCES channel(id) ON DELETE CASCADE,
  member_id        uuid NOT NULL REFERENCES member(id),
  -- Reserved for ADR-0125 work_host. The FK is added only after that ADR lands.
  host_id          uuid NOT NULL,
  root_message_id  uuid NOT NULL UNIQUE REFERENCES message(id) ON DELETE CASCADE,
  tool             text NOT NULL,
  label            text NOT NULL,
  status           text NOT NULL DEFAULT 'running',
  started_at       timestamptz NOT NULL DEFAULT now(),
  ended_at         timestamptz,
  exit_code        int,
  CONSTRAINT work_session_tool_ck
    CHECK (tool IN ('claude', 'codex', 'opencode', 'shell')),
  CONSTRAINT work_session_label_ck
    CHECK (length(btrim(label)) BETWEEN 1 AND 120),
  CONSTRAINT work_session_status_ck
    CHECK (status IN ('running', 'ended')),
  CONSTRAINT work_session_lifecycle_ck CHECK (
    (status = 'running' AND ended_at IS NULL AND exit_code IS NULL)
    OR (status = 'ended' AND ended_at IS NOT NULL)
  ),
  CONSTRAINT work_session_time_ck
    CHECK (ended_at IS NULL OR ended_at >= started_at)
);

CREATE INDEX work_session_workspace_started_idx
  ON work_session (workspace_id, started_at DESC, id DESC);
CREATE INDEX work_session_channel_active_idx
  ON work_session (channel_id, started_at DESC)
  WHERE status = 'running';
CREATE INDEX work_session_member_active_idx
  ON work_session (member_id, started_at DESC)
  WHERE status = 'running';

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['work_session'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', t);
    EXECUTE format($f$
      CREATE POLICY ws_isolation ON %I
      USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
      WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);
    $f$, t);
  END LOOP;
END $$;

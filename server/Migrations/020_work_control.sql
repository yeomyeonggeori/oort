-- =============================================================================
-- 020_work_control.sql — MOMO-484 / ADR-0114 D4, D5
--
-- The server records and delivers host-directed controls; it never stores or
-- proxies host-local paths, environment variables, processes, or credentials.
-- Closed payload shapes below make that boundary a database invariant.
-- =============================================================================

CREATE TABLE work_control (
  id                    uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id          uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  channel_id            uuid NOT NULL REFERENCES channel(id) ON DELETE CASCADE,
  requester_member_id   uuid NOT NULL REFERENCES member(id),
  -- Reserved for ADR-0125 work_host. The FK lands with that host identity.
  target_host_id        uuid NOT NULL,
  -- spawn begins without a session and binds it only after a successful ack.
  session_id            uuid REFERENCES work_session(id),
  kind                  text NOT NULL,
  payload               jsonb NOT NULL DEFAULT '{}'::jsonb,
  status                text NOT NULL DEFAULT 'pending_approval',
  approval_message_id   uuid REFERENCES message(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT work_control_kind_ck
    CHECK (kind IN ('spawn', 'input', 'read', 'kill')),
  CONSTRAINT work_control_status_ck
    CHECK (status IN (
      'pending_approval', 'approved', 'denied', 'dispatched', 'acked', 'failed'
    )),
  CONSTRAINT work_control_session_ck CHECK (
    kind = 'spawn' OR session_id IS NOT NULL
  ),
  CONSTRAINT work_control_payload_ck CHECK (
    jsonb_typeof(payload) = 'object'
    AND CASE kind
      WHEN 'spawn' THEN
        payload ? 'tool'
        AND payload ? 'label'
        AND payload - ARRAY['tool', 'label']::text[] = '{}'::jsonb
        AND jsonb_typeof(payload->'tool') = 'string'
        AND payload->>'tool' IN ('claude', 'codex', 'opencode', 'shell')
        AND jsonb_typeof(payload->'label') = 'string'
        AND length(btrim(payload->>'label')) BETWEEN 1 AND 120
      WHEN 'input' THEN
        payload ? 'text'
        AND payload - ARRAY['text']::text[] = '{}'::jsonb
        AND jsonb_typeof(payload->'text') = 'string'
        AND length(payload->>'text') BETWEEN 1 AND 32768
      WHEN 'read' THEN
        payload - ARRAY['tail_lines']::text[] = '{}'::jsonb
        AND (
          NOT payload ? 'tail_lines'
          OR (
            jsonb_typeof(payload->'tail_lines') = 'number'
            AND payload->>'tail_lines' ~ '^[1-9][0-9]{0,3}$'
          )
        )
      WHEN 'kill' THEN payload = '{}'::jsonb
      ELSE false
    END
  )
);

CREATE INDEX work_control_workspace_created_idx
  ON work_control (workspace_id, created_at DESC, id DESC);
CREATE INDEX work_control_host_pending_idx
  ON work_control (target_host_id, created_at, id)
  WHERE status = 'dispatched';
CREATE INDEX work_control_session_idx
  ON work_control (session_id, created_at, id)
  WHERE session_id IS NOT NULL;
CREATE UNIQUE INDEX work_control_approval_message_uniq
  ON work_control (approval_message_id)
  WHERE approval_message_id IS NOT NULL;

CREATE TABLE work_auto_approve (
  workspace_id          uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  host_owner_member_id  uuid NOT NULL REFERENCES member(id) ON DELETE CASCADE,
  tool                  text NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, host_owner_member_id, tool),
  CONSTRAINT work_auto_approve_tool_ck
    CHECK (tool IN ('claude', 'codex', 'opencode', 'shell'))
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['work_control', 'work_auto_approve'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', t);
    EXECUTE format($f$
      CREATE POLICY ws_isolation ON %I
      USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
      WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);
    $f$, t);
  END LOOP;
END $$;

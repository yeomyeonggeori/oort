-- =============================================================================
-- 070_hosted_agent_inbox.sql — HAP-E4 / ADR-0162 D3,D6
-- Connection-scoped ordering and immutable source references for hosted agents.
-- Message/job bodies and credentials never enter this projection.
-- =============================================================================

ALTER TABLE hosted_agent_connection
  ADD CONSTRAINT hosted_agent_connection_inbox_identity_uniq
  UNIQUE (workspace_id, id, agent_member_id);
CREATE UNIQUE INDEX IF NOT EXISTS outbox_workspace_id_id_uniq
  ON outbox (workspace_id, id);

CREATE TABLE hosted_agent_inbox_counter (
  workspace_id    uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  agent_member_id uuid NOT NULL,
  connection_id   uuid NOT NULL,
  last_seq        bigint NOT NULL DEFAULT 0 CHECK (last_seq >= 0),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, connection_id),
  CONSTRAINT hosted_agent_inbox_counter_connection_fk
    FOREIGN KEY (workspace_id, connection_id, agent_member_id)
    REFERENCES hosted_agent_connection(workspace_id, id, agent_member_id) ON DELETE CASCADE
);

CREATE TABLE hosted_agent_inbox_event (
  workspace_id      uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  agent_member_id   uuid NOT NULL,
  connection_id     uuid NOT NULL,
  inbox_seq         bigint NOT NULL CHECK (inbox_seq > 0),
  event_kind        text NOT NULL CHECK (event_kind IN ('message','agent_job','agent_run')),
  source_message_id uuid,
  source_outbox_id  bigint,
  source_run_id     uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, connection_id, inbox_seq),
  CONSTRAINT hosted_agent_inbox_event_connection_fk
    FOREIGN KEY (workspace_id, connection_id, agent_member_id)
    REFERENCES hosted_agent_connection(workspace_id, id, agent_member_id) ON DELETE CASCADE,
  CONSTRAINT hosted_agent_inbox_event_message_fk
    FOREIGN KEY (workspace_id, source_message_id)
    REFERENCES message(workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT hosted_agent_inbox_event_outbox_fk
    FOREIGN KEY (workspace_id, source_outbox_id)
    REFERENCES outbox(workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT hosted_agent_inbox_event_run_fk
    FOREIGN KEY (workspace_id, source_run_id)
    REFERENCES agent_run(workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT hosted_agent_inbox_event_source_shape_ck CHECK (
    (event_kind = 'message' AND source_message_id IS NOT NULL
      AND source_outbox_id IS NULL AND source_run_id IS NULL)
    OR (event_kind = 'agent_job' AND source_message_id IS NULL
      AND source_outbox_id IS NOT NULL AND source_run_id IS NOT NULL)
    OR (event_kind = 'agent_run' AND source_message_id IS NULL
      AND source_outbox_id IS NULL AND source_run_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX hosted_agent_inbox_event_message_uniq
  ON hosted_agent_inbox_event (workspace_id, connection_id, source_message_id)
  WHERE event_kind = 'message';
CREATE UNIQUE INDEX hosted_agent_inbox_event_job_uniq
  ON hosted_agent_inbox_event (workspace_id, connection_id, source_outbox_id)
  WHERE event_kind = 'agent_job';
CREATE UNIQUE INDEX hosted_agent_inbox_event_run_uniq
  ON hosted_agent_inbox_event (workspace_id, connection_id, source_run_id)
  WHERE event_kind = 'agent_run';
CREATE INDEX hosted_agent_inbox_event_agent_seq_idx
  ON hosted_agent_inbox_event (workspace_id, agent_member_id, connection_id, inbox_seq);

COMMENT ON TABLE hosted_agent_inbox_counter IS
  'ADR-0162 connection-local monotonic cursor counter; never a workspace or channel sequence.';
COMMENT ON TABLE hosted_agent_inbox_event IS
  'Append-only hosted inbox source references. Message/job bodies and secrets are forbidden.';

CREATE FUNCTION hosted_agent_inbox_event_append_only()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' OR pg_trigger_depth() = 1 THEN
    RAISE EXCEPTION 'hosted agent inbox events are append-only';
  END IF;
  RETURN OLD;
END $$;

CREATE TRIGGER hosted_agent_inbox_event_append_only_guard
BEFORE UPDATE OR DELETE ON hosted_agent_inbox_event
FOR EACH ROW EXECUTE FUNCTION hosted_agent_inbox_event_append_only();

ALTER TABLE hosted_agent_inbox_counter ENABLE ROW LEVEL SECURITY;
ALTER TABLE hosted_agent_inbox_counter FORCE ROW LEVEL SECURITY;
CREATE POLICY ws_isolation ON hosted_agent_inbox_counter
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

ALTER TABLE hosted_agent_inbox_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE hosted_agent_inbox_event FORCE ROW LEVEL SECURITY;
CREATE POLICY ws_isolation ON hosted_agent_inbox_event
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['hosted_agent_inbox_counter','hosted_agent_inbox_event'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
       WHERE schemaname = current_schema() AND tablename = t AND policyname = 'ws_isolation'
    ) THEN
      RAISE EXCEPTION 'missing ws_isolation policy on %', t;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = current_schema() AND c.relname = t
         AND c.relrowsecurity AND c.relforcerowsecurity
    ) THEN
      RAISE EXCEPTION 'RLS FORCE missing on %', t;
    END IF;
  END LOOP;
END $$;

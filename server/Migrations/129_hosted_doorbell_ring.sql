-- =============================================================================
-- 129_hosted_doorbell_ring.sql — #3743 S4 / ADR-0200 D4 「다시 깨우기」
--
-- One append-only row per MANUAL doorbell ring a person requested, so the route can
-- enforce its abuse bound (60 s cooldown, 5 per hour per connection) from facts in
-- the database instead of process memory (two api instances, a restart).
--
-- The ring itself writes nothing here but the request: it re-arms the existing
-- doorbell row (`pending_trailing = true`, `window_started_at = NULL`) so the
-- sender's ordinary drain fires the same content-free signal (ADR-0171 D2) through
-- the same egress policy. No new transport, no new payload.
--
-- RLS FORCE like every tenant table; SECURITY INVOKER only (no functions here).
-- =============================================================================

CREATE TABLE hosted_agent_doorbell_ring (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id  uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL,
  requested_by  uuid NOT NULL,
  requested_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, connection_id)
    REFERENCES hosted_agent_connection (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, requested_by)
    REFERENCES member (workspace_id, id)
);

CREATE INDEX hosted_agent_doorbell_ring_window_idx
  ON hosted_agent_doorbell_ring (workspace_id, connection_id, requested_at DESC);

COMMENT ON TABLE hosted_agent_doorbell_ring IS
  'ADR-0200 D4: manual doorbell ring requests (abuse bound ledger). Rows older than a day are pruned by the ring route.';

ALTER TABLE hosted_agent_doorbell_ring ENABLE ROW LEVEL SECURITY;
ALTER TABLE hosted_agent_doorbell_ring FORCE ROW LEVEL SECURITY;
CREATE POLICY ws_isolation ON hosted_agent_doorbell_ring
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_app') THEN
    GRANT SELECT, INSERT, DELETE ON TABLE hosted_agent_doorbell_ring TO momo_app;
  END IF;
END $$;

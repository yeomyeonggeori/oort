-- =============================================================================
-- 048_work_host_request_replay.sql — MOMO-657 / #875
--
-- Work-host request signatures v2 bind the raw body SHA-256 and a UUID request
-- id. This table is the atomic replay barrier for that id. Rows live for ten
-- minutes, longer than the five-minute signature clock-skew window, and the
-- authenticator removes expired rows before each consume.
--
-- Migration strategy: immediate v2 cutover. Accepting v1 in parallel would keep
-- the body-substitution and replay vulnerability open. Self-host operators must
-- deploy MomoServer and momo-workd as one release unit; either mismatched order
-- fails closed with 401 until both processes are on the same release.
-- =============================================================================

CREATE TABLE work_host_request (
  workspace_id  uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  request_id    uuid NOT NULL,
  host_id       uuid NOT NULL REFERENCES work_host(id) ON DELETE CASCADE,
  consumed_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at    timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, request_id),
  CONSTRAINT work_host_request_retention_ck
    CHECK (expires_at > consumed_at + interval '5 minutes')
);

CREATE INDEX work_host_request_expiry_idx
  ON work_host_request (workspace_id, expires_at);
CREATE INDEX work_host_request_host_idx
  ON work_host_request (host_id, expires_at);

COMMENT ON TABLE work_host_request IS
  'MOMO-657 atomic one-time consumption for signed work-host request UUIDs.';
COMMENT ON COLUMN work_host_request.expires_at IS
  'Ten-minute replay retention; expired rows are pruned by WorkHostAuthenticator.';

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['work_host_request'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', t);
    EXECUTE format($f$
      CREATE POLICY ws_isolation ON %I
      USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
      WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);
    $f$, t);
  END LOOP;
END $$;

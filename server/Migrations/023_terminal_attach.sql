-- =============================================================================
-- 023_terminal_attach.sql — MOMO-511 / ADR-0125 D10
--
-- The durable ledger stores only a remote PTY identifier, its direct endpoint,
-- and SHA-256 capability digests. Terminal bytes and raw capability values are
-- deliberately absent. A validating host must join its live work_host row on
-- every attach, so revocation takes effect immediately.
-- =============================================================================

ALTER TABLE work_session
  ADD COLUMN pty_id text,
  ADD COLUMN attach_endpoint text,
  ADD CONSTRAINT work_session_remote_pty_pair_ck CHECK (
    (pty_id IS NULL AND attach_endpoint IS NULL)
    OR (pty_id IS NOT NULL AND attach_endpoint IS NOT NULL)
  ),
  ADD CONSTRAINT work_session_pty_id_ck CHECK (
    pty_id IS NULL OR pty_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  ADD CONSTRAINT work_session_attach_endpoint_ck CHECK (
    attach_endpoint IS NULL OR length(attach_endpoint) BETWEEN 1 AND 2048
  );

CREATE TABLE terminal_attach_capability (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id     uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  work_session_id  uuid NOT NULL REFERENCES work_session(id) ON DELETE CASCADE,
  host_id          uuid NOT NULL REFERENCES work_host(id),
  owner_member_id  uuid NOT NULL REFERENCES member(id),
  token_hash       bytea NOT NULL UNIQUE,
  issued_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at       timestamptz NOT NULL,
  CONSTRAINT terminal_attach_token_hash_ck CHECK (octet_length(token_hash) = 32),
  CONSTRAINT terminal_attach_expiry_ck CHECK (
    expires_at > issued_at
    AND expires_at <= issued_at + interval '5 minutes'
  )
);

CREATE INDEX terminal_attach_session_expiry_idx
  ON terminal_attach_capability (work_session_id, expires_at DESC);
CREATE INDEX terminal_attach_host_expiry_idx
  ON terminal_attach_capability (host_id, expires_at DESC);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['terminal_attach_capability'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', t);
    EXECUTE format($f$
      CREATE POLICY ws_isolation ON %I
      USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
      WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);
    $f$, t);
  END LOOP;
END $$;

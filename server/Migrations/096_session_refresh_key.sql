-- =============================================================================
-- 096_session_refresh_key.sql — #3079 (ADR-0146 D-7 증보 2026-09-29:
-- refresh-token sender constraint)
--
-- A native client's refresh request carries a proof signed by a key its
-- sign-in lineage is bound to (`momo.human.refresh_proof.v1`, momo-wire).
-- Two halves, one file:
--
--   session_refresh_key
--       At most one public key per session lineage (`token.session_id`,
--       088): the key whose proofs that lineage's refresh tokens need. It is
--       a *separate* Secure Enclave key from the member's control key
--       (`member_device_key`, 094): the phone's control key needs Face ID on
--       every signature (`biometryCurrentSet`, ADR-0146 D-2) and the Mac's
--       needs user presence (D-3), and a refresh runs in the background every
--       15 minutes. The refresh key carries no trust role — it is never a
--       root, never endorsed, never listed, never authorizes an instruction —
--       so it does not live in `member_device_key`, whose rows are all of
--       those things (and whose live-public-key uniqueness and #3097 rebind
--       rule would reach it).
--
--       The binding is first-come on the lineage (the first refresh that
--       carries a proof binds its key) and never changes; a new sign-in is a
--       new lineage and binds again. The row lives exactly as long as the
--       lineage matters: once the lineage cannot rotate the key proves
--       nothing, so no path revokes it and nothing deletes it but the
--       member's own removal (cascade).
--
--   refresh_proof_nonce
--       The server's one-time barrier for proof nonces (095's shape). A row is
--       kept until the proof's time window has closed (`signed_at_ms` + 5 min
--       skew) — until then the window could still accept it; the verify path
--       prunes older rows before it consumes.
--
-- The statements are written to be re-runnable (IF [NOT] EXISTS,
-- DROP-then-ADD) so applying the file twice is a no-op. RLS: both tables are
-- tenant tables — ENABLE + FORCE + ws_isolation. schema_v0.sql is not
-- modified.
-- =============================================================================

CREATE TABLE IF NOT EXISTS session_refresh_key (
  workspace_id  uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  -- token.session_id (088) of the lineage whose refresh tokens need proofs.
  session_id    uuid NOT NULL,
  member_id     uuid NOT NULL,
  alg           text NOT NULL DEFAULT 'p256',
  -- base64 STANDARD of the 33-byte compressed SEC1 point.
  public_key    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, session_id),
  CONSTRAINT session_refresh_key_member_fk
    FOREIGN KEY (workspace_id, member_id) REFERENCES member (workspace_id, id)
    ON DELETE CASCADE,
  CONSTRAINT session_refresh_key_alg_ck CHECK (alg IN ('p256')),
  CONSTRAINT session_refresh_key_public_key_ck CHECK (
    CASE alg
      WHEN 'p256' THEN public_key ~ '^[A-Za-z0-9+/]{44}$'
      ELSE false
    END
  )
);

ALTER TABLE session_refresh_key ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_refresh_key FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ws_isolation ON session_refresh_key;
CREATE POLICY ws_isolation ON session_refresh_key
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

COMMENT ON TABLE session_refresh_key IS
  'ADR-0146 D-7 증보 (#3079): the refresh-proof key a session lineage is bound to. Separate from member_device_key: no biometry, no trust role.';
COMMENT ON COLUMN session_refresh_key.session_id IS
  'token.session_id (088). First proof-carrying refresh of the lineage binds it; never rebound.';

CREATE TABLE IF NOT EXISTS refresh_proof_nonce (
  workspace_id  uuid NOT NULL,
  nonce         uuid NOT NULL,
  session_id    uuid NOT NULL,
  consumed_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at    timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, nonce),
  CONSTRAINT refresh_proof_nonce_key_fk
    FOREIGN KEY (workspace_id, session_id)
    REFERENCES session_refresh_key (workspace_id, session_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS refresh_proof_nonce_expiry_idx
  ON refresh_proof_nonce (workspace_id, expires_at);

ALTER TABLE refresh_proof_nonce ENABLE ROW LEVEL SECURITY;
ALTER TABLE refresh_proof_nonce FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ws_isolation ON refresh_proof_nonce;
CREATE POLICY ws_isolation ON refresh_proof_nonce
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

COMMENT ON TABLE refresh_proof_nonce IS
  'ADR-0146 D-7 증보 (#3079): one-time consumption of momo.human.refresh_proof.v1 nonces, kept until the proof''s time window has closed.';

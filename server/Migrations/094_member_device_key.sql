-- =============================================================================
-- 094_member_device_key.sql — #3022 (ADR-0146 개정 2026-09-28 R2-E2: D-1 · D-6 ·
-- D-7 · 「DB 계약」)
--
-- A person's device signing key (Secure Enclave P-256, D-1), kept per workspace
-- and per session lineage. Two halves, one file:
--
--   member_device_key
--       One row per public key a signed-in device uploaded. The row carries the
--       session lineage it was registered under (`token.session_id`, 088), so
--       the key lives exactly as long as that sign-in (D-7): logout, unlinking
--       the device, a refresh-token reuse and every "all sessions of the member
--       end" path write `revoked_at`. Rows are never deleted — an audit must be
--       able to re-verify an old signature (D-7).
--
--       Trust (D-6). The server does not decide which key is the root: the
--       root is the key the host Mac's workd pins over its local socket, and
--       workd is the security boundary (D-10). What the server records is the
--       *shape* that chain has to have, and its advisory state follows it:
--         * root candidate — a live `macos` key with no endorsement;
--         * endorsed       — a live key whose `device_endorse.v1` letter from a
--                            live root candidate of the same member verified;
--         * unendorsed     — any other live key: 「지시 불가」, it may be listed
--                            but can never authorize an instruction;
--         * revoked        — `revoked_at` is set.
--       Mac-to-Mac endorsement is the next stage (D-6), so only an `ios` key is
--       ever endorsed and an endorsed key is never itself an endorser.
--
--       A signed revocation letter (`device_revoke.v1`) is stored next to the
--       revocation so the server can hand it on to workd (D-7); a session end
--       revokes without one.
--
--   action_signature (060)
--       Gains `alg` (existing rows are `ed25519`), and the public-key CHECK
--       becomes per-algorithm: Ed25519 is 32 raw bytes (`{43}=`), P-256 is the
--       33-byte compressed SEC1 point (`{44}`, no padding). Both algorithms
--       sign 64 bytes, so the signature CHECK is unchanged (E1 #3021 fixes the
--       P-256 wire form to raw r‖s, low-s normalized).
--
-- The statements are written to be re-runnable (IF [NOT] EXISTS, DROP-then-ADD)
-- so applying the file twice is a no-op. RLS: `member_device_key` is a tenant
-- table — ENABLE + FORCE + ws_isolation, like every tenant table since 020.
-- schema_v0.sql is not modified.
-- =============================================================================

CREATE TABLE IF NOT EXISTS member_device_key (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id        uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  member_id           uuid NOT NULL,
  -- The sign-in lineage the key was registered under (088). NOT NULL: a key
  -- that no session end can reach would outlive every logout.
  session_id          uuid NOT NULL,
  alg                 text NOT NULL,
  -- base64 STANDARD of the key. For `p256`: the 33-byte compressed SEC1 point.
  public_key          text NOT NULL,
  platform            text NOT NULL,
  label               text NOT NULL DEFAULT '',
  -- The root candidate whose `device_endorse.v1` letter approved this key, and
  -- that letter's canonical low-s signature (base64 of raw r‖s).
  endorsed_by_key_id  uuid REFERENCES member_device_key(id),
  endorsement_sig     text,
  endorsed_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  revoked_at          timestamptz,
  -- Why the key ended: a signed letter or the end of its session lineage.
  revoked_reason      text,
  -- The signed revocation letter (`device_revoke.v1`), when there is one.
  -- `revoked_at_ms` is the time *inside* the signed bytes, kept verbatim so the
  -- letter can be re-verified; `revoked_at` is when the server recorded it.
  revoked_by_key_id   uuid REFERENCES member_device_key(id),
  revocation_sig      text,
  revoked_at_ms       bigint,
  CONSTRAINT member_device_key_member_fk
    FOREIGN KEY (workspace_id, member_id) REFERENCES member (workspace_id, id)
    ON DELETE CASCADE,
  CONSTRAINT member_device_key_alg_ck CHECK (alg IN ('p256')),
  CONSTRAINT member_device_key_public_key_ck CHECK (
    CASE alg
      WHEN 'p256' THEN public_key ~ '^[A-Za-z0-9+/]{44}$'
      ELSE false
    END
  ),
  CONSTRAINT member_device_key_platform_ck CHECK (platform IN ('macos', 'ios')),
  CONSTRAINT member_device_key_label_ck
    CHECK (char_length(label) <= 80 AND label !~ '[[:cntrl:]]'),
  -- An endorsement is all three facts or none of them, never self-signed, and
  -- only an `ios` key is endorsed (Mac-to-Mac is the next stage, D-6).
  CONSTRAINT member_device_key_endorsement_ck CHECK (
    (endorsed_by_key_id IS NULL AND endorsement_sig IS NULL AND endorsed_at IS NULL)
    OR (
      endorsed_by_key_id IS NOT NULL AND endorsement_sig IS NOT NULL
      AND endorsed_at IS NOT NULL
      AND endorsed_by_key_id <> id
      AND platform = 'ios'
      AND endorsement_sig ~ '^[A-Za-z0-9+/]{86}==$'
    )
  ),
  CONSTRAINT member_device_key_revoked_ck CHECK (
    (revoked_at IS NULL) = (revoked_reason IS NULL)
    AND (
      revoked_reason IS NULL
      OR revoked_reason IN (
        'signed', 'logout', 'device_unlinked', 'refresh_reuse', 'member_sessions_ended'
      )
    )
  ),
  -- A revocation letter is all three facts or none, and only on a revoked row.
  CONSTRAINT member_device_key_revocation_letter_ck CHECK (
    (revoked_by_key_id IS NULL AND revocation_sig IS NULL AND revoked_at_ms IS NULL)
    OR (
      revoked_by_key_id IS NOT NULL AND revocation_sig IS NOT NULL
      AND revoked_at_ms IS NOT NULL AND revoked_at IS NOT NULL
      AND revocation_sig ~ '^[A-Za-z0-9+/]{86}==$'
    )
  )
);

-- One live row per key in a workspace: another member cannot register a key
-- that is already somebody's, and a key cannot be live twice. A revoked key may
-- come back under a new sign-in (the device still holds it); it starts again
-- unendorsed.
CREATE UNIQUE INDEX IF NOT EXISTS member_device_key_live_public_key_uniq
  ON member_device_key (workspace_id, public_key)
  WHERE revoked_at IS NULL;

-- The session-end path: every live key of one lineage.
CREATE INDEX IF NOT EXISTS member_device_key_session_live_idx
  ON member_device_key (workspace_id, member_id, session_id)
  WHERE revoked_at IS NULL;

ALTER TABLE member_device_key ENABLE ROW LEVEL SECURITY;
ALTER TABLE member_device_key FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ws_isolation ON member_device_key;
CREATE POLICY ws_isolation ON member_device_key
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

COMMENT ON TABLE member_device_key IS
  'ADR-0146 개정 2026-09-28 (R2): a person''s device signing key, bound to the session lineage it was registered under (#3022).';
COMMENT ON COLUMN member_device_key.session_id IS
  'token.session_id (088) of the sign-in that registered the key. Ending that lineage revokes the key.';
COMMENT ON COLUMN member_device_key.endorsed_by_key_id IS
  'The root candidate (live macos key, itself unendorsed) whose device_endorse.v1 letter verified. Advisory: workd pins the real root (ADR-0146 D-6, D-10).';

-- ---- action_signature: the `alg` column ------------------------------------

ALTER TABLE action_signature
  ADD COLUMN IF NOT EXISTS alg text NOT NULL DEFAULT 'ed25519';

ALTER TABLE action_signature DROP CONSTRAINT IF EXISTS action_signature_alg_ck;
ALTER TABLE action_signature ADD CONSTRAINT action_signature_alg_ck
  CHECK (alg IN ('ed25519', 'p256'));

-- 060's Ed25519 arm, unchanged, plus the P-256 compressed point.
ALTER TABLE action_signature DROP CONSTRAINT IF EXISTS action_signature_pubkey_ck;
ALTER TABLE action_signature ADD CONSTRAINT action_signature_pubkey_ck CHECK (
  CASE alg
    WHEN 'ed25519' THEN signer_pubkey ~ '^[A-Za-z0-9+/]{43}=$'
    WHEN 'p256' THEN signer_pubkey ~ '^[A-Za-z0-9+/]{44}$'
    ELSE false
  END
);

COMMENT ON COLUMN action_signature.alg IS
  'ed25519 (host, agent; every row before 094) | p256 (a person''s device key, ADR-0146 개정 D-1).';

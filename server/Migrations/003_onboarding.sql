-- =============================================================================
-- 003_onboarding.sql — MOMO-010 multi-team onboarding DB extension
--
-- Adds invite_code for M2 self-serve workspace onboarding without modifying
-- schema_v0.sql. Raw invite codes are bearer secrets: generate them with
-- momo_generate_invite_code(), show them once to the creator, and store only
-- momo_invite_code_hash(raw_code) in invite_code.code_hash.
--
-- MOMO-010 runtime-verified: local gate runtime-db applies 001/002/003,
-- re-runs migrations idempotently, and verifies invite_code RLS isolation.
-- =============================================================================

-- High-entropy URL-safe invite code generator for MOMO-011 server routes.
-- 24 random bytes -> 32 base64url chars after padding trim.
CREATE OR REPLACE FUNCTION momo_generate_invite_code(byte_count integer DEFAULT 24)
RETURNS text
LANGUAGE sql
VOLATILE
AS $$
  SELECT rtrim(
           translate(
             replace(encode(gen_random_bytes(LEAST(GREATEST(byte_count, 16), 64)), 'base64'), E'\n', ''),
             '+/',
             '-_'
           ),
           '='
         );
$$;

CREATE OR REPLACE FUNCTION momo_invite_code_hash(raw_code text)
RETURNS bytea
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT digest(raw_code, 'sha256');
$$;

-- Composite same-workspace FKs for onboarding-owned member references.
ALTER TABLE member
  ADD CONSTRAINT member_workspace_id_id_uniq UNIQUE (workspace_id, id);

CREATE TABLE invite_code (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id        uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  code_hash           bytea NOT NULL,
  code_preview        text NOT NULL DEFAULT '',   -- safe display hint, e.g. last 4 chars
  role                membership_role NOT NULL DEFAULT 'member',
  max_uses            integer NOT NULL DEFAULT 1,
  used_count          integer NOT NULL DEFAULT 0,
  expires_at          timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  revoked_at          timestamptz,
  revoked_by          uuid,
  revocation_reason   text,
  created_by          uuid NOT NULL,
  last_used_at        timestamptz,
  metadata            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invite_code_hash_len_ck CHECK (octet_length(code_hash) = 32),
  CONSTRAINT invite_code_preview_ck CHECK (
    code_preview = '' OR code_preview ~ '^[A-Za-z0-9_-]{4,16}$'
  ),
  CONSTRAINT invite_code_role_ck CHECK (role <> 'owner'),
  CONSTRAINT invite_code_max_uses_ck CHECK (max_uses BETWEEN 1 AND 10000),
  CONSTRAINT invite_code_used_count_ck CHECK (used_count BETWEEN 0 AND max_uses),
  CONSTRAINT invite_code_expires_ck CHECK (expires_at > created_at),
  CONSTRAINT invite_code_revoked_by_ck CHECK (
    (revoked_at IS NULL AND revoked_by IS NULL)
    OR (revoked_at IS NOT NULL AND revoked_by IS NOT NULL)
  ),
  CONSTRAINT invite_code_created_by_workspace_fk
    FOREIGN KEY (workspace_id, created_by)
    REFERENCES member(workspace_id, id),
  CONSTRAINT invite_code_revoked_by_workspace_fk
    FOREIGN KEY (workspace_id, revoked_by)
    REFERENCES member(workspace_id, id)
);

ALTER TABLE invite_code
  ADD CONSTRAINT invite_code_workspace_id_id_uniq UNIQUE (workspace_id, id);

CREATE UNIQUE INDEX invite_code_code_hash_uniq
  ON invite_code (code_hash);
CREATE INDEX invite_code_active_lookup_idx
  ON invite_code (code_hash, expires_at)
  WHERE revoked_at IS NULL AND used_count < max_uses;
CREATE INDEX invite_code_workspace_active_idx
  ON invite_code (workspace_id, expires_at, role)
  WHERE revoked_at IS NULL AND used_count < max_uses;
CREATE INDEX invite_code_created_by_idx
  ON invite_code (workspace_id, created_by, created_at DESC);

CREATE TABLE invite_code_redemption (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id    uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  invite_code_id  uuid NOT NULL,
  member_id       uuid NOT NULL,
  email           text,
  ip_addr         inet,
  user_agent      text,
  redeemed_at     timestamptz NOT NULL DEFAULT now(),
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT invite_code_redemption_invite_member_uniq UNIQUE (invite_code_id, member_id),
  CONSTRAINT invite_code_redemption_invite_workspace_fk
    FOREIGN KEY (workspace_id, invite_code_id)
    REFERENCES invite_code(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT invite_code_redemption_member_workspace_fk
    FOREIGN KEY (workspace_id, member_id)
    REFERENCES member(workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX invite_code_redemption_invite_idx
  ON invite_code_redemption (workspace_id, invite_code_id, redeemed_at DESC);
CREATE INDEX invite_code_redemption_member_idx
  ON invite_code_redemption (workspace_id, member_id, redeemed_at DESC);

COMMENT ON TABLE invite_code IS
  'M2 onboarding invite codes. Raw code is shown once and never stored; code_hash is sha256(raw_code).';
COMMENT ON COLUMN invite_code.role IS
  'membership_role granted on successful redemption; owner is intentionally disallowed.';
COMMENT ON COLUMN invite_code.used_count IS
  'Increment atomically in the same transaction that creates member/membership and invite_code_redemption.';
COMMENT ON TABLE invite_code_redemption IS
  'Successful invite-code redemption audit trail, one row per created/joined member.';

-- RLS registration for new tenant tables. App/server transactions must still
-- SET LOCAL app.workspace_id before touching invite_code rows.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'invite_code','invite_code_redemption'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', t);
    EXECUTE format($f$
      CREATE POLICY ws_isolation ON %I
      USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
      WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);
    $f$, t);
  END LOOP;
END $$;

-- =============================================================================
-- 081_credential_claim.sql — #1767 / AC-1
-- Generalize 078's owner_claim into credential_claim + kind.
-- kind = owner_bootstrap | password_reset. Hash 32B, TTL, single-use
-- consumed_at, and the definer lookup stay the 078 convention.
-- schema_v0.sql is not modified.
-- =============================================================================

ALTER TABLE owner_claim RENAME TO credential_claim;

ALTER TABLE credential_claim
  RENAME CONSTRAINT owner_claim_member_fk TO credential_claim_member_fk;
ALTER TABLE credential_claim
  RENAME CONSTRAINT owner_claim_hash_len_ck TO credential_claim_hash_len_ck;
ALTER TABLE credential_claim
  RENAME CONSTRAINT owner_claim_expires_ck TO credential_claim_expires_ck;
ALTER TABLE credential_claim
  RENAME CONSTRAINT owner_claim_workspace_id_uniq TO credential_claim_workspace_id_uniq;

ALTER INDEX owner_claim_hash_idx RENAME TO credential_claim_hash_idx;

ALTER TABLE credential_claim
  ADD COLUMN kind text NOT NULL DEFAULT 'owner_bootstrap';

ALTER TABLE credential_claim
  ADD CONSTRAINT credential_claim_kind_ck
  CHECK (kind IN ('owner_bootstrap', 'password_reset'));

-- Existing rows are first-owner bootstrap. New inserts must name a kind;
-- the default stays so 078-era INSERT INTO … (no kind) still plants
-- owner_bootstrap (migrate claim path, claim_conformance fixtures).
COMMENT ON COLUMN credential_claim.kind IS
  'owner_bootstrap = ADR-0166 first-owner setup; password_reset = operator-issued reset (#1767).';

DROP INDEX owner_claim_workspace_open_uniq;

-- One live owner_bootstrap per workspace (078 contract, unchanged).
CREATE UNIQUE INDEX credential_claim_owner_bootstrap_open_uniq
  ON credential_claim (workspace_id)
  WHERE consumed_at IS NULL AND kind = 'owner_bootstrap';

-- One live password_reset per member. Reissue consumes the previous row
-- first; this index is the race gate if two issuers collide.
CREATE UNIQUE INDEX credential_claim_password_reset_open_uniq
  ON credential_claim (workspace_id, member_id)
  WHERE consumed_at IS NULL AND kind = 'password_reset';

COMMENT ON TABLE credential_claim IS
  'Credential claim tokens (owner_bootstrap + password_reset). SHA-256 of the raw token only; plaintext is never stored.';

-- Policy / FORCE RLS travel with the rename. Re-assert so a rename-only
-- checkout cannot silently lose the 078 self-check.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = current_schema()
       AND tablename = 'credential_claim'
       AND policyname = 'ws_isolation'
  ) THEN
    RAISE EXCEPTION 'missing ws_isolation policy on credential_claim';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = current_schema()
       AND c.relname = 'credential_claim'
       AND c.relrowsecurity
       AND c.relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'credential_claim is missing FORCE ROW LEVEL SECURITY';
  END IF;
END $$;

-- Same chicken-and-egg as 078: the caller holds only the raw token.
-- Body now reads credential_claim; the function name is unchanged so
-- existing EXECUTE grants and claim_conformance stay valid.
CREATE OR REPLACE FUNCTION momo_join_private.owner_claim_workspace_id(raw_token text)
RETURNS uuid
LANGUAGE sql
STABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT c.workspace_id
    FROM public.credential_claim AS c
    JOIN public.workspace AS w
      ON w.id = c.workspace_id
     AND w.deleted_at IS NULL
   WHERE c.token_hash = public.digest(raw_token, 'sha256')
   LIMIT 1;
$$;

COMMENT ON FUNCTION momo_join_private.owner_claim_workspace_id(text) IS
  'Claim preflight only: maps one raw claim token (any kind) to its workspace UUID; returns no tenant row data.';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE credential_claim TO momo_app;
    GRANT EXECUTE ON FUNCTION momo_join_private.owner_claim_workspace_id(text) TO momo_app;
  END IF;
END $$;

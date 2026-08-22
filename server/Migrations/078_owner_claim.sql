-- =============================================================================
-- 078_owner_claim.sql — ADR-0166 / T-1 (#1651)
-- First-owner claim token: hash + TTL + single-use consumed_at.
-- Raw token never lands in this table. schema_v0.sql is not modified.
-- =============================================================================

CREATE TABLE owner_claim (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id   uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  member_id      uuid NOT NULL,
  token_hash     bytea NOT NULL,
  expires_at     timestamptz NOT NULL,
  consumed_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT owner_claim_member_fk
    FOREIGN KEY (workspace_id, member_id)
    REFERENCES member(workspace_id, id),
  CONSTRAINT owner_claim_hash_len_ck CHECK (octet_length(token_hash) = 32),
  CONSTRAINT owner_claim_expires_ck CHECK (expires_at > created_at)
);

ALTER TABLE owner_claim
  ADD CONSTRAINT owner_claim_workspace_id_uniq UNIQUE (workspace_id, id);

-- One live (unconsumed) claim per workspace: the product surface is first
-- owner only. Consumed rows stay as the audit of what was spent.
CREATE UNIQUE INDEX owner_claim_workspace_open_uniq
  ON owner_claim (workspace_id)
  WHERE consumed_at IS NULL;

CREATE INDEX owner_claim_hash_idx
  ON owner_claim (token_hash);

COMMENT ON TABLE owner_claim IS
  'ADR-0166 first-owner bootstrap claim. SHA-256 of the raw token only; plaintext is never stored.';

ALTER TABLE owner_claim ENABLE ROW LEVEL SECURITY;
ALTER TABLE owner_claim FORCE ROW LEVEL SECURITY;
CREATE POLICY ws_isolation ON owner_claim
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

-- Same chicken-and-egg as invite join (009): the caller holds only the raw
-- token, so the tenant GUC cannot be set until this returns one uuid. It
-- returns no tenant row. EXECUTE is momo_app only.
CREATE FUNCTION momo_join_private.owner_claim_workspace_id(raw_token text)
RETURNS uuid
LANGUAGE sql
STABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT c.workspace_id
    FROM public.owner_claim AS c
    JOIN public.workspace AS w
      ON w.id = c.workspace_id
     AND w.deleted_at IS NULL
   WHERE c.token_hash = public.digest(raw_token, 'sha256')
   LIMIT 1;
$$;

COMMENT ON FUNCTION momo_join_private.owner_claim_workspace_id(text) IS
  'Claim preflight only: maps one raw claim token to its workspace UUID; returns no tenant row data.';

REVOKE ALL ON FUNCTION momo_join_private.owner_claim_workspace_id(text) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_relay') THEN
    REVOKE ALL ON FUNCTION momo_join_private.owner_claim_workspace_id(text) FROM momo_relay;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_worker') THEN
    REVOKE ALL ON FUNCTION momo_join_private.owner_claim_workspace_id(text) FROM momo_worker;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_platform_admin') THEN
    REVOKE ALL ON FUNCTION momo_join_private.owner_claim_workspace_id(text) FROM momo_platform_admin;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_notifier') THEN
    REVOKE ALL ON FUNCTION momo_join_private.owner_claim_workspace_id(text) FROM momo_notifier;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_app') THEN
    GRANT EXECUTE ON FUNCTION momo_join_private.owner_claim_workspace_id(text) TO momo_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE owner_claim TO momo_app;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = current_schema()
       AND tablename = 'owner_claim'
       AND policyname = 'ws_isolation'
  ) THEN
    RAISE EXCEPTION 'missing ws_isolation policy on owner_claim';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = current_schema()
       AND c.relname = 'owner_claim'
       AND c.relrowsecurity
       AND c.relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'owner_claim is missing FORCE ROW LEVEL SECURITY';
  END IF;
END $$;

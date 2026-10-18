-- =============================================================================
-- 142_github_ingress.sql — #3954 E-GH2 (ADR-0205 D3·D4·D5·D6)
--
-- 140 (E-GH1) stored the App, the installation routing table, the one-time claim, the channel
-- subscription and the delivery ledger. Receiving events and linking an installation needs four
-- more things that 140 deliberately left to this slice. Nothing in 140 is edited.
--
--   github_app_public               the App's NON-secret identity (slug), readable by any tenant
--                                   session, so a workspace owner/admin can be sent to
--                                   github.com/apps/<slug>/installations/new without ever being
--                                   able to SELECT the sealed `github_app` row.
--   github_installation_repository  the repositories an installation can see (ADR-0205 D5: kept
--                                   from `installation.created.repositories` and
--                                   `installation_repositories`; phase 1 calls no API). The
--                                   server's private-repository -> public-channel judgement
--                                   (acceptance 11) reads `private` from here.
--   github_workspace_author         the workspace's dedicated, non-login 「GitHub」 author member
--                                   (a name and a face — no `agent` row, no credential).
--   app.github_link GUC             the narrow privilege the "two signals meet" step needs (below).
--
-- DEVIATION RECORDED (ADR-0205 D5 said "정확한 정책 모양은 E-GH1에서 정하고 독립 보안 검수"):
--   D3's link step has a privilege gap that 140's policies cannot close on their own. A tenant
--   transaction may not UPDATE `github_app_installation.workspace_id` (UPDATE is ingress|admin),
--   and an ingress transaction may not SELECT `github_link_claim` (ws_isolation), yet the
--   setup-URL path and the signed `installation.created` path must both be able to say
--   "this claim names this installation, link them". Rather than widen `app.github_ingress`
--   (which also unlocks the sealed webhook secret and is held by the signature-verified receiver),
--   this migration adds a SECOND, narrower GUC, `app.github_link = 'on'`:
--
--       github_link_claim            SELECT/UPDATE rows with purpose = 'install' (any workspace)
--       github_app_installation      SELECT and UPDATE (to set workspace_id / linked_at)
--
--   It does NOT unlock `github_app` (no ciphertext), the repository table's writes, or any
--   tenant table. The unauthenticated setup-URL route binds ONLY this GUC; the signature-verified
--   receiver binds both. The link function refuses to auto-link when more than one pending claim
--   names the same installation_id (the spoofed-installation_id defence), so a forged setup URL
--   can at worst leave a pending claim that expires in ten minutes.
--
-- RLS: every table below is ENABLE + FORCE. No BYPASSRLS is used or required.
-- All statements are guarded so the file applies cleanly more than once.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- github_app_public — the App's non-secret identity
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS github_app_public (
  id         boolean PRIMARY KEY DEFAULT true,
  app_id     bigint NOT NULL,
  slug       text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT github_app_public_singleton_ck CHECK (id = true),
  CONSTRAINT github_app_public_slug_ck CHECK (length(btrim(slug)) > 0 AND length(slug) <= 200)
);

COMMENT ON TABLE github_app_public IS
  'ADR-0205 D3: the GitHub App slug (public on github.com) mirrored out of github_app so a '
  'workspace owner/admin can be sent to the install page. Kept in step by the github_app trigger; '
  'carries no secret and no ciphertext.';

ALTER TABLE github_app_public ENABLE ROW LEVEL SECURITY;
ALTER TABLE github_app_public FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS github_app_public_read ON github_app_public;
CREATE POLICY github_app_public_read ON github_app_public FOR SELECT USING (true);

DROP POLICY IF EXISTS github_app_public_write ON github_app_public;
CREATE POLICY github_app_public_write ON github_app_public
  USING (current_setting('app.github_app_admin', true) = 'on')
  WITH CHECK (current_setting('app.github_app_admin', true) = 'on');

CREATE OR REPLACE FUNCTION github_app_public_sync()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  INSERT INTO public.github_app_public (id, app_id, slug, updated_at)
  VALUES (true, NEW.app_id, NEW.slug, now())
  ON CONFLICT (id) DO UPDATE
    SET app_id = EXCLUDED.app_id, slug = EXCLUDED.slug, updated_at = now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS github_app_public_sync ON github_app;
CREATE TRIGGER github_app_public_sync
  AFTER INSERT OR UPDATE OF app_id, slug ON github_app
  FOR EACH ROW EXECUTE FUNCTION github_app_public_sync();

-- An App registered before this migration (E-GH1 shipped first) still gets its identity row.
INSERT INTO github_app_public (id, app_id, slug)
SELECT true, app_id, slug FROM github_app WHERE id = true
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- github_installation_repository — what an installation can see (no secret)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS github_installation_repository (
  installation_id bigint NOT NULL REFERENCES github_app_installation(installation_id) ON DELETE CASCADE,
  repo_id         bigint NOT NULL,
  full_name       text NOT NULL,
  private         boolean NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (installation_id, repo_id),
  CONSTRAINT github_installation_repository_name_ck
    CHECK (length(btrim(full_name)) > 0 AND length(full_name) <= 300)
);

CREATE INDEX IF NOT EXISTS github_installation_repository_name_idx
  ON github_installation_repository (installation_id, lower(full_name));

COMMENT ON TABLE github_installation_repository IS
  'ADR-0205 D5: repositories visible to an installation, maintained from installation.created and '
  'installation_repositories events. Written only by the signature-verified receiver; a tenant '
  'session reads only the rows of an installation linked to its own workspace.';

ALTER TABLE github_installation_repository ENABLE ROW LEVEL SECURITY;
ALTER TABLE github_installation_repository FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS github_installation_repository_select ON github_installation_repository;
CREATE POLICY github_installation_repository_select ON github_installation_repository
  FOR SELECT
  USING (
    current_setting('app.github_ingress', true) = 'on'
    OR current_setting('app.github_app_admin', true) = 'on'
    -- The sub-select is itself filtered by github_app_installation_select, so only an installation
    -- linked to the caller's own workspace is visible here.
    OR EXISTS (
      SELECT 1 FROM github_app_installation i
       WHERE i.installation_id = github_installation_repository.installation_id
         AND i.workspace_id IS NOT NULL
         AND i.workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
    )
  );

DROP POLICY IF EXISTS github_installation_repository_insert ON github_installation_repository;
CREATE POLICY github_installation_repository_insert ON github_installation_repository
  FOR INSERT WITH CHECK (current_setting('app.github_ingress', true) = 'on');

DROP POLICY IF EXISTS github_installation_repository_update ON github_installation_repository;
CREATE POLICY github_installation_repository_update ON github_installation_repository
  FOR UPDATE
  USING (current_setting('app.github_ingress', true) = 'on')
  WITH CHECK (current_setting('app.github_ingress', true) = 'on');

DROP POLICY IF EXISTS github_installation_repository_delete ON github_installation_repository;
CREATE POLICY github_installation_repository_delete ON github_installation_repository
  FOR DELETE USING (current_setting('app.github_ingress', true) = 'on');

-- ---------------------------------------------------------------------------
-- app.github_link — the narrow "two signals meet" privilege (see header)
-- ---------------------------------------------------------------------------
-- github_app_installation: add the link branch to SELECT and UPDATE (140's branches are kept).
DROP POLICY IF EXISTS github_app_installation_select ON github_app_installation;
CREATE POLICY github_app_installation_select ON github_app_installation
  FOR SELECT
  USING (
    current_setting('app.github_ingress', true) = 'on'
    OR current_setting('app.github_app_admin', true) = 'on'
    OR current_setting('app.github_link', true) = 'on'
    OR (workspace_id IS NOT NULL
        AND workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  );

-- The link branch of UPDATE reaches only a row that is still unlinked (workspace_id IS NULL): an
-- already-linked installation cannot be re-pointed through the narrow GUC even by a bug in code.
DROP POLICY IF EXISTS github_app_installation_update ON github_app_installation;
CREATE POLICY github_app_installation_update ON github_app_installation
  FOR UPDATE
  USING (current_setting('app.github_ingress', true) = 'on'
         OR current_setting('app.github_app_admin', true) = 'on'
         OR (current_setting('app.github_link', true) = 'on' AND workspace_id IS NULL))
  WITH CHECK (current_setting('app.github_ingress', true) = 'on'
              OR current_setting('app.github_app_admin', true) = 'on'
              OR current_setting('app.github_link', true) = 'on');

-- github_link_claim: a cross-workspace read/update of the *install* claims, link GUC only.
-- The manifest claim (purpose 'app_manifest') is never reachable through this branch.
DROP POLICY IF EXISTS github_link_claim_link_select ON github_link_claim;
CREATE POLICY github_link_claim_link_select ON github_link_claim
  FOR SELECT
  USING (current_setting('app.github_link', true) = 'on' AND purpose = 'install');

DROP POLICY IF EXISTS github_link_claim_link_update ON github_link_claim;
CREATE POLICY github_link_claim_link_update ON github_link_claim
  FOR UPDATE
  USING (current_setting('app.github_link', true) = 'on' AND purpose = 'install')
  WITH CHECK (current_setting('app.github_link', true) = 'on' AND purpose = 'install');

-- Through the link GUC a claim may only be spent (consumed_at) or told its installation_id; who
-- minted it, for which workspace and until when are immutable on that path.
CREATE OR REPLACE FUNCTION github_link_claim_link_guard()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF current_setting('app.github_link', true) = 'on'
     AND (NEW.workspace_id, NEW.member_id, NEW.state_hash, NEW.purpose, NEW.expires_at, NEW.created_at)
         IS DISTINCT FROM
         (OLD.workspace_id, OLD.member_id, OLD.state_hash, OLD.purpose, OLD.expires_at, OLD.created_at)
  THEN
    RAISE EXCEPTION 'github_link_claim: the link path may only record installation_id or spend a claim'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS github_link_claim_link_guard ON github_link_claim;
CREATE TRIGGER github_link_claim_link_guard
  BEFORE UPDATE ON github_link_claim
  FOR EACH ROW EXECUTE FUNCTION github_link_claim_link_guard();

CREATE INDEX IF NOT EXISTS github_link_claim_install_idx
  ON github_link_claim (installation_id)
  WHERE purpose = 'install' AND consumed_at IS NULL AND installation_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- github_workspace_author — the dedicated 「GitHub」 author member (tenant)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS github_workspace_author (
  workspace_id     uuid PRIMARY KEY REFERENCES workspace(id) ON DELETE CASCADE,
  author_member_id uuid NOT NULL REFERENCES member(id) ON DELETE CASCADE,
  created_at       timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE github_workspace_author IS
  'ADR-0205 D4: the workspace''s non-login author for GitHub notifications. A member of kind agent '
  'without an agent row: a name and a face, nothing that can act or sign in. Looked up here, never '
  'by handle, because a human may take any handle first.';

ALTER TABLE github_workspace_author ENABLE ROW LEVEL SECURITY;
ALTER TABLE github_workspace_author FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ws_isolation ON github_workspace_author;
CREATE POLICY ws_isolation ON github_workspace_author
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

-- ---------------------------------------------------------------------------
-- github_channel_subscription — the private-repository confirmation (acceptance 11)
-- ---------------------------------------------------------------------------
ALTER TABLE github_channel_subscription
  ADD COLUMN IF NOT EXISTS private_confirmed_at timestamptz;

COMMENT ON COLUMN github_channel_subscription.private_confirmed_at IS
  'Set when an owner/admin explicitly confirmed subscribing a (possibly) private repository to a '
  'public channel. NULL for subscriptions that needed no confirmation.';

-- =============================================================================
-- 074_hosted_agent_oauth.sql — HAP-E7 / ADR-0162 증보 1
--
-- The OAuth 2.1 authorization-server ledger for hosted Agent Port connections.
--
-- Three properties this migration exists to make unrepresentable, each of which
-- is otherwise only a convention in Rust:
--
--   1. **No bearer downgrade.** A hosted credential's class and its connection's
--      `auth_mode` must agree. A `hosted_active` (static) credential cannot be
--      minted on an `oauth` connection and an OAuth access/refresh credential
--      cannot be minted on a `static_bearer` one, so an OAuth failure has no
--      static path to fall back to and a static connection cannot be silently
--      upgraded. Enforced by a trigger because the two columns live in two
--      tables.
--   2. **The authorization code is a credential.** It is stored only as a
--      SHA-256 digest, is unique, is single-use, and its consumption is one
--      statement with the token issuance that replaces it.
--   3. **Rotation is exclusive.** One live access credential and one live
--      refresh credential per connection, so a refresh that mints a new pair
--      must revoke the old pair in the same transaction or violate an index.
--
-- Raw codes, verifiers, access tokens and refresh tokens are never stored.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- token: two new hosted credential classes and their OAuth provenance columns.
-- -----------------------------------------------------------------------------

-- 069 added `credential_class` with an inline CHECK, so its generated name is
-- looked up rather than assumed. The named binding constraint beside it is
-- excluded explicitly, and a missing match is a hard failure rather than a
-- silent no-op that would leave the old two-value vocabulary in place.
DO $$
DECLARE constraint_name text;
BEGIN
  SELECT c.conname INTO constraint_name
    FROM pg_constraint c
   WHERE c.conrelid = 'token'::regclass
     AND c.contype = 'c'
     AND c.conname <> 'token_hosted_binding_ck'
     AND pg_get_constraintdef(c.oid) LIKE '%credential_class%'
     AND pg_get_constraintdef(c.oid) LIKE '%hosted_active%';
  IF constraint_name IS NULL THEN
    RAISE EXCEPTION 'token.credential_class check constraint from 069 not found';
  END IF;
  EXECUTE format('ALTER TABLE token DROP CONSTRAINT %I', constraint_name);
END $$;

ALTER TABLE token
  ADD CONSTRAINT token_credential_class_ck CHECK (
    credential_class IN ('generic','hosted_active','hosted_oauth_access','hosted_oauth_refresh')
  ),
  ADD COLUMN oauth_client_id text
    CHECK (oauth_client_id IS NULL OR octet_length(oauth_client_id) BETWEEN 1 AND 200),
  ADD COLUMN oauth_request_id uuid,
  ADD COLUMN oauth_rotated_from_token_id uuid;

ALTER TABLE token
  DROP CONSTRAINT token_hosted_binding_ck,
  ADD CONSTRAINT token_hosted_binding_ck CHECK (
    (credential_class = 'generic' AND hosted_connection_id IS NULL AND audience IS NULL)
    OR (credential_class IN ('hosted_active','hosted_oauth_access','hosted_oauth_refresh')
      AND hosted_connection_id IS NOT NULL
      AND audience = '/v1/mcp/agent-port'
      AND 'agent:port:connect' = ANY(scopes)
      AND scopes <@ ARRAY[
        'agent:port:connect', 'agent:inbox:read', 'messages:read',
        'messages:write', 'agent:jobs:read', 'agent:runs:callback'
      ]::text[])
  ),
  -- OAuth provenance is all-or-nothing, and an OAuth credential always expires.
  -- A non-expiring OAuth access token would make revocation the only way to end
  -- a delegation the resource owner granted for a bounded time.
  ADD CONSTRAINT token_oauth_shape_ck CHECK (
    (credential_class IN ('hosted_oauth_access','hosted_oauth_refresh'))
      = (oauth_client_id IS NOT NULL)
    AND (credential_class IN ('hosted_oauth_access','hosted_oauth_refresh'))
      = (oauth_request_id IS NOT NULL)
    AND (credential_class NOT IN ('hosted_oauth_access','hosted_oauth_refresh')
      OR (expires_at IS NOT NULL AND kind = 'agent_bearer'))
    AND (oauth_rotated_from_token_id IS NULL
      OR credential_class IN ('hosted_oauth_access','hosted_oauth_refresh'))
  );

-- 069 permitted one live `hosted_active` credential per connection. The same
-- exclusivity now spans both access classes — a connection has one live access
-- credential whatever minted it — and refresh gets its own, which is what makes
-- refresh rotation atomic rather than additive.
DROP INDEX token_one_live_hosted_connection_credential;
CREATE UNIQUE INDEX token_one_live_hosted_connection_credential
  ON token (hosted_connection_id)
  WHERE credential_class IN ('hosted_active','hosted_oauth_access') AND revoked_at IS NULL;
CREATE UNIQUE INDEX token_one_live_hosted_oauth_refresh
  ON token (hosted_connection_id)
  WHERE credential_class = 'hosted_oauth_refresh' AND revoked_at IS NULL;

COMMENT ON COLUMN token.oauth_client_id IS
  'HAP-E7 pre-registered public client that this OAuth credential was issued to. Never a client secret.';
COMMENT ON COLUMN token.oauth_rotated_from_token_id IS
  'HAP-E7 refresh rotation predecessor. Presenting a rotated-away refresh credential is reuse.';

-- -----------------------------------------------------------------------------
-- The no-downgrade invariant, in the database.
-- -----------------------------------------------------------------------------
CREATE FUNCTION token_hosted_class_matches_auth_mode()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE mode text;
BEGIN
  IF NEW.credential_class = 'generic' THEN
    RETURN NEW;
  END IF;
  SELECT c.auth_mode INTO mode
    FROM public.hosted_agent_connection c
   WHERE c.workspace_id = NEW.workspace_id AND c.id = NEW.hosted_connection_id;
  IF mode IS NULL THEN
    RAISE EXCEPTION 'hosted credential must name a connection in its own workspace';
  END IF;
  IF NEW.credential_class = 'hosted_active' AND mode <> 'static_bearer' THEN
    RAISE EXCEPTION 'static hosted credential on a % connection', mode;
  END IF;
  IF NEW.credential_class IN ('hosted_oauth_access','hosted_oauth_refresh')
     AND mode <> 'oauth' THEN
    RAISE EXCEPTION 'oauth hosted credential on a % connection', mode;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER token_hosted_class_auth_mode_guard
BEFORE INSERT OR UPDATE OF credential_class, hosted_connection_id, workspace_id ON token
FOR EACH ROW EXECUTE FUNCTION token_hosted_class_matches_auth_mode();

COMMENT ON FUNCTION token_hosted_class_matches_auth_mode() IS
  'ADR-0162 증보 1: a hosted credential class and its connection auth_mode must agree, so OAuth cannot downgrade to static bearer and static cannot be upgraded in place.';

-- -----------------------------------------------------------------------------
-- hosted_agent_connection: the OAuth arm of the lifecycle.
--
-- An `oauth` connection has no static pairing challenge, and its `detected`
-- state is reached by the resource owner's consent rather than by a dial-in
-- handshake. Both shape constraints are widened by auth_mode rather than
-- relaxed for everyone, so the static arm keeps exactly the shape 069 sealed.
-- -----------------------------------------------------------------------------
ALTER TABLE hosted_agent_connection
  DROP CONSTRAINT hosted_agent_connection_pairing_shape_ck,
  ADD CONSTRAINT hosted_agent_connection_pairing_shape_ck CHECK (
    status <> 'pairing_pending'
    OR (auth_mode = 'static_bearer' AND pairing_challenge_hash IS NOT NULL
      AND pairing_expires_at IS NOT NULL AND pairing_consumed_at IS NULL)
    OR (auth_mode = 'oauth' AND pairing_challenge_hash IS NULL
      AND pairing_consumed_at IS NULL)
  ),
  DROP CONSTRAINT hosted_agent_connection_detection_shape_ck,
  ADD CONSTRAINT hosted_agent_connection_detection_shape_ck CHECK (
    status IN ('pairing_pending','expired','disconnected')
    OR (auth_mode = 'static_bearer' AND pairing_consumed_at IS NOT NULL
      AND detected_at IS NOT NULL AND detected_by IS NOT NULL)
    OR (auth_mode = 'oauth' AND pairing_challenge_hash IS NULL
      AND detected_at IS NOT NULL AND detected_by IS NOT NULL
      AND confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL)
  );

-- -----------------------------------------------------------------------------
-- The pending authorization request and its one terminal decision.
-- -----------------------------------------------------------------------------
CREATE TABLE hosted_oauth_authorization_request (
  id                     uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id           uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  hosted_connection_id   uuid NOT NULL,
  agent_member_id        uuid NOT NULL,
  -- The server-minted nonce carried by the signed authorization envelope. One
  -- row per nonce is what makes duplicate clicks, reloads and late callbacks
  -- resolve to a single terminal decision.
  request_nonce          uuid NOT NULL,
  client_id              text NOT NULL CHECK (octet_length(client_id) BETWEEN 1 AND 200),
  redirect_uri           text NOT NULL CHECK (octet_length(redirect_uri) BETWEEN 1 AND 2000),
  resource               text NOT NULL CHECK (octet_length(resource) BETWEEN 1 AND 2000),
  requested_scopes       text[] NOT NULL,
  approved_scopes        text[] NOT NULL DEFAULT '{}',
  code_challenge         text NOT NULL
    CHECK (octet_length(code_challenge) BETWEEN 43 AND 128),
  code_challenge_method  text NOT NULL CHECK (code_challenge_method = 'S256'),
  -- Client state is echoed back verbatim in the redirect. Bounded so it cannot
  -- become a storage channel; never logged.
  client_state           text CHECK (client_state IS NULL OR octet_length(client_state) <= 512),
  status                 text NOT NULL
    CHECK (status IN ('approved','denied','consumed','expired')),
  decided_by             uuid NOT NULL,
  decided_at             timestamptz NOT NULL DEFAULT now(),
  -- Only the digest. The raw authorization code exists once, in one response.
  code_hash              bytea,
  code_expires_at        timestamptz,
  code_consumed_at       timestamptz,
  access_token_id        uuid,
  refresh_token_id       uuid,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hosted_oauth_request_nonce_uniq UNIQUE (workspace_id, request_nonce),
  CONSTRAINT hosted_oauth_request_workspace_id_uniq UNIQUE (workspace_id, id),
  CONSTRAINT hosted_oauth_request_connection_fk
    FOREIGN KEY (workspace_id, hosted_connection_id)
    REFERENCES hosted_agent_connection(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT hosted_oauth_request_agent_fk
    FOREIGN KEY (workspace_id, agent_member_id)
    REFERENCES agent(workspace_id, member_id) ON DELETE CASCADE,
  CONSTRAINT hosted_oauth_request_decided_by_fk
    FOREIGN KEY (workspace_id, decided_by) REFERENCES member(workspace_id, id),
  CONSTRAINT hosted_oauth_request_scope_ck CHECK (
    requested_scopes <@ ARRAY[
      'agent:port:connect','agent:inbox:read','messages:read','messages:write',
      'agent:jobs:read','agent:runs:callback'
    ]::text[]
    AND 'agent:port:connect' = ANY(requested_scopes)
    AND approved_scopes <@ requested_scopes
    AND (status = 'denied' OR 'agent:port:connect' = ANY(approved_scopes))
  ),
  CONSTRAINT hosted_oauth_request_shape_ck CHECK (
    (status = 'denied' AND code_hash IS NULL AND code_expires_at IS NULL
      AND code_consumed_at IS NULL AND access_token_id IS NULL AND refresh_token_id IS NULL
      AND cardinality(approved_scopes) = 0)
    OR (status = 'approved' AND code_hash IS NOT NULL AND code_expires_at IS NOT NULL
      AND code_consumed_at IS NULL AND access_token_id IS NULL AND refresh_token_id IS NULL)
    OR (status = 'expired' AND code_hash IS NOT NULL AND code_expires_at IS NOT NULL
      AND code_consumed_at IS NULL)
    OR (status = 'consumed' AND code_hash IS NOT NULL AND code_consumed_at IS NOT NULL
      AND access_token_id IS NOT NULL AND refresh_token_id IS NOT NULL)
  )
);

-- One live code, globally one-time. The digest is unique across the table so a
-- replay cannot find a second row to consume even if a hash ever collided with
-- another workspace's.
CREATE UNIQUE INDEX hosted_oauth_request_code_hash_uniq
  ON hosted_oauth_authorization_request (code_hash)
  WHERE code_hash IS NOT NULL;
CREATE INDEX hosted_oauth_request_connection_idx
  ON hosted_oauth_authorization_request (workspace_id, hosted_connection_id, created_at DESC);

ALTER TABLE token
  ADD CONSTRAINT token_oauth_request_fk
    FOREIGN KEY (workspace_id, oauth_request_id)
    REFERENCES hosted_oauth_authorization_request(workspace_id, id) ON DELETE CASCADE;

COMMENT ON TABLE hosted_oauth_authorization_request IS
  'ADR-0162 증보 1: one terminal resource-owner decision per authorization request. Codes are stored as digests only; verifiers and tokens are never stored.';
COMMENT ON COLUMN hosted_oauth_authorization_request.client_state IS
  'Opaque client state echoed once into the redirect. Bounded, never logged, never an authority.';

ALTER TABLE hosted_oauth_authorization_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE hosted_oauth_authorization_request FORCE ROW LEVEL SECURITY;
CREATE POLICY ws_isolation ON hosted_oauth_authorization_request
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['hosted_oauth_authorization_request'] LOOP
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

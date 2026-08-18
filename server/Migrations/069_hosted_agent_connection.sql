-- =============================================================================
-- 069_hosted_agent_connection.sql — HAP-E3 / ADR-0162 D4,D6,D7
-- Dedicated dial-in identity and static-bearer pairing/activation ledger.
-- Raw pairing and active secrets are never stored; token_hash remains SHA-256.
-- =============================================================================

CREATE TABLE hosted_agent_connection (
  id                       uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id             uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  agent_member_id          uuid NOT NULL,
  status                   text NOT NULL DEFAULT 'pairing_pending'
    CHECK (status IN ('pairing_pending','detected','active','expired','cleanup_pending','disconnected')),
  auth_mode                text NOT NULL DEFAULT 'static_bearer'
    CHECK (auth_mode IN ('static_bearer','oauth')),
  audience                 text NOT NULL DEFAULT '/v1/mcp/agent-port'
    CHECK (audience = '/v1/mcp/agent-port'),
  pairing_challenge_hash   bytea,
  pairing_expires_at       timestamptz,
  pairing_consumed_at      timestamptz,
  detected_at              timestamptz,
  detected_by              uuid,
  detected_client_name     text CHECK (detected_client_name IS NULL OR octet_length(detected_client_name) <= 200),
  detected_client_version  text CHECK (detected_client_version IS NULL OR octet_length(detected_client_version) <= 100),
  detected_capabilities    jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(detected_capabilities) = 'object' AND octet_length(detected_capabilities::text) <= 4096),
  confirmed_by             uuid,
  confirmed_at             timestamptz,
  approved_channel_ids     uuid[] NOT NULL DEFAULT '{}',
  approved_scopes          text[] NOT NULL DEFAULT '{}',
  active_token_id          uuid UNIQUE,
  proved_at                timestamptz,
  proved_by                uuid,
  cleanup_manifest         jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(cleanup_manifest) = 'object' AND octet_length(cleanup_manifest::text) <= 8192),
  created_by               uuid NOT NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hosted_agent_connection_agent_fk
    FOREIGN KEY (workspace_id, agent_member_id)
    REFERENCES agent(workspace_id, member_id) ON DELETE CASCADE,
  CONSTRAINT hosted_agent_connection_confirmed_by_fk
    FOREIGN KEY (workspace_id, confirmed_by)
    REFERENCES member(workspace_id, id),
  CONSTRAINT hosted_agent_connection_created_by_fk
    FOREIGN KEY (workspace_id, created_by)
    REFERENCES member(workspace_id, id),
  CONSTRAINT hosted_agent_connection_detected_by_fk
    FOREIGN KEY (workspace_id, detected_by) REFERENCES member(workspace_id, id),
  CONSTRAINT hosted_agent_connection_proved_by_fk
    FOREIGN KEY (workspace_id, proved_by) REFERENCES member(workspace_id, id),
  CONSTRAINT hosted_agent_connection_pairing_shape_ck CHECK (
    (status = 'pairing_pending' AND pairing_challenge_hash IS NOT NULL
      AND pairing_expires_at IS NOT NULL AND pairing_consumed_at IS NULL)
    OR status <> 'pairing_pending'
  ),
  CONSTRAINT hosted_agent_connection_detection_shape_ck CHECK (
    status IN ('pairing_pending','expired','disconnected')
    OR (pairing_consumed_at IS NOT NULL AND detected_at IS NOT NULL AND detected_by IS NOT NULL)
  ),
  CONSTRAINT hosted_agent_connection_activation_shape_ck CHECK (
    status <> 'active'
    OR (confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL
      AND active_token_id IS NOT NULL AND proved_at IS NOT NULL AND proved_by IS NOT NULL)
  ),
  CONSTRAINT hosted_agent_connection_scopes_ck CHECK (
    approved_scopes <@ ARRAY[
      'agent:port:connect','agent:inbox:read','messages:read','messages:write',
      'agent:jobs:read','agent:runs:callback'
    ]::text[]
    AND (cardinality(approved_scopes) = 0 OR 'agent:port:connect' = ANY(approved_scopes))
  )
);

CREATE UNIQUE INDEX hosted_agent_connection_workspace_agent_live_uniq
  ON hosted_agent_connection (workspace_id, agent_member_id)
  WHERE status NOT IN ('expired','disconnected');
ALTER TABLE hosted_agent_connection
  ADD CONSTRAINT hosted_agent_connection_workspace_id_uniq UNIQUE (workspace_id, id);
CREATE INDEX hosted_agent_connection_workspace_status_idx
  ON hosted_agent_connection (workspace_id, status, created_at DESC);

ALTER TABLE token
  ADD COLUMN credential_class text NOT NULL DEFAULT 'generic'
    CHECK (credential_class IN ('generic','hosted_active')),
  ADD COLUMN hosted_connection_id uuid,
  ADD COLUMN audience text,
  ADD CONSTRAINT token_hosted_connection_fk
    FOREIGN KEY (workspace_id, hosted_connection_id)
    REFERENCES hosted_agent_connection(workspace_id, id) ON DELETE CASCADE,
  ADD CONSTRAINT token_hosted_binding_ck CHECK (
    (credential_class = 'generic' AND hosted_connection_id IS NULL AND audience IS NULL)
    OR (credential_class = 'hosted_active' AND hosted_connection_id IS NOT NULL
      AND audience = '/v1/mcp/agent-port'
      AND 'agent:port:connect' = ANY(scopes)
      AND scopes <@ ARRAY[
        'agent:port:connect', 'agent:inbox:read', 'messages:read',
        'messages:write', 'agent:jobs:read', 'agent:runs:callback'
      ]::text[])
  );

CREATE UNIQUE INDEX token_one_live_hosted_connection_credential
  ON token (hosted_connection_id)
  WHERE credential_class = 'hosted_active' AND revoked_at IS NULL;

ALTER TABLE token ADD CONSTRAINT token_workspace_id_id_uniq UNIQUE (workspace_id, id);
ALTER TABLE hosted_agent_connection
  ADD CONSTRAINT hosted_agent_connection_active_token_fk
    FOREIGN KEY (workspace_id, active_token_id)
    REFERENCES token(workspace_id, id) ON DELETE SET NULL (active_token_id);

COMMENT ON TABLE hosted_agent_connection IS
  'ADR-0162 dedicated dial-in agent pairing/activation ledger; provider secrets are forbidden.';
COMMENT ON COLUMN hosted_agent_connection.cleanup_manifest IS
  'Bounded non-secret provider artifact identifiers for HAP-E6 cleanup; never provider credentials.';
COMMENT ON COLUMN token.audience IS
  'Hosted credential resource audience. Null for generic credentials; exact Agent Port for hosted_active.';

ALTER TABLE hosted_agent_connection ENABLE ROW LEVEL SECURITY;
ALTER TABLE hosted_agent_connection FORCE ROW LEVEL SECURITY;
CREATE POLICY ws_isolation ON hosted_agent_connection
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

CREATE FUNCTION hosted_agent_connection_requires_dedicated_sentinel()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.agent a
     WHERE a.workspace_id = NEW.workspace_id AND a.member_id = NEW.agent_member_id
       AND a.model = 'hosted-agent'
       AND a.base_url = 'https://hosted-agent.invalid/disabled'
       AND a.config->>'execution_mode' = 'hosted_dial_in'
  ) THEN
    RAISE EXCEPTION 'hosted connection requires a dedicated sentinel agent';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER hosted_agent_connection_sentinel_guard
BEFORE INSERT OR UPDATE OF workspace_id, agent_member_id ON hosted_agent_connection
FOR EACH ROW EXECUTE FUNCTION hosted_agent_connection_requires_dedicated_sentinel();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['hosted_agent_connection'] LOOP
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

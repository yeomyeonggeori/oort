-- =============================================================================
-- 032_agent_card_registration.sql — MOMO-536 / ADR-0130 D4
--
-- Administrator-reviewed A2A Agent Card imports. The public card document is
-- retained for provenance; no provider credential or submitted secret belongs
-- in this ledger.
-- =============================================================================

CREATE TABLE agent_card_registration (
  id                uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id      uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  source_url        text NOT NULL,
  card_url          text NOT NULL,
  name              text NOT NULL,
  description       text,
  agent_url         text NOT NULL,
  capabilities      jsonb NOT NULL,
  security_schemes  jsonb NOT NULL DEFAULT '{}'::jsonb,
  raw_card           jsonb NOT NULL,
  status             text NOT NULL DEFAULT 'pending_consent',
  created_by         uuid NOT NULL,
  agent_member_id    uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  confirmed_at       timestamptz,
  CONSTRAINT agent_card_registration_status_ck CHECK (
    status IN ('pending_consent', 'confirmed')
  ),
  CONSTRAINT agent_card_registration_capabilities_ck CHECK (
    jsonb_typeof(capabilities) = 'object'
  ),
  CONSTRAINT agent_card_registration_security_ck CHECK (
    jsonb_typeof(security_schemes) = 'object'
  ),
  CONSTRAINT agent_card_registration_raw_ck CHECK (
    jsonb_typeof(raw_card) = 'object'
  ),
  CONSTRAINT agent_card_registration_created_by_workspace_fk
    FOREIGN KEY (workspace_id, created_by) REFERENCES member(workspace_id, id),
  CONSTRAINT agent_card_registration_agent_workspace_fk
    FOREIGN KEY (workspace_id, agent_member_id) REFERENCES member(workspace_id, id),
  CONSTRAINT agent_card_registration_confirmation_ck CHECK (
    (status = 'pending_consent' AND agent_member_id IS NULL AND confirmed_at IS NULL)
    OR
    (status = 'confirmed' AND agent_member_id IS NOT NULL AND confirmed_at IS NOT NULL)
  )
);

CREATE INDEX agent_card_registration_workspace_status_idx
  ON agent_card_registration (workspace_id, status, created_at DESC);
CREATE UNIQUE INDEX agent_card_registration_agent_uniq
  ON agent_card_registration (workspace_id, agent_member_id)
  WHERE agent_member_id IS NOT NULL;

COMMENT ON TABLE agent_card_registration IS
  'Public A2A card provenance and display-only security requirements; provider credentials and secrets are prohibited.';

ALTER TABLE agent_card_registration ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_card_registration FORCE ROW LEVEL SECURITY;
CREATE POLICY ws_isolation ON agent_card_registration
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

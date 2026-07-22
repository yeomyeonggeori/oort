-- =============================================================================
-- 035_memory_external_provider_consent.sql — MOMO-548
--
-- Explicit workspace-admin opt-in for sending memory extraction/embedding
-- content to an external provider. This is deliberately independent from the
-- workspace_memory_policy enabled switch. Existing workspaces fail closed.
-- =============================================================================

ALTER TABLE workspace
  ADD COLUMN memory_external_provider_consent boolean NOT NULL DEFAULT false,
  ADD COLUMN memory_external_provider_consent_updated_by uuid,
  ADD COLUMN memory_external_provider_consent_updated_at timestamptz;

ALTER TABLE workspace
  ADD CONSTRAINT workspace_memory_external_provider_consent_updater_fk
  FOREIGN KEY (id, memory_external_provider_consent_updated_by)
  REFERENCES member(workspace_id, id)
  ON DELETE SET NULL (memory_external_provider_consent_updated_by);

-- Concurrent extraction and embedding loops may both observe the same denied
-- workspace. The durable audit evidence is exactly once per workspace.
CREATE UNIQUE INDEX audit_log_memory_extraction_consent_required_once
  ON audit_log (workspace_id, action)
  WHERE action = 'memory.extraction.consent_required';

COMMENT ON COLUMN workspace.memory_external_provider_consent IS
  'Explicit admin opt-in for external-provider memory extraction/embedding; independent from workspace_memory_policy.';

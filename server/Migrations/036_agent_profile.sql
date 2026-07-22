-- =============================================================================
-- 036_agent_profile.sql — MOMO-537 / ADR-0131 D1
--
-- Tenant-scoped, credential-free agent definitions. Execution remains in the
-- existing AgentWorker / Context Packet path; this ledger adds no process.
-- 035 is reserved by the concurrently active MOMO-548 branch.
-- =============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS agent_workspace_member_uniq
  ON agent (workspace_id, member_id);

CREATE TABLE agent_profile (
  agent_member_id uuid PRIMARY KEY,
  workspace_id    uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  instructions    text NOT NULL DEFAULT '',
  model_pref      text,
  enabled_tools   jsonb NOT NULL DEFAULT '[]'::jsonb,
  triggers        jsonb NOT NULL DEFAULT '{"mention":true}'::jsonb,
  version         integer NOT NULL DEFAULT 1,
  updated_by      uuid NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_profile_agent_workspace_fk
    FOREIGN KEY (workspace_id, agent_member_id)
    REFERENCES agent(workspace_id, member_id) ON DELETE CASCADE,
  CONSTRAINT agent_profile_updated_by_workspace_fk
    FOREIGN KEY (workspace_id, updated_by)
    REFERENCES member(workspace_id, id),
  CONSTRAINT agent_profile_instructions_ck CHECK (octet_length(instructions) <= 8192),
  CONSTRAINT agent_profile_model_pref_ck CHECK (
    model_pref IS NULL OR (length(model_pref) BETWEEN 1 AND 200)
  ),
  CONSTRAINT agent_profile_enabled_tools_ck CHECK (
    jsonb_typeof(enabled_tools) = 'array'
    AND NOT jsonb_path_exists(enabled_tools, '$[*] ? (@.type() != "string")')
  ),
  CONSTRAINT agent_profile_triggers_ck CHECK (
    jsonb_typeof(triggers) = 'object'
    AND triggers->'mention' = 'true'::jsonb
    AND triggers - 'mention' - 'schedule' = '{}'::jsonb
  ),
  CONSTRAINT agent_profile_version_ck CHECK (version >= 1)
);

CREATE INDEX agent_profile_workspace_updated_idx
  ON agent_profile (workspace_id, updated_at DESC, agent_member_id);

COMMENT ON TABLE agent_profile IS
  'ADR-0131 agent personality/tool narrowing/trigger definition; credentials and provider secrets are forbidden.';
COMMENT ON COLUMN agent_profile.model_pref IS
  'Preference only. Runtime applies it only when workspace.settings.allowed_agent_models permits it.';
COMMENT ON COLUMN agent_profile.triggers IS
  'v0 mention=true is fixed; schedule is reserved data and has no executor.';

ALTER TABLE agent_profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_profile FORCE ROW LEVEL SECURITY;
CREATE POLICY ws_isolation ON agent_profile
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

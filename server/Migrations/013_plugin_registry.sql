-- =============================================================================
-- 013_plugin_registry.sql — MOMO-410 / ADR-0113 SE-04A
--
-- Physical plugin catalog, workspace install policy, delegated-user grant
-- ledger, and Capability Cache projection. Provider credentials and OAuth
-- tokens are deliberately absent: ADR-0113 custody A keeps them exclusively
-- on the user-owned agent host.
-- =============================================================================

CREATE TABLE plugin_registry (
  id                uuid PRIMARY KEY DEFAULT uuidv7(),
  plugin_id         text NOT NULL UNIQUE,
  version           text NOT NULL,
  manifest          jsonb NOT NULL,
  manifest_digest   text NOT NULL,
  official          boolean NOT NULL DEFAULT false,
  revoked_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT plugin_registry_id_ck
    CHECK (plugin_id ~ '^[a-z0-9][a-z0-9._-]{2,127}$'),
  CONSTRAINT plugin_registry_digest_ck
    CHECK (manifest_digest ~ '^sha256:[0-9a-f]{64}$')
);

COMMENT ON TABLE plugin_registry IS
  'Global manifest catalog. Contains policy metadata only; never credentials, OAuth tokens, or secrets.';

CREATE TABLE workspace_plugin_install (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id        uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  plugin_id           text NOT NULL REFERENCES plugin_registry(plugin_id),
  enabled             boolean NOT NULL DEFAULT false,
  installed_by        uuid NOT NULL REFERENCES member(id),
  installed_audit_id  uuid NOT NULL REFERENCES audit_log(id),
  revoked_at          timestamptz,
  revoked_by          uuid REFERENCES member(id),
  revoked_audit_id    uuid REFERENCES audit_log(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workspace_plugin_install_uniq UNIQUE (workspace_id, plugin_id),
  CONSTRAINT workspace_plugin_install_revoke_ck CHECK (
    (revoked_at IS NULL AND revoked_by IS NULL AND revoked_audit_id IS NULL)
    OR
    (revoked_at IS NOT NULL AND revoked_by IS NOT NULL AND revoked_audit_id IS NOT NULL)
  )
);

CREATE TABLE plugin_grant (
  id                uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id      uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  member_id         uuid NOT NULL REFERENCES member(id) ON DELETE CASCADE,
  plugin_id         text NOT NULL REFERENCES plugin_registry(plugin_id),
  scope             text NOT NULL,
  status            text NOT NULL DEFAULT 'active',
  granted_by        uuid NOT NULL REFERENCES member(id),
  granted_audit_id  uuid NOT NULL REFERENCES audit_log(id),
  revoked_at        timestamptz,
  revoked_audit_id  uuid REFERENCES audit_log(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT plugin_grant_four_tuple_uniq
    UNIQUE (workspace_id, member_id, plugin_id, scope),
  CONSTRAINT plugin_grant_scope_ck
    CHECK (scope ~ '^[a-z0-9][a-z0-9:._/-]{0,127}$'),
  CONSTRAINT plugin_grant_self_ck CHECK (granted_by = member_id),
  CONSTRAINT plugin_grant_status_ck CHECK (status IN ('active', 'revoked')),
  CONSTRAINT plugin_grant_revoke_ck CHECK (
    (status = 'active' AND revoked_at IS NULL AND revoked_audit_id IS NULL)
    OR
    (status = 'revoked' AND revoked_at IS NOT NULL AND revoked_audit_id IS NOT NULL)
  )
);

CREATE TABLE plugin_capability_projection (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id        uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  member_id           uuid NOT NULL REFERENCES member(id) ON DELETE CASCADE,
  plugin_id           text NOT NULL REFERENCES plugin_registry(plugin_id),
  scope               text NOT NULL,
  tool_name           text NOT NULL,
  capability_version  text NOT NULL,
  schema_digest       text NOT NULL,
  risk                text NOT NULL,
  approval_tier       text NOT NULL,
  grant_id            uuid NOT NULL REFERENCES plugin_grant(id) ON DELETE CASCADE,
  projected_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT plugin_capability_projection_uniq
    UNIQUE (workspace_id, member_id, plugin_id, scope, tool_name),
  CONSTRAINT plugin_capability_schema_digest_ck
    CHECK (schema_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT plugin_capability_risk_ck CHECK (risk IN ('read', 'write', 'admin')),
  CONSTRAINT plugin_capability_approval_tier_ck
    CHECK (approval_tier IN ('read_only', 'workspace_write', 'network_write'))
);

CREATE INDEX workspace_plugin_install_active_idx
  ON workspace_plugin_install (workspace_id, plugin_id)
  WHERE revoked_at IS NULL;
CREATE INDEX plugin_grant_active_member_idx
  ON plugin_grant (workspace_id, member_id, plugin_id)
  WHERE status = 'active';
CREATE INDEX plugin_capability_member_idx
  ON plugin_capability_projection (workspace_id, member_id, plugin_id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'workspace_plugin_install','plugin_grant','plugin_capability_projection'
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

-- Official hosted MCP catalog seeds verified in research/16-plugin-platform/03.
-- The declared digest is over PostgreSQL's canonical jsonb text. Mutating the
-- manifest without rotating the digest makes runtime admission fail closed.
WITH seed(plugin_id, version, manifest) AS (
  VALUES
  (
    'com.momo.plugins.github',
    '1.0.0',
    $manifest$
    {
      "schemaVersion":"momo.plugin.v1",
      "plugin":{"id":"com.momo.plugins.github","name":"GitHub","version":"1.0.0","description":"Official GitHub hosted MCP integration","publisher":{"id":"github","name":"GitHub","verified":true},"license":{"spdx":"MIT","kind":"open_source"},"provenance":{"sourceURL":"https://github.com/github/github-mcp-server","releaseRef":"hosted","verified":true}},
      "mcp":{"protocolVersion":"2025-06-18","transport":"streamable_http","url":"https://api.githubcopilot.com/mcp/","server":{"name":"github/github-mcp-server","version":"hosted"},"tools":[{"name":"github.list_repositories","description":"List repositories available to the delegated user","inputSchema":{"type":"object","properties":{},"additionalProperties":false},"schemaDigest":"sha256:1111111111111111111111111111111111111111111111111111111111111111","scopes":["github:read"],"risk":"read","approvalPolicy":"none"}]},
      "skill":{"reference":null,"optional":true},
      "momo":{"approvalTier":{"github.list_repositories":"read_only"},"risk":"low","egressDomains":["api.githubcopilot.com"],"recommendedFor":["software-development","work-tracking"],"serverPolicy":{"installAllowed":true,"enabledByDefault":false,"allowedRoles":["owner","admin"]}}
    }
    $manifest$::jsonb
  ),
  (
    'com.momo.plugins.notion',
    '1.0.0',
    $manifest$
    {
      "schemaVersion":"momo.plugin.v1",
      "plugin":{"id":"com.momo.plugins.notion","name":"Notion","version":"1.0.0","description":"Official Notion hosted MCP integration","publisher":{"id":"makenotion","name":"Notion","verified":true},"license":{"spdx":"MIT","kind":"open_source"},"provenance":{"sourceURL":"https://github.com/makenotion/notion-mcp-server","releaseRef":"hosted","verified":true}},
      "mcp":{"protocolVersion":"2025-06-18","transport":"streamable_http","url":"https://mcp.notion.com/mcp","server":{"name":"makenotion/notion-mcp-server","version":"hosted"},"tools":[{"name":"notion.search","description":"Search pages available to the delegated user","inputSchema":{"type":"object","properties":{"query":{"type":"string"}},"additionalProperties":false},"schemaDigest":"sha256:2222222222222222222222222222222222222222222222222222222222222222","scopes":["notion:read"],"risk":"read","approvalPolicy":"none"}]},
      "skill":{"reference":null,"optional":true},
      "momo":{"approvalTier":{"notion.search":"read_only"},"risk":"low","egressDomains":["mcp.notion.com"],"recommendedFor":["knowledge-management","documentation"],"serverPolicy":{"installAllowed":true,"enabledByDefault":false,"allowedRoles":["owner","admin"]}}
    }
    $manifest$::jsonb
  ),
  (
    'com.momo.plugins.linear',
    '1.0.0',
    $manifest$
    {
      "schemaVersion":"momo.plugin.v1",
      "plugin":{"id":"com.momo.plugins.linear","name":"Linear","version":"1.0.0","description":"Official Linear hosted MCP integration","publisher":{"id":"linear","name":"Linear","verified":true},"license":{"spdx":"LicenseRef-Linear-Hosted-Service","kind":"hosted_only"},"provenance":{"sourceURL":"https://linear.app/docs/mcp","releaseRef":"hosted","verified":true}},
      "mcp":{"protocolVersion":"2025-06-18","transport":"streamable_http","url":"https://mcp.linear.app/mcp","server":{"name":"linear-hosted-mcp","version":"hosted"},"tools":[{"name":"linear.list_issues","description":"List issues available to the delegated user","inputSchema":{"type":"object","properties":{},"additionalProperties":false},"schemaDigest":"sha256:3333333333333333333333333333333333333333333333333333333333333333","scopes":["linear:read"],"risk":"read","approvalPolicy":"none"}]},
      "skill":{"reference":null,"optional":true},
      "momo":{"approvalTier":{"linear.list_issues":"read_only"},"risk":"low","egressDomains":["mcp.linear.app"],"recommendedFor":["work-tracking","product-development"],"serverPolicy":{"installAllowed":true,"enabledByDefault":false,"allowedRoles":["owner","admin"]}}
    }
    $manifest$::jsonb
  )
)
INSERT INTO plugin_registry (plugin_id, version, manifest, manifest_digest, official)
SELECT plugin_id,
       version,
       manifest,
       'sha256:' || encode(sha256(convert_to(manifest::text, 'UTF8')), 'hex'),
       true
  FROM seed
ON CONFLICT (plugin_id) DO NOTHING;

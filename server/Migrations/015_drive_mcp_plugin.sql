-- =============================================================================
-- 015_drive_mcp_plugin.sql — MOMO-457 / ADR-0113 SE-04D
--
-- Registers the momo-hosted, read-only Drive path-C MCP. No credential or
-- shared-drive identifier is persisted: SA key custody and the drive boundary
-- remain deployment environment configuration.
-- =============================================================================

WITH seed(plugin_id, version, manifest) AS (
  VALUES (
    'com.momo.plugins.drive',
    '1.0.0',
    $manifest$
    {
      "schemaVersion":"momo.plugin.v1",
      "plugin":{"id":"com.momo.plugins.drive","name":"Google Drive","version":"1.0.0","description":"Official momo-hosted read-only MCP for an operator-configured shared drive","publisher":{"id":"momo","name":"momo","verified":true},"license":{"spdx":"Apache-2.0","kind":"open_source"},"provenance":{"sourceURL":"https://github.com/Dawn-kim-official/momo","releaseRef":"MOMO-457","verified":true}},
      "mcp":{"protocolVersion":"2025-06-18","transport":"streamable_http","url":"/v1/mcp/drive","server":{"name":"momo/drive-mcp","version":"1.0.0"},"tools":[{"name":"drive.search_files","description":"Search files within the configured shared drive","inputSchema":{"type":"object","properties":{"query":{"type":"string","maxLength":500},"pageSize":{"type":"integer","minimum":1,"maximum":100}},"additionalProperties":false},"schemaDigest":"sha256:5555555555555555555555555555555555555555555555555555555555555555","scopes":["drive:read"],"risk":"read","approvalPolicy":"none"},{"name":"drive.get_file_metadata","description":"Get metadata for a file in the configured shared drive","inputSchema":{"type":"object","properties":{"fileId":{"type":"string","minLength":1,"maxLength":200}},"required":["fileId"],"additionalProperties":false},"schemaDigest":"sha256:6666666666666666666666666666666666666666666666666666666666666666","scopes":["drive:read"],"risk":"read","approvalPolicy":"none"},{"name":"drive.export_text","description":"Export a Google Workspace document or download a bounded text file","inputSchema":{"type":"object","properties":{"fileId":{"type":"string","minLength":1,"maxLength":200},"maxBytes":{"type":"integer","minimum":1,"maximum":5000000}},"required":["fileId"],"additionalProperties":false},"schemaDigest":"sha256:7777777777777777777777777777777777777777777777777777777777777777","scopes":["drive:read"],"risk":"read","approvalPolicy":"none"}]},
      "skill":{"reference":null,"optional":true},
      "momo":{"hosted":true,"approvalTier":{"drive.search_files":"read_only","drive.get_file_metadata":"read_only","drive.export_text":"read_only"},"risk":"low","egressDomains":["www.googleapis.com","oauth2.googleapis.com"],"recommendedFor":["knowledge-management","shared-drive-search"],"serverPolicy":{"installAllowed":true,"enabledByDefault":false,"allowedRoles":["owner","admin"]}}
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

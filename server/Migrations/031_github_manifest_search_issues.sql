-- =============================================================================
-- 031_github_manifest_search_issues.sql — dev fixture manifest 확장
--
-- MOMO-528이 mock tool_grants를 plugin_capability 실투영으로 교체(fail-closed)
-- 하면서, 게이트 픽스처의 github.search_issues tool_call이 정책 부재로 승인
-- 정지되게 됐다. 레지스트리의 github 매니페스트에 search_issues capability를
-- 추가한다(read/none — list_repositories와 동일 등급). Fixtures/plugin-manifests/
-- github.json과 동기.
-- =============================================================================

UPDATE plugin_registry
   SET manifest = jsonb_set(
         jsonb_set(
           manifest,
           '{mcp,tools}',
           (manifest#>'{mcp,tools}') || $tool$
           {
             "name": "github.search_issues",
             "description": "Search issues in repositories available to the delegated user",
             "inputSchema": {"type":"object","properties":{"query":{"type":"string"},"limit":{"type":"integer"}},"additionalProperties":false},
             "schemaDigest": "sha256:2222222222222222222222222222222222222222222222222222222222222222",
             "scopes": ["github:read"],
             "risk": "read",
             "approvalPolicy": "none"
           }
           $tool$::jsonb
         ),
         '{momo,approvalTier,github.search_issues}',
         '"read_only"'::jsonb
       ),
       manifest_digest = 'sha256:' || encode(sha256(convert_to(
         jsonb_set(
           jsonb_set(
             manifest,
             '{mcp,tools}',
             (manifest#>'{mcp,tools}') || $tool2$
             {
               "name": "github.search_issues",
               "description": "Search issues in repositories available to the delegated user",
               "inputSchema": {"type":"object","properties":{"query":{"type":"string"},"limit":{"type":"integer"}},"additionalProperties":false},
               "schemaDigest": "sha256:2222222222222222222222222222222222222222222222222222222222222222",
               "scopes": ["github:read"],
               "risk": "read",
               "approvalPolicy": "none"
             }
             $tool2$::jsonb
           ),
           '{momo,approvalTier,github.search_issues}',
           '"read_only"'::jsonb
         )::text, 'UTF8')), 'hex')
 WHERE plugin_id = 'com.momo.plugins.github'
   AND NOT (manifest#>'{mcp,tools}') @> '[{"name":"github.search_issues"}]'::jsonb;

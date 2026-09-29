-- =============================================================================
-- 098_drop_legacy_memory_plane.sql — #3167 (ADR-0196 D11, MEM-M1)
--
-- Removes the first-generation Memory Plane (ADR-0129) that migrations 027,
-- 028, 030 and 035 created. Team memory v2 (ADR-0196) starts from a clean
-- slate, so nothing here is migrated: every row in these tables is DELETED.
-- That data loss is intended (the old plane had no Rust consumer and no
-- shipped UI; see the PR body for the zero-consumer evidence).
--
-- Dropped:
--   027  memory_item, memory_source_ref, memory_visibility_grant,
--        memory_lifecycle_event, memory_candidate, memory_extraction_cursor,
--        workspace_memory_policy   (their indexes, ws_isolation policies and
--        FKs go with the tables)
--   028  memory_search_hybrid(...) (redefined by 030; one function)
--        (embedding / tsv columns and their hnsw / gin indexes go with
--        memory_item)
--   030  context_packet (+ its immutability trigger and RLS policy),
--        reject_context_packet_mutation()
--   035  workspace.memory_external_provider_consent{,_updated_by,_updated_at}
--        (the updater FK goes with the column),
--        audit_log_memory_extraction_consent_required_once
--
-- Kept on purpose:
--   * the `vector` extension and the pgvector image — team memory v2 M3 uses
--     pgvector (ADR-0196 D8);
--   * member/channel/message/agent_run (workspace_id, id) unique indexes that
--     027/030 added — other tables' composite FKs may rely on them;
--   * audit_log rows with action 'memory.*' (history, no schema coupling).
--
-- No CASCADE: every dependency is named. A leftover dependent object makes
-- this migration fail loudly instead of being silently dropped.
-- schema_v0.sql is not modified. Re-runnable statements.
-- =============================================================================

DROP FUNCTION IF EXISTS memory_search_hybrid(
  uuid, uuid, text, vector, text, uuid, integer, integer
);

-- The trigger context_packet_immutable is dropped with its table.
DROP TABLE IF EXISTS context_packet;
DROP FUNCTION IF EXISTS reject_context_packet_mutation();

-- One statement so the FKs among these tables (source_ref/grant/lifecycle ->
-- item, lifecycle -> candidate, ...) need no CASCADE and no ordering guess.
DROP TABLE IF EXISTS
  memory_lifecycle_event,
  memory_source_ref,
  memory_visibility_grant,
  memory_candidate,
  memory_extraction_cursor,
  memory_item,
  workspace_memory_policy;

DROP INDEX IF EXISTS audit_log_memory_extraction_consent_required_once;

ALTER TABLE workspace
  DROP COLUMN IF EXISTS memory_external_provider_consent,
  DROP COLUMN IF EXISTS memory_external_provider_consent_updated_by,
  DROP COLUMN IF EXISTS memory_external_provider_consent_updated_at;

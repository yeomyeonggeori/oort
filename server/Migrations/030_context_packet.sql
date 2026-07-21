-- =============================================================================
-- 030_context_packet.sql — MOMO-528 / ADR-0129 D4
--
-- Immutable, tenant-scoped Context Packet snapshots. A policy or visibility
-- change never mutates content: callers issue another packet for the run.
-- =============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS agent_run_workspace_id_uniq
  ON agent_run (workspace_id, id);

CREATE TABLE context_packet (
  packet_id    uuid PRIMARY KEY DEFAULT uuidv7(),
  run_id       uuid NOT NULL,
  workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  content      jsonb NOT NULL,
  CONSTRAINT context_packet_run_fk
    FOREIGN KEY (workspace_id, run_id)
    REFERENCES agent_run(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT context_packet_expiry_ck CHECK (expires_at > created_at),
  CONSTRAINT context_packet_content_ck CHECK (
    content->>'schema' = 'momo.context_packet.v0'
    AND lower(content->>'packet_id') = lower(packet_id::text)
    AND lower(content#>>'{request,request_id}') = lower(run_id::text)
    AND lower(content#>>'{scope,workspace_id}') = lower(workspace_id::text)
  )
);

CREATE INDEX context_packet_run_idx
  ON context_packet (workspace_id, run_id, created_at DESC, packet_id DESC);
CREATE INDEX context_packet_expiry_idx
  ON context_packet (workspace_id, expires_at);

CREATE FUNCTION reject_context_packet_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'context_packet rows are immutable; issue a new packet'
    USING ERRCODE = '55000';
END
$$;

CREATE TRIGGER context_packet_immutable
BEFORE UPDATE OF packet_id, run_id, workspace_id, created_at, expires_at, content
ON context_packet
FOR EACH ROW EXECUTE FUNCTION reject_context_packet_mutation();

ALTER TABLE context_packet ENABLE ROW LEVEL SECURITY;
ALTER TABLE context_packet FORCE ROW LEVEL SECURITY;
CREATE POLICY ws_isolation ON context_packet
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

-- Delta 2: ordinary scope visibility (workspace + requesting member + target
-- agent) is unioned with an explicit, non-revoked member/agent grant. A grant
-- deliberately permits retrieval even when the actor is not a member of a
-- source channel; without one, every source channel must remain readable.
CREATE OR REPLACE FUNCTION memory_search_hybrid(
  p_workspace_id uuid,
  p_actor_member_id uuid,
  p_query text,
  p_query_embedding vector(384),
  p_scope text DEFAULT NULL,
  p_agent_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 20,
  p_rrf_k integer DEFAULT 60
)
RETURNS TABLE (
  memory_id uuid,
  fts_rank integer,
  vector_rank integer,
  vector_distance double precision,
  rrf_score double precision
)
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  WITH visible AS MATERIALIZED (
    SELECT mi.id, mi.tsv, mi.embedding
      FROM memory_item mi
     WHERE mi.workspace_id = p_workspace_id
       AND mi.invalid_at IS NULL
       AND (p_scope IS NULL OR mi.scope = p_scope)
       AND (
         (
           (mi.scope = 'workspace'
             OR (mi.scope = 'member' AND mi.subject_member_id = p_actor_member_id)
             OR (mi.scope = 'agent' AND p_agent_id IS NOT NULL
                                      AND mi.agent_member_id = p_agent_id))
           AND NOT EXISTS (
             SELECT 1 FROM memory_source_ref hidden
              WHERE hidden.workspace_id = mi.workspace_id
                AND hidden.memory_id = mi.id
                AND NOT EXISTS (
                  SELECT 1 FROM membership ms
                   WHERE ms.workspace_id = hidden.workspace_id
                     AND ms.channel_id = hidden.channel_id
                     AND ms.member_id = p_actor_member_id
                     AND ms.left_at IS NULL
                )
           )
         )
         OR EXISTS (
           SELECT 1 FROM memory_visibility_grant grant_row
            WHERE grant_row.workspace_id = mi.workspace_id
              AND grant_row.memory_id = mi.id
              AND grant_row.revoked_at IS NULL
              AND (
                (grant_row.grantee_kind = 'member'
                  AND grant_row.grantee_id = p_actor_member_id)
                OR (grant_row.grantee_kind = 'agent'
                  AND p_agent_id IS NOT NULL
                  AND grant_row.grantee_id = p_agent_id)
              )
         )
       )
       AND EXISTS (
         SELECT 1 FROM memory_source_ref present
          WHERE present.workspace_id = mi.workspace_id
            AND present.memory_id = mi.id
       )
  ),
  fts AS (
    SELECT v.id,
           row_number() OVER (
             ORDER BY ts_rank_cd(v.tsv, websearch_to_tsquery('simple', p_query)) DESC, v.id
           )::integer AS rank
      FROM visible v
     WHERE v.tsv @@ websearch_to_tsquery('simple', p_query)
     ORDER BY ts_rank_cd(v.tsv, websearch_to_tsquery('simple', p_query)) DESC, v.id
     LIMIT greatest(least(p_limit * 4, 200), 1)
  ),
  semantic AS (
    SELECT v.id,
           row_number() OVER (ORDER BY v.embedding <=> p_query_embedding, v.id)::integer AS rank,
           (v.embedding <=> p_query_embedding)::double precision AS distance
      FROM visible v
     WHERE p_query_embedding IS NOT NULL AND v.embedding IS NOT NULL
     ORDER BY v.embedding <=> p_query_embedding, v.id
     LIMIT greatest(least(p_limit * 4, 200), 1)
  ),
  fused AS (
    SELECT coalesce(f.id, s.id) AS id,
           f.rank AS fts_rank,
           s.rank AS vector_rank,
           s.distance AS vector_distance,
           coalesce(1.0 / (p_rrf_k + f.rank), 0.0)
             + coalesce(1.0 / (p_rrf_k + s.rank), 0.0) AS score
      FROM fts f
      FULL OUTER JOIN semantic s ON s.id = f.id
  )
  SELECT fused.id, fused.fts_rank, fused.vector_rank,
         fused.vector_distance, fused.score
    FROM fused
   ORDER BY fused.score DESC, fused.id
   LIMIT greatest(least(p_limit, 100), 1)
$$;

COMMENT ON TABLE context_packet IS
  'Immutable per-run context snapshot. Reissue instead of UPDATE after expiry or policy/visibility change.';
COMMENT ON FUNCTION memory_search_hybrid IS
  'MOMO-528 RRF retrieval: default actor/agent/workspace scope union active explicit grants; SECURITY INVOKER + FORCE RLS';

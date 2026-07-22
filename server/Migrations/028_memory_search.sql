-- =============================================================================
-- 028_memory_search.sql — MOMO-527 / ADR-0129 D3
--
-- PG-native hybrid retrieval. The function remains SECURITY INVOKER (default),
-- so FORCE RLS and the caller's SET LOCAL app.workspace_id stay authoritative.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE memory_item
  ADD COLUMN embedding vector(384),
  ADD COLUMN tsv tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', coalesce(body, ''))
  ) STORED;

-- A normal migration transaction intentionally builds these indexes without
-- CONCURRENTLY. The v0 memory table is new/small; migration orchestration must
-- remain atomic and PostgreSQL forbids CREATE INDEX CONCURRENTLY in a tx block.
CREATE INDEX memory_item_embedding_hnsw_idx
  ON memory_item USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL AND invalid_at IS NULL;

CREATE INDEX memory_item_tsv_gin_idx
  ON memory_item USING gin (tsv)
  WHERE invalid_at IS NULL;

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
       AND (p_agent_id IS NULL OR mi.agent_member_id = p_agent_id)
       AND EXISTS (
         SELECT 1 FROM memory_source_ref present
          WHERE present.workspace_id = mi.workspace_id
            AND present.memory_id = mi.id
       )
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

COMMENT ON FUNCTION memory_search_hybrid IS
  'MOMO-527 RRF hybrid memory retrieval; SECURITY INVOKER and FORCE RLS only';

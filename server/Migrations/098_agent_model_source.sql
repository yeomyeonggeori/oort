-- =============================================================================
-- 098_agent_model_source.sql — #3147 / ADR-0147 증보 (2026-09-29), #3146 후속
--
-- agent.model is NOT NULL, so it cannot say whether the operator PICKED that model
-- or it is only the placeholder stored because nothing was picked. #3146's worker
-- guessed from the name (payload model empty or == AGENT_MODEL). This records the
-- fact: which of the two it is, so the team's 「기본 AI」 row applies to exactly the
-- agents that follow the instance default.
--
--   'agent'            the agent's own choice; the team row never applies
--   'instance_default' follows the instance default; the team row applies and
--                      agent.model is only what runs when the row names no model
--
-- Backfill (one time, the faithful translation of the #3146 heuristic): rows whose
-- model is the instance placeholder 'hermes-agent' (002/006 seed, and the worker's
-- AGENT_MODEL default) become 'instance_default'; every other row is 'agent'.
-- A deployment whose AGENT_MODEL differs from the placeholder can re-mark agents
-- through PUT .../agents/{agent}/profile { modelSource }.
-- =============================================================================

-- Re-runnable: the backfill runs only in the run that adds the column, so a
-- re-run can never overwrite a source an operator has since chosen.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'agent' AND column_name = 'model_source'
  ) THEN
    ALTER TABLE agent ADD COLUMN model_source text NOT NULL DEFAULT 'agent';
    UPDATE agent SET model_source = 'instance_default' WHERE model = 'hermes-agent';
  END IF;
END $$;

ALTER TABLE agent DROP CONSTRAINT IF EXISTS agent_model_source_ck;
ALTER TABLE agent
  ADD CONSTRAINT agent_model_source_ck
  CHECK (model_source IN ('agent', 'instance_default'));

COMMENT ON COLUMN agent.model_source IS
  '#3147: agent = the model is the agent''s own choice (team default-ai row never applies); instance_default = follows the instance default (row applies; model is the fallback).';

-- =============================================================================
-- 037_agent_interaction_safety.sql — MOMO-557 / ADR-0132 D2
--
-- Pausing is a workspace-scoped profile property. It prevents new runs from
-- being enqueued without changing the agent's first-class member identity.
-- Existing runs are stopped separately through the human cancel REST path.
-- =============================================================================

ALTER TABLE agent_profile
  ADD COLUMN paused boolean NOT NULL DEFAULT false;

CREATE INDEX agent_profile_workspace_paused_idx
  ON agent_profile (workspace_id, agent_member_id)
  WHERE paused;

COMMENT ON COLUMN agent_profile.paused IS
  'ADR-0132 D2 human pause switch; blocks new run enqueue in this workspace.';

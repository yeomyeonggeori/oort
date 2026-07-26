-- =============================================================================
-- 041_run_routing_effort.sql — MOMO-621 / ADR-0134 D2·D3
--
-- The effort axis did not exist anywhere in first-party code before this
-- migration (ADR-0134 Context #2). Two additive columns, no new table:
--
--   * usage_ledger.effort      — cost-analysis axis next to `model`. NULL means
--                                "no effort was chosen or inherited for this
--                                request", which is the pre-0134 state of every
--                                existing row, so the backfill is a no-op.
--   * agent_profile.effort_pref — agent tier of the ADR-0134 D3 inheritance
--                                chain (workspace default → agent → request),
--                                the sibling of the existing `model_pref`.
--
-- Valid values are a provider×model table served by GET /v1/provider/effort-table
-- (server-side constant in v0), NOT a database enum: which levels a model accepts
-- differs per model and evolves faster than migrations. The CHECKs here are
-- therefore length guards only — the semantic gate lives in the request path
-- (400 on an explicit violation) and in the silent-ignore inheritance rule.
--
-- RLS: both tables already carry the uniform workspace policy under FORCE
-- (usage_ledger from 001_init, agent_profile from 036). Adding a column changes
-- neither, and no new table means no DO-block ARRAY registration.
--
-- schema_v0.sql is not touched (migration-only, per the hard rules).
-- =============================================================================

ALTER TABLE usage_ledger
  ADD COLUMN IF NOT EXISTS effort text;

ALTER TABLE usage_ledger
  DROP CONSTRAINT IF EXISTS usage_ledger_effort_ck;
ALTER TABLE usage_ledger
  ADD CONSTRAINT usage_ledger_effort_ck CHECK (
    effort IS NULL OR (length(effort) BETWEEN 1 AND 32)
  );

COMMENT ON COLUMN usage_ledger.effort IS
  'ADR-0134 D2 reasoning-effort axis for cost analysis. NULL = none chosen or inherited. '
  'Valid values are the provider x model table (GET /v1/provider/effort-table), not a DB enum.';

ALTER TABLE agent_profile
  ADD COLUMN IF NOT EXISTS effort_pref text;

ALTER TABLE agent_profile
  DROP CONSTRAINT IF EXISTS agent_profile_effort_pref_ck;
ALTER TABLE agent_profile
  ADD CONSTRAINT agent_profile_effort_pref_ck CHECK (
    effort_pref IS NULL OR (length(effort_pref) BETWEEN 1 AND 32)
  );

COMMENT ON COLUMN agent_profile.effort_pref IS
  'ADR-0134 D3 agent-tier effort preference (sibling of model_pref). Preference only: '
  'the runtime applies it only when the resolved model supports it, and silently ignores it otherwise.';

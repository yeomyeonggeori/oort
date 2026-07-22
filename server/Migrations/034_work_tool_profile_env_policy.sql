-- =============================================================================
-- 034_work_tool_profile_env_policy.sql — MOMO-547 / ADR-0004
--
-- Stores environment variable names and mode only. Values remain host-local.
-- 033 is intentionally reserved for the concurrently active MOMO-535 wave.
-- =============================================================================

ALTER TABLE work_tool_profile
  ADD COLUMN env_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD CONSTRAINT work_tool_profile_env_policy_ck CHECK (
    jsonb_typeof(env_policy) = 'object'
  );

COMMENT ON COLUMN work_tool_profile.env_policy IS
  'Host child environment mode and explicit passthrough key names; never values or credentials.';

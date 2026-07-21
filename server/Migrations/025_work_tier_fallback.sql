-- =============================================================================
-- 025_work_tier_fallback.sql — MOMO-519 / ADR-0125 D11
--
-- Tier fallback stores policy and session lineage only. Host-local paths,
-- credentials, process state, and terminal bytes remain outside PostgreSQL.
-- =============================================================================

CREATE TABLE work_tier_policy (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id     uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  member_id        uuid REFERENCES member(id) ON DELETE CASCADE,
  mode             text NOT NULL DEFAULT 'ask',
  auto_target      text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT work_tier_policy_mode_ck
    CHECK (mode IN ('t1_only', 'ask', 'auto')),
  CONSTRAINT work_tier_policy_auto_target_ck CHECK (
    (mode = 'auto' AND auto_target IS NOT NULL
      AND (auto_target = 'cloud' OR auto_target ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'))
    OR (mode <> 'auto' AND auto_target IS NULL)
  )
);

CREATE UNIQUE INDEX work_tier_policy_workspace_default_uniq
  ON work_tier_policy (workspace_id)
  WHERE member_id IS NULL;
CREATE UNIQUE INDEX work_tier_policy_member_override_uniq
  ON work_tier_policy (workspace_id, member_id)
  WHERE member_id IS NOT NULL;

ALTER TABLE work_tier_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_tier_policy FORCE ROW LEVEL SECURITY;
CREATE POLICY ws_isolation ON work_tier_policy
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

ALTER TABLE work_session DROP CONSTRAINT work_session_status_ck;
ALTER TABLE work_session DROP CONSTRAINT work_session_lifecycle_ck;
ALTER TABLE work_session DROP CONSTRAINT work_session_root_message_id_key;

ALTER TABLE work_session
  ADD COLUMN end_reason text,
  ADD COLUMN resumed_from_session_id uuid REFERENCES work_session(id),
  ADD CONSTRAINT work_session_status_ck
    CHECK (status IN ('running', 'orphaned', 'ended')),
  ADD CONSTRAINT work_session_end_reason_ck
    CHECK (end_reason IS NULL OR end_reason IN ('orphaned', 'resumed')),
  ADD CONSTRAINT work_session_lifecycle_ck CHECK (
    (status = 'running' AND ended_at IS NULL AND exit_code IS NULL AND end_reason IS NULL)
    OR (status = 'orphaned' AND ended_at IS NULL AND exit_code IS NULL AND end_reason IS NULL)
    OR (status = 'ended' AND ended_at IS NOT NULL)
  ),
  ADD CONSTRAINT work_session_resume_not_self_ck
    CHECK (resumed_from_session_id IS NULL OR resumed_from_session_id <> id);

CREATE INDEX work_session_resumed_from_idx
  ON work_session (resumed_from_session_id)
  WHERE resumed_from_session_id IS NOT NULL;
CREATE INDEX work_session_host_running_idx
  ON work_session (host_id, started_at, id)
  WHERE status = 'running';

-- =============================================================================
-- 047_work_session_idle.sql — MOMO-648 / ADR-0139 D1
--
-- A tool process ending no longer ends its work session. `idle_at` is the
-- authoritative timeout clock; workspace.settings is read by NotifierWorker
-- only through the single `work_session_idle_timeout_seconds` key.
--
-- `exit_code` now means the last tool execution result. It is therefore valid
-- in idle and remains valid when the same PTY returns to running. The prior
-- `running => exit_code IS NULL` lifecycle rule from 025 is deliberately
-- removed; treating it as a session exit code made idle -> running impossible.
-- =============================================================================

ALTER TABLE work_session DROP CONSTRAINT work_session_status_ck;
ALTER TABLE work_session DROP CONSTRAINT work_session_end_reason_ck;
ALTER TABLE work_session DROP CONSTRAINT work_session_lifecycle_ck;

ALTER TABLE work_session
  ADD COLUMN idle_at timestamptz,
  ADD CONSTRAINT work_session_status_ck
    CHECK (status IN ('running', 'idle', 'orphaned', 'ended')),
  ADD CONSTRAINT work_session_end_reason_ck
    CHECK (end_reason IS NULL OR end_reason IN ('orphaned', 'resumed', 'idle_timeout')),
  ADD CONSTRAINT work_session_lifecycle_ck CHECK (
    (status = 'running'
      AND idle_at IS NULL AND ended_at IS NULL AND end_reason IS NULL)
    OR
    (status = 'idle'
      AND idle_at IS NOT NULL AND ended_at IS NULL AND end_reason IS NULL)
    OR
    (status = 'orphaned'
      AND idle_at IS NULL AND ended_at IS NULL AND end_reason IS NULL)
    OR
    (status = 'ended'
      AND idle_at IS NULL AND ended_at IS NOT NULL)
  );

DROP INDEX work_session_host_running_idx;
DROP INDEX work_session_channel_active_idx;
DROP INDEX work_session_member_active_idx;
DROP INDEX work_session_pool_active_idx;
CREATE INDEX work_session_host_active_idx
  ON work_session (host_id, started_at, id)
  WHERE status IN ('running', 'idle');
CREATE INDEX work_session_channel_active_idx
  ON work_session (channel_id, started_at DESC)
  WHERE status IN ('running', 'idle');
CREATE INDEX work_session_member_active_idx
  ON work_session (member_id, started_at DESC)
  WHERE status IN ('running', 'idle');
CREATE INDEX work_session_pool_active_idx
  ON work_session (workspace_id, member_id)
  WHERE status IN ('running', 'idle');

CREATE INDEX work_session_idle_timeout_idx
  ON work_session (idle_at, id)
  WHERE status = 'idle';

COMMENT ON COLUMN work_session.idle_at IS
  'ADR-0139 D1 timeout clock; set only while status=idle.';
COMMENT ON COLUMN work_session.exit_code IS
  'ADR-0139 D1 result of the last tool execution, not a session termination code.';

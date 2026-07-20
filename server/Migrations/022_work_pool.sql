-- =============================================================================
-- 022_work_pool.sql — MOMO-489 / ADR-0125 D5, D7
--
-- Workspace-shared billing/quota settings only. Active usage remains derived
-- from work_session(status='running'); no duplicated counter is stored here.
-- Warm execution instances and automatic queue starts are provisioner follow-ups.
-- =============================================================================

CREATE TABLE work_pool (
  workspace_id              uuid PRIMARY KEY REFERENCES workspace(id) ON DELETE CASCADE,
  max_active                int NOT NULL DEFAULT 5,
  included_active_hours     int,
  per_member_soft_limit     int NOT NULL DEFAULT 5,
  CONSTRAINT work_pool_max_active_ck
    CHECK (max_active BETWEEN 1 AND 1000),
  CONSTRAINT work_pool_included_active_hours_ck
    CHECK (included_active_hours IS NULL OR included_active_hours BETWEEN 0 AND 1000000),
  CONSTRAINT work_pool_member_soft_limit_ck
    CHECK (per_member_soft_limit BETWEEN 1 AND max_active)
);

-- Existing workspaces receive the v0 defaults. New or externally provisioned
-- workspaces are covered by the tenant-scoped upsert-on-read/acquire REST path.
INSERT INTO work_pool (workspace_id)
SELECT id FROM workspace
ON CONFLICT (workspace_id) DO NOTHING;

CREATE INDEX work_session_pool_active_idx
  ON work_session (workspace_id, member_id)
  WHERE status = 'running';

ALTER TABLE work_pool ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_pool FORCE ROW LEVEL SECURITY;
CREATE POLICY ws_isolation ON work_pool
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

-- =============================================================================
-- 021_work_host.sql — MOMO-487 / ADR-0125 D1, D8
--
-- Registered execution hosts are durable identities only. Host-local paths,
-- processes, provider credentials, and private signing material never enter
-- this table. `capabilities` is additionally closed to boolean availability
-- flags by the REST boundary.
-- =============================================================================

CREATE TABLE work_host (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id     uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  scope            text NOT NULL,
  owner_member_id  uuid NOT NULL REFERENCES member(id),
  type             text NOT NULL,
  display_name     text NOT NULL,
  public_key       text NOT NULL,
  capabilities     jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_seen_at     timestamptz,
  revoked_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT work_host_scope_ck CHECK (scope IN ('member', 'workspace')),
  CONSTRAINT work_host_type_ck CHECK (type IN ('app', 'workd', 'cloud')),
  CONSTRAINT work_host_display_name_ck
    CHECK (length(btrim(display_name)) BETWEEN 1 AND 80),
  CONSTRAINT work_host_public_key_ck
    CHECK (public_key ~ '^[A-Za-z0-9+/]{43}=$'),
  CONSTRAINT work_host_capabilities_ck
    CHECK (jsonb_typeof(capabilities) = 'object')
);

CREATE INDEX work_host_workspace_created_idx
  ON work_host (workspace_id, created_at, id);
CREATE INDEX work_host_workspace_active_idx
  ON work_host (workspace_id, last_seen_at DESC NULLS LAST)
  WHERE revoked_at IS NULL;
CREATE INDEX work_host_owner_active_idx
  ON work_host (owner_member_id, created_at, id)
  WHERE revoked_at IS NULL;

ALTER TABLE work_host ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_host FORCE ROW LEVEL SECURITY;
CREATE POLICY ws_isolation ON work_host
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

ALTER TABLE work_session
  ADD CONSTRAINT work_session_host_fk
  FOREIGN KEY (host_id) REFERENCES work_host(id) NOT VALID;
ALTER TABLE work_session VALIDATE CONSTRAINT work_session_host_fk;

ALTER TABLE work_control
  ADD CONSTRAINT work_control_target_host_fk
  FOREIGN KEY (target_host_id) REFERENCES work_host(id) NOT VALID;
ALTER TABLE work_control VALIDATE CONSTRAINT work_control_target_host_fk;

-- =============================================================================
-- 028_work_tool_profile.sql — MOMO-533 / ADR-0130 D3
--
-- Workspace-owned work tool catalog. The server stores only a portable tool key
-- and argument template. Executable paths and credentials remain host-local.
-- =============================================================================

CREATE FUNCTION momo_work_tool_launch_template_safe(template jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT CASE
    WHEN jsonb_typeof(template->'arguments') <> 'array' THEN false
    ELSE NOT EXISTS (
      SELECT 1
        FROM jsonb_array_elements_text(template->'arguments') AS argument(value)
       WHERE value ~* '(^/|^file:|authorization|bearer|password|secret|token|api[-_]?key)'
          OR value ~ E'[\\n\\r]'
    )
  END;
$$;

CREATE TABLE work_tool_profile (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id     uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  tool_key         text NOT NULL,
  display_name     text NOT NULL,
  launch_template  jsonb NOT NULL,
  tier_defaults    jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled          boolean NOT NULL DEFAULT true,
  created_by       uuid NOT NULL,
  updated_by       uuid NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT work_tool_profile_workspace_tool_uniq UNIQUE (workspace_id, tool_key),
  CONSTRAINT work_tool_profile_tool_key_ck
    CHECK (tool_key ~ '^[a-z0-9][a-z0-9._-]{1,63}$'),
  CONSTRAINT work_tool_profile_display_name_ck
    CHECK (length(btrim(display_name)) BETWEEN 1 AND 80),
  CONSTRAINT work_tool_profile_launch_template_ck CHECK (
    jsonb_typeof(launch_template) = 'object'
    AND launch_template ? 'command'
    AND launch_template ? 'arguments'
    AND launch_template - ARRAY['command', 'arguments']::text[] = '{}'::jsonb
    AND jsonb_typeof(launch_template->'command') = 'string'
    AND launch_template->>'command' ~ '^[a-z0-9][a-z0-9._-]{0,63}$'
    AND jsonb_typeof(launch_template->'arguments') = 'array'
    AND jsonb_array_length(launch_template->'arguments') <= 64
    AND NOT jsonb_path_exists(
      launch_template,
      '$.arguments[*] ? (@.type() != "string")'
    )
    AND momo_work_tool_launch_template_safe(launch_template)
  ),
  CONSTRAINT work_tool_profile_tier_defaults_ck
    CHECK (jsonb_typeof(tier_defaults) = 'object'),
  CONSTRAINT work_tool_profile_created_by_workspace_fk
    FOREIGN KEY (workspace_id, created_by) REFERENCES member(workspace_id, id),
  CONSTRAINT work_tool_profile_updated_by_workspace_fk
    FOREIGN KEY (workspace_id, updated_by) REFERENCES member(workspace_id, id)
);

COMMENT ON TABLE work_tool_profile IS
  'Portable work tool metadata only. Provider credentials, OAuth tokens, environment values, and executable paths are prohibited.';

CREATE INDEX work_tool_profile_workspace_enabled_idx
  ON work_tool_profile (workspace_id, tool_key)
  WHERE enabled;

ALTER TABLE work_tool_profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_tool_profile FORCE ROW LEVEL SECURITY;
CREATE POLICY ws_isolation ON work_tool_profile
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

-- Arbitrary registered tool keys replace the v0 four-value DB whitelist. The
-- REST transaction checks work_tool_profile.enabled before every spawn.
ALTER TABLE work_control DROP CONSTRAINT work_control_payload_ck;
ALTER TABLE work_control ADD CONSTRAINT work_control_payload_ck CHECK (
  jsonb_typeof(payload) = 'object'
  AND CASE kind
    WHEN 'spawn' THEN
      payload ? 'tool'
      AND payload ? 'label'
      AND payload - ARRAY['tool', 'label']::text[] = '{}'::jsonb
      AND jsonb_typeof(payload->'tool') = 'string'
      AND payload->>'tool' ~ '^[a-z0-9][a-z0-9._-]{1,63}$'
      AND jsonb_typeof(payload->'label') = 'string'
      AND length(btrim(payload->>'label')) BETWEEN 1 AND 120
    WHEN 'input' THEN
      payload ? 'text'
      AND payload - ARRAY['text']::text[] = '{}'::jsonb
      AND jsonb_typeof(payload->'text') = 'string'
      AND length(payload->>'text') BETWEEN 1 AND 32768
    WHEN 'read' THEN
      payload - ARRAY['tail_lines']::text[] = '{}'::jsonb
      AND (
        NOT payload ? 'tail_lines'
        OR (
          jsonb_typeof(payload->'tail_lines') = 'number'
          AND payload->>'tail_lines' ~ '^[1-9][0-9]{0,3}$'
        )
      )
    WHEN 'kill' THEN payload = '{}'::jsonb
    ELSE false
  END
);

ALTER TABLE work_auto_approve DROP CONSTRAINT work_auto_approve_tool_ck;
ALTER TABLE work_auto_approve ADD CONSTRAINT work_auto_approve_tool_ck
  CHECK (tool ~ '^[a-z0-9][a-z0-9._-]{1,63}$');

CREATE OR REPLACE FUNCTION momo_seed_work_tool_profiles(
  seed_workspace_id uuid,
  seed_member_id uuid
) RETURNS void
LANGUAGE sql
AS $$
  INSERT INTO work_tool_profile
    (workspace_id, tool_key, display_name, launch_template, tier_defaults,
     enabled, created_by, updated_by)
  VALUES
    (seed_workspace_id, 'claude', 'Claude',
     '{"command":"claude","arguments":[]}'::jsonb, '{}'::jsonb,
     true, seed_member_id, seed_member_id),
    (seed_workspace_id, 'codex', 'Codex',
     '{"command":"codex","arguments":[]}'::jsonb, '{}'::jsonb,
     true, seed_member_id, seed_member_id),
    (seed_workspace_id, 'opencode', 'OpenCode',
     '{"command":"opencode","arguments":[]}'::jsonb, '{}'::jsonb,
     true, seed_member_id, seed_member_id),
    (seed_workspace_id, 'shell', 'Shell',
     '{"command":"sh","arguments":[]}'::jsonb, '{}'::jsonb,
     true, seed_member_id, seed_member_id)
  ON CONFLICT (workspace_id, tool_key) DO NOTHING;
$$;

-- Backfill every existing workspace from its active owner/admin. Workspaces
-- cannot dispatch work before they have a human membership, so an empty legacy
-- workspace intentionally remains without executable profiles.
WITH seed_actor AS (
  SELECT DISTINCT ON (wm.workspace_id) wm.workspace_id, wm.member_id
    FROM workspace_membership wm
    JOIN member m
      ON m.workspace_id = wm.workspace_id
     AND m.id = wm.member_id
     AND m.kind = 'human'
     AND m.status = 'active'
     AND m.deleted_at IS NULL
   WHERE wm.role IN ('owner', 'admin')
   ORDER BY wm.workspace_id,
            CASE wm.role WHEN 'owner' THEN 0 ELSE 1 END,
            wm.joined_at,
            wm.member_id
)
SELECT momo_seed_work_tool_profiles(workspace_id, member_id)
  FROM seed_actor;

CREATE OR REPLACE FUNCTION momo_seed_work_tool_profiles_on_membership()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.role IN ('owner', 'admin') THEN
    PERFORM momo_seed_work_tool_profiles(NEW.workspace_id, NEW.member_id);
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER work_tool_profile_seed_after_membership
AFTER INSERT OR UPDATE OF role ON workspace_membership
FOR EACH ROW EXECUTE FUNCTION momo_seed_work_tool_profiles_on_membership();

-- =============================================================================
-- 026_workspace_membership_lifecycle.sql — ADR-0128 D1/D3
--
-- Workspace roles are independent from per-channel roles. The backfill is
-- idempotent and preserves the strongest effective legacy channel role.
-- =============================================================================

CREATE TABLE IF NOT EXISTS workspace_membership (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id  uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  member_id     uuid NOT NULL,
  role          membership_role NOT NULL DEFAULT 'member',
  joined_at     timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workspace_membership_workspace_member_uniq UNIQUE (workspace_id, member_id),
  CONSTRAINT workspace_membership_member_workspace_fk
    FOREIGN KEY (workspace_id, member_id)
    REFERENCES member(workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS workspace_membership_role_idx
  ON workspace_membership (workspace_id, role, joined_at, member_id);

CREATE TABLE IF NOT EXISTS workspace_ban (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id  uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  email_norm    text,
  handle_norm   text,
  created_by    uuid NOT NULL,
  reason        text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workspace_ban_identity_ck CHECK (email_norm IS NOT NULL OR handle_norm IS NOT NULL),
  CONSTRAINT workspace_ban_email_norm_ck CHECK (email_norm IS NULL OR email_norm = lower(btrim(email_norm))),
  CONSTRAINT workspace_ban_handle_norm_ck CHECK (handle_norm IS NULL OR handle_norm = lower(btrim(handle_norm))),
  CONSTRAINT workspace_ban_created_by_workspace_fk
    FOREIGN KEY (workspace_id, created_by)
    REFERENCES member(workspace_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS workspace_ban_email_uniq
  ON workspace_ban (workspace_id, email_norm)
  WHERE email_norm IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS workspace_ban_handle_uniq
  ON workspace_ban (workspace_id, handle_norm)
  WHERE handle_norm IS NOT NULL;

-- All active legacy channel members become workspace members. An owner/admin
-- channel role maps to workspace admin; member outranks guest.
INSERT INTO workspace_membership (workspace_id, member_id, role, joined_at)
SELECT ms.workspace_id,
       ms.member_id,
       CASE min(CASE ms.role::text
                  WHEN 'owner' THEN 0
                  WHEN 'admin' THEN 1
                  WHEN 'member' THEN 2
                  ELSE 3
                END)
         WHEN 0 THEN 'admin'::membership_role
         WHEN 1 THEN 'admin'::membership_role
         WHEN 2 THEN 'member'::membership_role
         ELSE 'guest'::membership_role
       END,
       min(ms.joined_at)
  FROM membership ms
  JOIN member m
    ON m.workspace_id = ms.workspace_id
   AND m.id = ms.member_id
   AND m.status = 'active'
   AND m.deleted_at IS NULL
 WHERE ms.left_at IS NULL
 GROUP BY ms.workspace_id, ms.member_id
ON CONFLICT (workspace_id, member_id) DO NOTHING;

-- Pick exactly one initial owner per workspace: earliest active channel owner,
-- otherwise earliest channel admin. The final fallback only protects malformed
-- legacy workspaces while preserving owner >= 1 after migration.
WITH ranked AS (
  SELECT wm.workspace_id,
         wm.member_id,
         row_number() OVER (
           PARTITION BY wm.workspace_id
           ORDER BY
             CASE
               WHEN EXISTS (
                 SELECT 1 FROM membership ms
                  WHERE ms.workspace_id = wm.workspace_id
                    AND ms.member_id = wm.member_id
                    AND ms.left_at IS NULL
                    AND ms.role = 'owner'
               ) THEN 0
               WHEN EXISTS (
                 SELECT 1 FROM membership ms
                  WHERE ms.workspace_id = wm.workspace_id
                    AND ms.member_id = wm.member_id
                    AND ms.left_at IS NULL
                    AND ms.role = 'admin'
               ) THEN 1
               ELSE 2
             END,
             (
               SELECT min(ms.joined_at)
                 FROM membership ms
                WHERE ms.workspace_id = wm.workspace_id
                  AND ms.member_id = wm.member_id
                  AND ms.left_at IS NULL
             ),
             wm.member_id
         ) AS owner_rank
    FROM workspace_membership wm
)
UPDATE workspace_membership wm
   SET role = 'owner', updated_at = now()
  FROM ranked r
 WHERE wm.workspace_id = r.workspace_id
   AND wm.member_id = r.member_id
   AND r.owner_rank = 1
   AND NOT EXISTS (
     SELECT 1 FROM workspace_membership existing
      WHERE existing.workspace_id = wm.workspace_id
        AND existing.role = 'owner'
   );

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['workspace_membership', 'workspace_ban'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', t);
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies WHERE schemaname = current_schema()
        AND tablename = t AND policyname = 'ws_isolation'
    ) THEN
      EXECUTE format($f$
        CREATE POLICY ws_isolation ON %I
        USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
        WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);
      $f$, t);
    END IF;
  END LOOP;
END $$;

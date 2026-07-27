-- =============================================================================
-- 044_attachment_drive_file_workspace_unique.sql — MOMO-638 tenant isolation
--
-- 017 created attachment_drive_file_uniq on drive_file_id alone. That made an
-- upload identifier globally unique, so a rejected insert could disclose that
-- another workspace had already referenced the same Drive file. This migration
-- replaces it with uniqueness per (workspace_id, drive_file_id): attachment
-- lifecycle uniqueness remains intact inside a tenant without coupling tenants.
--
-- Before replacing the index, fail closed if an unexpected same-workspace
-- duplicate exists. Do not delete or merge attachment records during a security
-- migration. The migration runner applies this file in one transaction; on a
-- preflight or CREATE INDEX failure the old index remains in place. 017's
-- ENABLE/FORCE RLS policy is intentionally unchanged.
--
-- schema_v0.sql is not touched (migration-only, per the hard rules).
-- =============================================================================

LOCK TABLE attachment IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM attachment
     WHERE drive_file_id IS NOT NULL
     GROUP BY workspace_id, drive_file_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'MOMO-638 refusing attachment unique-index migration: duplicate (workspace_id, drive_file_id) rows exist';
  END IF;
END $$;

DROP INDEX attachment_drive_file_uniq;

CREATE UNIQUE INDEX attachment_workspace_drive_file_uniq
  ON attachment (workspace_id, drive_file_id)
  WHERE drive_file_id IS NOT NULL;

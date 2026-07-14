-- =============================================================================
-- 009_workspace_tenant_rls.sql — MOMO-383 workspace root tenant boundary
--
-- The workspace row is tenant data even though it is the root of the tenant
-- graph. Normal API reads and writes must set app.workspace_id first. Public
-- invite join has a chicken-and-egg lookup, so it receives one narrow primitive:
-- hash an already-normalized bearer code and return only its exact workspace id.
-- =============================================================================

ALTER TABLE workspace ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ws_isolation ON workspace;
CREATE POLICY ws_isolation ON workspace
  USING (id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (id = current_setting('app.workspace_id', true)::uuid);

-- Exact creation is deliberate. A pre-existing schema or function means the
-- trusted owner/definition boundary has drifted, so the migration must abort
-- transactionally instead of adopting or replacing that object.
CREATE SCHEMA momo_join_private;
REVOKE ALL ON SCHEMA momo_join_private FROM PUBLIC;

CREATE FUNCTION momo_join_private.invite_workspace_id(raw_code text)
RETURNS uuid
LANGUAGE sql
STABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT i.workspace_id
    FROM public.invite_code AS i
    JOIN public.workspace AS w
      ON w.id = i.workspace_id
     AND w.deleted_at IS NULL
   WHERE i.code_hash = public.digest(raw_code, 'sha256')
   LIMIT 1;
$$;

COMMENT ON FUNCTION momo_join_private.invite_workspace_id(text) IS
  'Join preflight only: maps one normalized raw invite code to its exact workspace UUID; returns no tenant row data.';

REVOKE ALL ON FUNCTION momo_join_private.invite_workspace_id(text) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_relay') THEN
    REVOKE ALL ON SCHEMA momo_join_private FROM momo_relay;
    REVOKE ALL ON FUNCTION momo_join_private.invite_workspace_id(text) FROM momo_relay;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_worker') THEN
    REVOKE ALL ON SCHEMA momo_join_private FROM momo_worker;
    REVOKE ALL ON FUNCTION momo_join_private.invite_workspace_id(text) FROM momo_worker;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_platform_admin') THEN
    REVOKE ALL ON SCHEMA momo_join_private FROM momo_platform_admin;
    REVOKE ALL ON FUNCTION momo_join_private.invite_workspace_id(text) FROM momo_platform_admin;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_app') THEN
    GRANT USAGE ON SCHEMA momo_join_private TO momo_app;
    GRANT EXECUTE ON FUNCTION momo_join_private.invite_workspace_id(text) TO momo_app;
  END IF;
END $$;

-- 037_prod_runtime_role_posture.sql — MOMO-554
-- The global catalog is seeded and upgraded only by migrations. The API role
-- retains SELECT through the general table grant but cannot mutate catalog rows.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_app') THEN
    REVOKE INSERT, UPDATE, DELETE ON TABLE plugin_registry FROM momo_app;
  END IF;
END
$$;

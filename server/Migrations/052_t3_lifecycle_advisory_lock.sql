-- =============================================================================
-- 052_t3_lifecycle_advisory_lock.sql — MOMO-666 / ADR-0140 D2 C
--
-- T3 lifecycle writers keep their existing row-lock order during the T-2
-- safety-net stage. This transaction-scoped host lock serializes those writers
-- before they can enter the mismatched row-lock ladders.
--
-- The two-int advisory key separates the momo T3 namespace from unrelated
-- advisory users and hashes the canonical lowercase UUID text. Callers that
-- touch multiple cloud hosts must call this function in cloud-host-id ascending
-- order. T1/T2 callers have no work_cloud_host id and must not call it.
-- =============================================================================

CREATE FUNCTION acquire_t3_lifecycle_lock(p_cloud_host_id uuid)
RETURNS void
LANGUAGE plpgsql
STRICT
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtext('momo.t3'),
    hashtext(lower(p_cloud_host_id::text))
  );
END $$;

COMMENT ON FUNCTION acquire_t3_lifecycle_lock(uuid) IS
  'ADR-0140 host-scoped T3 lifecycle serialization; acquire first and in cloud-host UUID ascending order.';

-- =============================================================================
-- 050_t3_unsettled_usage_repair.sql — MOMO-665 / ADR-0140 migration escape hatch
--
-- Migration 049 installs the settlement primitive before migration 051 enforces
-- host-level uniqueness. This operator-only entrypoint repairs every unsettled
-- session on a violating host without copying settlement logic.
-- =============================================================================

CREATE FUNCTION repair_t3_duplicate_unsettled_usage()
RETURNS TABLE (
  host_id uuid,
  usage_count bigint,
  session_id uuid,
  settled boolean
)
LANGUAGE plpgsql AS $$
DECLARE
  v_usage record;
BEGIN
  -- ORDER BY materializes the complete diagnostic set before settlement changes
  -- any row. The returned host/count pair is therefore the pre-repair evidence.
  FOR v_usage IN
    SELECT usage.workspace_id,
           usage.host_id,
           duplicates.usage_count,
           usage.session_id
      FROM work_host_usage AS usage
      JOIN (
        SELECT candidate.host_id, count(*) AS usage_count
          FROM work_host_usage AS candidate
         WHERE candidate.settled_at IS NULL
         GROUP BY candidate.host_id
        HAVING count(*) > 1
      ) AS duplicates
        ON duplicates.host_id = usage.host_id
     WHERE usage.settled_at IS NULL
     ORDER BY usage.host_id, usage.session_id
  LOOP
    host_id := v_usage.host_id;
    usage_count := v_usage.usage_count;
    session_id := v_usage.session_id;
    settled := settle_t3_work_session(v_usage.workspace_id, v_usage.session_id);

    IF NOT settled THEN
      RAISE EXCEPTION
        'T3 unsettled usage repair could not settle session % on host %',
        lower(v_usage.session_id::text),
        lower(v_usage.host_id::text);
    END IF;

    RETURN NEXT;
  END LOOP;
END $$;

REVOKE ALL ON FUNCTION repair_t3_duplicate_unsettled_usage() FROM PUBLIC;

COMMENT ON FUNCTION repair_t3_duplicate_unsettled_usage() IS
  'Operator-only MOMO-665 repair. Returns pre-repair host counts and delegates each session to settle_t3_work_session.';

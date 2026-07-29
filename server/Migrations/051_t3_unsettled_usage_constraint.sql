-- =============================================================================
-- 051_t3_unsettled_usage_constraint.sql — MOMO-665 / ADR-0140 fail-closed gate
--
-- Do not discard ambiguous billing evidence. Migration 050 installs the
-- operator repair entrypoint; this migration names every remaining violating
-- host and refuses to add the v0 uniqueness constraint until repair completes.
-- =============================================================================

DO $$
DECLARE
  v_duplicate_hosts text;
BEGIN
  SELECT string_agg(
           lower(host_id::text) || ' (' || usage_count || ')',
           ', ' ORDER BY host_id
         )
    INTO v_duplicate_hosts
    FROM (
      SELECT host_id, count(*) AS usage_count
        FROM work_host_usage
       WHERE settled_at IS NULL
       GROUP BY host_id
      HAVING count(*) > 1
    ) duplicates;

  IF v_duplicate_hosts IS NOT NULL THEN
    RAISE EXCEPTION
      'cannot enforce one unsettled T3 usage per host; violating host(s): %; run docs/runbooks/t3-unsettled-usage-repair.md, then retry migration',
      v_duplicate_hosts;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS work_host_usage_one_unsettled_per_host_idx
  ON work_host_usage (host_id)
  WHERE settled_at IS NULL;

COMMENT ON INDEX work_host_usage_one_unsettled_per_host_idx IS
  'v0 one paid session per cloud host; prevents double billing and sandbox-wide pause races.';

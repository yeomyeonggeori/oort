-- =============================================================================
-- 054_work_session_host_reconciliation.sql — MOMO-656 / #870
--
-- A work host daemon that restarts faster than `MOMO_HOST_OFFLINE_GRACE_S`
-- keeps its `work_host.last_seen_at` fresh, so the ADR-0125 D11 offline sweep
-- never sees it as lost. Its in-memory PTYs and replay ring buffers are gone
-- all the same, so the ledger keeps advertising running/idle sessions that no
-- longer have anything to attach to.
--
-- `host_lost_at` is the host's own explicit statement that it cannot revive a
-- session. It is a sweep *eligibility marker*, not a new lifecycle state: the
-- sweep still owns the orphaned transition, the resume card, the lineage, and
-- the auto/t1_only tier policy. Same precedent as the cloud path in
-- `recordMissingCloudSandbox`, which backdates `last_seen_at` to hand a dead
-- host to the same sweep — that trick cannot be used here because the daemon
-- is alive and must keep heartbeating for new sessions.
--
-- end_reason is deliberately NOT extended with a new value. A host-reported
-- loss and a swept host loss are the same fact for the user ("the host lost
-- your session, resume elsewhere?"), and `work_session_end_reason_ck` values
-- are rendered by macOS/iOS/web clients; a new value would be an unrendered
-- UX invention. The provenance distinction lives in `audit_log`
-- (`momo.work_session.host_lost.v1` + `orphan_source` on the orphan audit).
-- =============================================================================

ALTER TABLE work_session
  ADD COLUMN host_lost_at timestamptz;

COMMENT ON COLUMN work_session.host_lost_at IS
  'MOMO-656 host-signed reconciliation marker: the owning daemon reported it cannot revive this session. Makes the row immediately eligible for the ADR-0125 D11 orphan sweep regardless of work_host.last_seen_at; cleared by the sweep when it transitions the row.';

-- Partial index mirrors the sweep predicate: only marked, still-live rows.
CREATE INDEX work_session_host_lost_idx
  ON work_session (host_lost_at, id)
  WHERE host_lost_at IS NOT NULL AND status IN ('running', 'idle');

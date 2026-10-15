-- =============================================================================
-- 132_agent_run_event_doorbell_rung.sql — #3822 / ADR-0200 증보 2026-10-14
--
-- One new closed ledger kind, `doorbell_rung`: the doorbell sender (ADR-0171) records,
-- on every run that is still waiting to be claimed, that it sent the wake signal and
-- how it ended. The `code` carries ONE closed token `<edge>_<result>`:
--   edge   = leading | trailing | urgent   (urgent = an agent_job event that skipped
--            the cooldown window, #3822)
--   result = ok | failed                   (no HTTP status, host or reason: those stay
--            on hosted_agent_doorbell.last_status and the audit log)
-- Both fit the existing `agent_run_event_code_ck` (^[a-z0-9_]{1,64}$).
--
-- The row is written by the sender through the existing agent_run_event_append()
-- (SECURITY INVOKER, takes no lock). Nothing else changes: same table, same RLS FORCE,
-- same append-only trigger. Only the CHECK vocabulary grows.
-- =============================================================================

ALTER TABLE agent_run_event DROP CONSTRAINT agent_run_event_kind_ck;
ALTER TABLE agent_run_event ADD CONSTRAINT agent_run_event_kind_ck CHECK (kind IN (
  'queued', 'claimed', 'started', 'stage', 'paused', 'resumed',
  'approval_requested', 'approval_decided',
  'succeeded', 'failed', 'timed_out', 'cancelled',
  'doorbell_rung'
));

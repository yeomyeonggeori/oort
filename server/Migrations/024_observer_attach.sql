-- =============================================================================
-- 024_observer_attach.sql — MOMO-516 / ADR-0126 D1
--
-- Observation remains a capability-control-plane concern. Raw terminal bytes
-- still flow directly between client and host and never enter this ledger.
-- Existing grants and sessions retain the controller/open defaults.
-- =============================================================================

ALTER TABLE work_session
  ADD COLUMN observation text NOT NULL DEFAULT 'open',
  ADD CONSTRAINT work_session_observation_ck
    CHECK (observation IN ('open', 'owner_only'));

ALTER TABLE terminal_attach_capability
  ADD COLUMN mode text NOT NULL DEFAULT 'controller',
  ADD CONSTRAINT terminal_attach_capability_mode_ck
    CHECK (mode IN ('controller', 'observer'));

CREATE INDEX terminal_attach_observer_expiry_idx
  ON terminal_attach_capability (work_session_id, expires_at DESC)
  WHERE mode = 'observer';

-- =============================================================================
-- 057_t3_lifecycle_deadline.sql — MOMO-668 / ADR-0140 D4 (T-4 convergence)
--
-- Three things a `*ing` cloud host could not previously say about itself:
--
--   1. *when it stops being allowed to stay there*. A durable intent without a
--      deadline is the permanent deadlock the second adversarial review found:
--      nothing in the row tells a reconciler that waiting is no longer the
--      right move. The deadline is now structural — a BEFORE trigger fills the
--      canonical bound when a writer omits it and a CHECK makes the omission
--      unrepresentable, so `*ing` without a deadline cannot exist even if a
--      future code path forgets. (Regular code enforcement is what every
--      previous round broke; ADR-0140 Context.)
--   2. *how many times it has already been attempted*, which is what an
--      exponential backoff needs. `destroy_pending` is the one intent that
--      never gives up (ADR-0140 D4) — without a counter the alternative to
--      giving up is a hot retry loop against a paid provider.
--   3. *whether an in-flight provider response still belongs to it*. The
--      revalidation predicate lives in the database (below) rather than in two
--      Swift copies: MomoServer and NotifierWorker both call providers, and
--      the T3LifecycleLock precedent shows what per-package copies do to a
--      rule over time.
--
-- Two convergence transitions are added to the ADR-0140 D1 table. They were
-- absent because, before T-4, an intent that failed had nowhere to go:
--   pausing  -> running  the sandbox was not stopped, so it is still burning
--                        resources and must still be billed (ADR-0140 D4:
--                        "사실에 맞는 쪽").
--   resuming -> paused   the sandbox was not resumed, so no interval opens.
--
-- Migrations 052 and 053 are untouched. t3_terminate keeps writing
-- `destroy_pending` with no deadline of its own; the trigger below supplies
-- the canonical one, which is why sealing this invariant did not require
-- reopening the sealed settlement statement.
-- =============================================================================

ALTER TABLE work_cloud_host
  ADD COLUMN lifecycle_operation_deadline_at timestamptz,
  ADD COLUMN lifecycle_operation_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN lifecycle_operation_next_attempt_at timestamptz;

COMMENT ON COLUMN work_cloud_host.lifecycle_operation_deadline_at IS
  'ADR-0140 D4 intent deadline. After it passes the reconciler asks the provider for the fact instead of waiting.';
COMMENT ON COLUMN work_cloud_host.lifecycle_operation_attempts IS
  'ADR-0140 D4 provider attempt count for this operation; drives the destroy backoff.';
COMMENT ON COLUMN work_cloud_host.lifecycle_operation_next_attempt_at IS
  'ADR-0140 D4 earliest next claim. NULL means claimable as soon as the claim delay passes.';

-- Canonical bounds. A pause/resume that has not answered inside two minutes is
-- not going to; a destroy is given longer because it is retried forever and a
-- shorter bound would only add provider load without changing the outcome.
CREATE FUNCTION t3_lifecycle_default_deadline(p_kind text)
RETURNS interval
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_kind
           WHEN 'destroy' THEN interval '300 seconds'
           ELSE interval '120 seconds'
         END
$$;

COMMENT ON FUNCTION t3_lifecycle_default_deadline(text) IS
  'ADR-0140 D4 canonical upper bound for one T3 lifecycle operation, by intent kind.';

-- Doubling, capped. The cap matters more than the curve: destroy never gives
-- up, so an uncapped exponent would eventually stop retrying in practice.
CREATE FUNCTION t3_lifecycle_backoff(p_attempts integer)
RETURNS interval
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT least(
    interval '300 seconds',
    interval '5 seconds' * power(2, least(greatest(p_attempts, 0), 8))
  )
$$;

COMMENT ON FUNCTION t3_lifecycle_backoff(integer) IS
  'ADR-0140 D4 exponential retry spacing for durable lifecycle intents, capped at 300s.';

-- Backfill before the CHECK: rows already sitting in an intermediate state
-- predate the rule and get the bound they would have been given, measured from
-- the start they already recorded rather than from now — a row that has been
-- stuck for an hour is due immediately, which is the honest reading.
UPDATE work_cloud_host
   SET lifecycle_operation_deadline_at =
         COALESCE(lifecycle_operation_started_at, updated_at, now())
         + t3_lifecycle_default_deadline(
             COALESCE(lifecycle_operation_kind, 'pause')
           )
 WHERE state IN ('pausing', 'resuming', 'destroy_pending')
   AND lifecycle_operation_deadline_at IS NULL;

CREATE FUNCTION fill_work_cloud_host_deadline()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state IN ('pausing', 'resuming', 'destroy_pending') THEN
    -- A writer that starts a different operation either supplies its own
    -- deadline or accepts the canonical one; a writer that only touches
    -- unrelated columns keeps the deadline the operation already had. The
    -- second disjunct is what stops a fresh destroy intent from inheriting the
    -- already-expired deadline of the pause it replaced.
    IF NEW.lifecycle_operation_deadline_at IS NULL
       OR (TG_OP = 'UPDATE'
           AND (NEW.lifecycle_operation_id
                  IS DISTINCT FROM OLD.lifecycle_operation_id
                OR NEW.lifecycle_operation_kind
                     IS DISTINCT FROM OLD.lifecycle_operation_kind)
           AND NEW.lifecycle_operation_deadline_at
                 IS NOT DISTINCT FROM OLD.lifecycle_operation_deadline_at)
    THEN
      NEW.lifecycle_operation_deadline_at :=
        COALESCE(NEW.lifecycle_operation_started_at, clock_timestamp())
        + t3_lifecycle_default_deadline(
            COALESCE(NEW.lifecycle_operation_kind, 'pause')
          );
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER work_cloud_host_deadline_default
BEFORE INSERT OR UPDATE ON work_cloud_host
FOR EACH ROW EXECUTE FUNCTION fill_work_cloud_host_deadline();

ALTER TABLE work_cloud_host
  ADD CONSTRAINT work_cloud_host_deadline_ck CHECK (
    state NOT IN ('pausing', 'resuming', 'destroy_pending')
    OR lifecycle_operation_deadline_at IS NOT NULL
  ),
  ADD CONSTRAINT work_cloud_host_attempts_ck CHECK (
    lifecycle_operation_attempts >= 0
  );

INSERT INTO work_cloud_host_transition (from_state, to_state, kind)
VALUES
  ('pausing'::text, 'running'::text, 'pause_abandoned'::text),
  ('resuming'::text, 'paused'::text, 'resume_abandoned'::text);

-- ADR-0140 D4 ③. The provider call deliberately happens outside PostgreSQL, so
-- the response that comes back may belong to an intent that no longer exists:
-- a sweep terminated the session, the reconciler re-claimed the operation, or
-- the user started a different one. Applying such a response is precisely the
-- second-review defect ("낡은 결과가 종속 상태를 바꾼다"), and the state
-- machine alone does not stop it — re-entering the same `*ing` state under a
-- different operation makes the stale write a *legal* transition.
--
-- The row lock taken here is ladder stage 2 and is held for the rest of the
-- caller's transaction, which is what lets the caller's confirming UPDATE key
-- on the primary key alone: nothing can change between this answer and that
-- write.
CREATE FUNCTION t3_lifecycle_intent_is_current(
  p_cloud_host_id uuid,
  p_operation_id uuid,
  p_version bigint,
  p_expected_state text
) RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE
  v_state text;
  v_operation_id uuid;
  v_version bigint;
BEGIN
  SELECT state, lifecycle_operation_id, lifecycle_operation_version
    INTO v_state, v_operation_id, v_version
    FROM work_cloud_host
   WHERE id = p_cloud_host_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  RETURN v_state IS NOT DISTINCT FROM p_expected_state
     AND v_operation_id IS NOT DISTINCT FROM p_operation_id
     AND v_version IS NOT DISTINCT FROM p_version;
END $$;

COMMENT ON FUNCTION t3_lifecycle_intent_is_current(uuid, uuid, bigint, text) IS
  'ADR-0140 D4 stale-response guard: locks the cloud host and reports whether (operation_id, version, state) still match the intent a provider response was issued for.';

-- One durable claim: bump the version so any response still in flight for the
-- previous version is recognizably stale, count the attempt, and push the next
-- claim out by the backoff. Returns the row the caller must act on, or nothing
-- when another worker got there first.
CREATE FUNCTION t3_claim_lifecycle_operation(
  p_cloud_host_id uuid,
  p_claim_delay interval
) RETURNS TABLE (
  workspace_id uuid,
  host_id uuid,
  provider text,
  provider_sandbox_id text,
  state text,
  lifecycle_operation_id uuid,
  lifecycle_operation_kind text,
  lifecycle_operation_version bigint,
  lifecycle_operation_attempts integer,
  deadline_exceeded boolean,
  requested_display_name text
)
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM acquire_t3_lifecycle_lock(p_cloud_host_id);

  RETURN QUERY
  WITH claimed AS (
    UPDATE work_cloud_host AS h
       SET lifecycle_operation_attempts = h.lifecycle_operation_attempts + 1,
           lifecycle_operation_version = h.lifecycle_operation_version + 1,
           lifecycle_operation_next_attempt_at =
             clock_timestamp()
             + t3_lifecycle_backoff(h.lifecycle_operation_attempts + 1),
           updated_at = clock_timestamp()
     WHERE h.id = p_cloud_host_id
       AND h.state IN ('pausing', 'resuming', 'destroy_pending')
       AND COALESCE(
             h.lifecycle_operation_next_attempt_at,
             h.lifecycle_operation_started_at + p_claim_delay
           ) <= clock_timestamp()
    RETURNING h.workspace_id AS c_workspace_id,
              h.host_id AS c_host_id,
              h.provider AS c_provider,
              h.provider_sandbox_id AS c_sandbox_id,
              h.state AS c_state,
              h.lifecycle_operation_id AS c_operation_id,
              h.lifecycle_operation_kind AS c_operation_kind,
              h.lifecycle_operation_version AS c_version,
              h.lifecycle_operation_attempts AS c_attempts,
              (h.lifecycle_operation_deadline_at <= clock_timestamp())
                AS c_deadline_exceeded,
              h.requested_display_name AS c_display_name
  )
  SELECT c_workspace_id, c_host_id, c_provider, c_sandbox_id, c_state,
         c_operation_id, c_operation_kind, c_version, c_attempts,
         c_deadline_exceeded, c_display_name
    FROM claimed;
END $$;

COMMENT ON FUNCTION t3_claim_lifecycle_operation(uuid, interval) IS
  'ADR-0140 D4 durable intent claim: advisory lock, version bump (stale-response marker), attempt count, and backoff scheduling.';

CREATE INDEX work_cloud_host_lifecycle_due_idx
  ON work_cloud_host (
    COALESCE(lifecycle_operation_next_attempt_at, lifecycle_operation_started_at),
    id
  )
  WHERE state IN ('pausing', 'resuming', 'destroy_pending');

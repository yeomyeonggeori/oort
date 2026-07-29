-- =============================================================================
-- 053_t3_lifecycle_canonicalization.sql — MOMO-667 / ADR-0140 D1-D3
--
-- Canonicalize T3 termination behind one database statement, seal settled_at
-- against direct writes, enforce the cloud-host state machine, and align the
-- shared row-lock ladder. The generated pause-accounting rule from migration
-- 045 remains unchanged.
-- =============================================================================

ALTER TABLE work_host_usage
  ADD COLUMN settled_reason text,
  ADD CONSTRAINT work_host_usage_settled_reason_ck CHECK (
    settled_reason IS NULL
    OR settled_reason IN (
      'ended', 'idle_timeout', 'orphaned', 'provider_missing', 'destroyed'
    )
  );

COMMENT ON COLUMN work_host_usage.settled_reason IS
  'ADR-0140 canonical first settlement reason. NULL is retained only for rows settled before migration 053.';

-- These are the transitions performed by the current REST, usage-ledger, and
-- lifecycle-reconciler code. Same-state metadata updates bypass the lookup.
CREATE TABLE work_cloud_host_transition (
  from_state text NOT NULL,
  to_state   text NOT NULL,
  kind       text NOT NULL,
  PRIMARY KEY (from_state, to_state)
);

INSERT INTO work_cloud_host_transition (from_state, to_state, kind)
VALUES
  ('provisioning'::text, 'ready'::text, 'provisioning_complete'::text),
  ('ready'::text, 'running'::text, 'session_start'::text),
  ('running'::text, 'pausing'::text, 'pause_intent'::text),
  ('pausing'::text, 'paused'::text, 'pause_confirmed'::text),
  ('paused'::text, 'resuming'::text, 'resume_intent'::text),
  ('resuming'::text, 'running'::text, 'resume_confirmed'::text),
  ('ready'::text, 'destroy_pending'::text, 'destroy_intent'::text),
  ('running'::text, 'destroy_pending'::text, 'destroy_intent'::text),
  ('pausing'::text, 'destroy_pending'::text, 'destroy_intent'::text),
  ('paused'::text, 'destroy_pending'::text, 'destroy_intent'::text),
  ('resuming'::text, 'destroy_pending'::text, 'destroy_intent'::text),
  ('destroy_pending'::text, 'destroyed'::text, 'destroy_confirmed'::text);

COMMENT ON TABLE work_cloud_host_transition IS
  'ADR-0140 D1 canonical transitions reverse-engineered from current REST, ledger, and reconciler writes.';

CREATE FUNCTION enforce_work_cloud_host_transition()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state IS DISTINCT FROM NEW.state
     AND NOT EXISTS (
       SELECT 1
         FROM work_cloud_host_transition AS allowed_transition
        WHERE allowed_transition.from_state = OLD.state
          AND allowed_transition.to_state = NEW.state
     )
  THEN
    RAISE EXCEPTION
      'illegal cloud host transition % -> %', OLD.state, NEW.state
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER work_cloud_host_transition_guard
BEFORE UPDATE ON work_cloud_host
FOR EACH ROW EXECUTE FUNCTION enforce_work_cloud_host_transition();

CREATE FUNCTION enforce_t3_settlement_entrypoint()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.settled_at IS NULL
     AND NEW.settled_at IS NOT NULL
     AND current_setting('momo.t3_settlement', true) IS DISTINCT FROM 'on'
  THEN
    RAISE EXCEPTION 't3 settlement must go through t3_terminate'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER work_host_usage_settlement_guard
BEFORE UPDATE ON work_host_usage
FOR EACH ROW EXECUTE FUNCTION enforce_t3_settlement_entrypoint();

-- Lock order after the caller's first-statement host advisory:
-- workspace_credit -> work_cloud_host -> usage(+interval) -> session -> host.
-- The initial lookup takes no row lock and only resolves the already-advisory-
-- protected cloud host. Re-acquiring the advisory is harmless and protects
-- operator/shim calls that do not pass through a Swift lifecycle prelude.
CREATE FUNCTION t3_terminate(
  p_workspace_id uuid,
  p_session_id uuid,
  p_reason text
) RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE
  v_usage_id uuid;
  v_host_id uuid;
  v_cloud_host_id uuid;
  v_unit_rate bigint;
  v_active_seconds bigint;
  v_debit bigint;
  v_settled_at timestamptz;
  v_previous_settlement text;
BEGIN
  IF p_reason IS NULL
     OR p_reason NOT IN (
       'ended', 'idle_timeout', 'orphaned', 'provider_missing', 'destroyed'
     )
  THEN
    RAISE EXCEPTION 'invalid t3 termination reason: %', p_reason
      USING ERRCODE = '23514';
  END IF;

  SELECT usage.id,
         usage.host_id,
         cloud.id,
         usage.unit_rate_micro_usd_second
    INTO v_usage_id, v_host_id, v_cloud_host_id, v_unit_rate
    FROM work_host_usage AS usage
    LEFT JOIN work_cloud_host AS cloud
      ON cloud.workspace_id = usage.workspace_id
     AND cloud.host_id = usage.host_id
   WHERE usage.workspace_id = p_workspace_id
     AND usage.session_id = p_session_id;

  IF v_usage_id IS NULL THEN
    RETURN false;
  END IF;
  IF v_cloud_host_id IS NULL THEN
    RAISE EXCEPTION
      't3 usage % has no cloud host', lower(v_usage_id::text)
      USING ERRCODE = '23514';
  END IF;

  PERFORM acquire_t3_lifecycle_lock(v_cloud_host_id);

  PERFORM 1
    FROM workspace_credit
   WHERE workspace_id = p_workspace_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      't3 workspace credit ledger missing for workspace %',
      lower(p_workspace_id::text)
      USING ERRCODE = '23514';
  END IF;

  PERFORM 1
    FROM work_cloud_host
   WHERE workspace_id = p_workspace_id
     AND id = v_cloud_host_id
   FOR UPDATE;

  SELECT settled_at, unit_rate_micro_usd_second
    INTO v_settled_at, v_unit_rate
    FROM work_host_usage
   WHERE id = v_usage_id
   FOR UPDATE;

  PERFORM 1
    FROM work_host_usage_interval
   WHERE usage_id = v_usage_id
   ORDER BY id
   FOR UPDATE;

  PERFORM 1
    FROM work_session
   WHERE workspace_id = p_workspace_id
     AND id = p_session_id
   FOR UPDATE;

  IF v_settled_at IS NOT NULL THEN
    RETURN true;
  END IF;

  UPDATE work_host_usage_interval
     SET ended_at = clock_timestamp()
   WHERE usage_id = v_usage_id
     AND ended_at IS NULL;

  SELECT COALESCE(sum(active_seconds), 0)::bigint
    INTO v_active_seconds
    FROM work_host_usage_interval
   WHERE usage_id = v_usage_id;

  v_debit := v_active_seconds * v_unit_rate;
  v_previous_settlement := current_setting('momo.t3_settlement', true);
  PERFORM set_config('momo.t3_settlement', 'on', true);

  UPDATE work_host_usage
     SET ended_at = clock_timestamp(),
         active_seconds = v_active_seconds,
         settled_at = clock_timestamp(),
         settled_reason = p_reason
   WHERE id = v_usage_id
     AND settled_at IS NULL;

  PERFORM set_config(
    'momo.t3_settlement',
    COALESCE(v_previous_settlement, ''),
    true
  );

  IF v_debit > 0 THEN
    INSERT INTO credit_entry
      (workspace_id, delta_micro_usd, reason, ref_id)
    VALUES
      (p_workspace_id, -v_debit, 't3_usage', p_session_id)
    ON CONFLICT (workspace_id, reason, ref_id) DO NOTHING;
  END IF;

  UPDATE work_cloud_host
     SET state = CASE
           WHEN state = 'destroyed' THEN state
           ELSE 'destroy_pending'
         END,
         lifecycle_operation_id = CASE
           WHEN state = 'destroyed' THEN lifecycle_operation_id
           ELSE COALESCE(lifecycle_operation_id, uuidv7())
         END,
         lifecycle_operation_kind = CASE
           WHEN state = 'destroyed' THEN lifecycle_operation_kind
           ELSE 'destroy'
         END,
         lifecycle_operation_started_at = CASE
           WHEN state = 'destroyed' THEN lifecycle_operation_started_at
           ELSE COALESCE(lifecycle_operation_started_at, clock_timestamp())
         END,
         lifecycle_operation_version = lifecycle_operation_version + 1,
         updated_at = clock_timestamp()
   WHERE workspace_id = p_workspace_id
     AND id = v_cloud_host_id;

  UPDATE work_host
     SET revoked_at = COALESCE(revoked_at, clock_timestamp())
   WHERE workspace_id = p_workspace_id
     AND id = v_host_id;

  RETURN true;
END $$;

COMMENT ON FUNCTION t3_terminate(uuid, uuid, text) IS
  'ADR-0140 idempotent T3 termination: credit/cloud/usage/session/host lock ladder, first-reason settlement, and durable destroy intent.';

-- Compatibility is deliberate: databases and operator tooling that still know
-- the 049 symbol retain behavior, while every in-repo runtime caller moves to
-- t3_terminate with an explicit reason.
CREATE OR REPLACE FUNCTION settle_t3_work_session(
  p_workspace_id uuid,
  p_session_id uuid
) RETURNS boolean
LANGUAGE plpgsql AS $$
BEGIN
  RETURN t3_terminate(p_workspace_id, p_session_id, 'destroyed');
END $$;

COMMENT ON FUNCTION settle_t3_work_session(uuid, uuid) IS
  'Compatibility shim for migration 049 callers; new code must call t3_terminate with an explicit reason.';

CREATE OR REPLACE FUNCTION repair_t3_duplicate_unsettled_usage()
RETURNS TABLE (
  host_id uuid,
  usage_count bigint,
  session_id uuid,
  settled boolean
)
LANGUAGE plpgsql AS $$
DECLARE
  v_cloud_host_id uuid;
  v_usage record;
BEGIN
  -- Acquire every affected host advisory in canonical UUID order before taking
  -- any lifecycle row lock. The diagnostic SELECT below remains pre-repair.
  FOR v_cloud_host_id IN
    SELECT DISTINCT cloud.id
      FROM work_host_usage AS usage
      JOIN work_cloud_host AS cloud
        ON cloud.workspace_id = usage.workspace_id
       AND cloud.host_id = usage.host_id
     WHERE usage.settled_at IS NULL
       AND usage.host_id IN (
         SELECT candidate.host_id
           FROM work_host_usage AS candidate
          WHERE candidate.settled_at IS NULL
          GROUP BY candidate.host_id
         HAVING count(*) > 1
       )
     ORDER BY cloud.id
  LOOP
    PERFORM acquire_t3_lifecycle_lock(v_cloud_host_id);
  END LOOP;

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
    settled := t3_terminate(
      v_usage.workspace_id,
      v_usage.session_id,
      'destroyed'
    );

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
  'Operator-only MOMO-665 repair. Delegates each duplicate session to t3_terminate(reason=destroyed).';

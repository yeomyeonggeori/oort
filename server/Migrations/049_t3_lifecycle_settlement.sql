-- =============================================================================
-- 049_t3_lifecycle_settlement.sql — #876 + #877 + #878
--
-- Durable provider intents are committed before an external E2B call. Terminal
-- settlement is a single database primitive shared by REST and the notifier
-- sweep. Provider destroy remains an out-of-transaction, retryable operation.
-- schema_v0.sql remains unchanged.
-- =============================================================================

ALTER TABLE work_cloud_host DROP CONSTRAINT work_cloud_host_state_ck;
ALTER TABLE work_cloud_host
  ADD COLUMN create_idempotency_key uuid,
  ADD COLUMN requested_display_name text,
  ADD COLUMN lifecycle_operation_id uuid,
  ADD COLUMN lifecycle_operation_kind text,
  ADD COLUMN lifecycle_operation_version bigint NOT NULL DEFAULT 0,
  ADD COLUMN lifecycle_operation_started_at timestamptz,
  ADD CONSTRAINT work_cloud_host_state_ck CHECK (
    state IN (
      'provisioning', 'ready', 'running', 'pausing', 'paused', 'resuming',
      'destroy_pending', 'destroyed', 'failed'
    )
  ),
  ADD CONSTRAINT work_cloud_host_display_name_ck CHECK (
    requested_display_name IS NULL
    OR char_length(requested_display_name) BETWEEN 1 AND 80
  ),
  ADD CONSTRAINT work_cloud_host_operation_ck CHECK (
    (lifecycle_operation_id IS NULL
      AND lifecycle_operation_kind IS NULL
      AND lifecycle_operation_started_at IS NULL)
    OR
    (lifecycle_operation_id IS NOT NULL
      AND lifecycle_operation_kind IN ('pause', 'resume', 'destroy')
      AND lifecycle_operation_started_at IS NOT NULL)
  );

CREATE UNIQUE INDEX work_cloud_host_create_idempotency_idx
  ON work_cloud_host (workspace_id, create_idempotency_key)
  WHERE create_idempotency_key IS NOT NULL;

-- Close the interval, finalize active seconds, append the debit exactly once,
-- free the paid slot, revoke the host, and leave a durable destroy intent. The
-- generated active_seconds from migration 045 remains the sole pause-accounting
-- rule; this function never subtracts pause wall time.
CREATE FUNCTION settle_t3_work_session(
  p_workspace_id uuid,
  p_session_id uuid
) RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE
  v_usage_id uuid;
  v_host_id uuid;
  v_unit_rate bigint;
  v_active_seconds bigint;
  v_debit bigint;
BEGIN
  SELECT id, host_id, unit_rate_micro_usd_second
    INTO v_usage_id, v_host_id, v_unit_rate
    FROM work_host_usage
   WHERE workspace_id = p_workspace_id
     AND session_id = p_session_id
   FOR UPDATE;

  IF v_usage_id IS NULL THEN
    RETURN false;
  END IF;

  IF EXISTS (
    SELECT 1 FROM work_host_usage
     WHERE id = v_usage_id AND settled_at IS NOT NULL
  ) THEN
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

  UPDATE work_host_usage
     SET ended_at = clock_timestamp(),
         active_seconds = v_active_seconds,
         settled_at = clock_timestamp()
   WHERE id = v_usage_id
     AND settled_at IS NULL;

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
     AND host_id = v_host_id;

  UPDATE work_host
     SET revoked_at = COALESCE(revoked_at, clock_timestamp())
   WHERE workspace_id = p_workspace_id
     AND id = v_host_id;

  RETURN true;
END $$;

COMMENT ON FUNCTION settle_t3_work_session(uuid, uuid) IS
  'Idempotent T3 terminal settlement and durable provider-destroy intent.';

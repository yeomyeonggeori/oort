-- =============================================================================
-- 058_t3_interval_micro_precision.sql — MOMO-661 ① / #879
--
-- Migration 045 generated `work_host_usage_interval.active_seconds` by flooring
-- *each* interval (045:66-72). Settlement then summed those floors, so every
-- pause boundary silently discarded up to one second. A session that pauses and
-- resumes twelve times loses up to twelve seconds; the ledger is systematically
-- wrong in the user's favour, and the same structure produces the opposite
-- error the moment anyone changes the rounding direction. Σfloor(x) is simply
-- not floor(Σx).
--
-- The fix is to move the single truncation to the only place that has to make
-- one — settlement, where a whole number of billable seconds is required
-- because `unit_rate_micro_usd_second` is priced per second.
--
-- Why microseconds and not milliseconds (the issue text suggested ms):
-- PostgreSQL's own timestamp/interval resolution *is* the microsecond. Storing
-- milliseconds would introduce a second, smaller truncation at every boundary
-- for no gain. At microseconds the generated column stops being an
-- approximation of the interval and becomes an exact restatement of it, so the
-- only rounding left in the whole ledger is the one this migration makes
-- explicit.
--
-- Why the column is replaced rather than joined by a sibling:
-- leaving `active_seconds` next to `active_micros` on the interval row leaves
-- two answers to one question, and the per-interval floor could come back
-- through any future aggregation that picks the older name. There is exactly
-- one active-time column on an interval, and it is exact.
--
-- What is deliberately NOT changed — the property three review rounds never
-- broke (#855, #859, ADR-0139 D4): a `paused` interval bills zero
-- *structurally*. It is still a GENERATED ... STORED column with the same
-- `state = 'active'` guard, so no application code, operator statement, or
-- future settlement variant can write a non-zero paused interval. The precision
-- change happens strictly inside the `THEN` branch; the `ELSE 0` branch and its
-- generated-ness are untouched.
--
-- Already settled rows are NOT recomputed. A settled row is an invoice that was
-- already charged against `credit_entry`, and `credit_entry` is append-only by
-- trigger (045:120-146); recomputing it would either lie about history or
-- require a compensating debit nobody asked for. `work_host_usage.active_micros
-- IS NULL` is the durable marker for "settled before 058", and the new CHECK is
-- written so those rows stay legal forever.
--
-- Migrations 049/051/052/053/057 keep their invariants: the one-unsettled-per-
-- host partial unique index, the advisory ladder, the settled_at seal, the
-- transition table, and the deadline trigger are all untouched. `t3_terminate`
-- is replaced (CREATE OR REPLACE) only in its arithmetic — the lock ladder,
-- idempotence, `settled_reason` semantics, destroy intent, and host revocation
-- are byte-for-byte the 053 statement.
-- schema_v0.sql remains unchanged.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1) Interval precision. Exact microseconds, pause still structurally zero.
-- ---------------------------------------------------------------------------
ALTER TABLE work_host_usage_interval
  DROP COLUMN active_seconds,
  ADD COLUMN active_micros bigint GENERATED ALWAYS AS (
    CASE
      WHEN state = 'active' AND ended_at IS NOT NULL
        THEN GREATEST(
               0,
               floor(
                 extract(epoch FROM (ended_at - started_at)) * 1000000
               )::bigint
             )
      ELSE 0
    END
  ) STORED;

COMMENT ON COLUMN work_host_usage_interval.active_micros IS
  'MOMO-661 exact active microseconds. Zero for paused intervals by generation, never by billing code. Never floored here — settlement floors the total once.';

COMMENT ON TABLE work_host_usage_interval IS
  'T3 active/paused intervals. Generated active_micros is always zero while paused.';

-- `now()` is the *transaction* timestamp. A writer that closes one interval
-- with clock_timestamp() and opens the next inside a transaction that began
-- earlier produced overlapping intervals — invisible while each interval was
-- floored to a second, but real over-billing at microsecond precision. With
-- clock_timestamp() a newly opened interval can never start before the one it
-- follows was closed.
ALTER TABLE work_host_usage_interval
  ALTER COLUMN started_at SET DEFAULT clock_timestamp();

-- ---------------------------------------------------------------------------
-- 2) Settlement result. The exact total is kept next to the billed seconds so
--    "floored exactly once" is checkable after the fact instead of trusted.
-- ---------------------------------------------------------------------------
ALTER TABLE work_host_usage
  ADD COLUMN active_micros bigint,
  ADD CONSTRAINT work_host_usage_active_micros_ck CHECK (
    active_micros IS NULL
    OR (
      active_micros >= 0
      AND active_seconds IS NOT NULL
      AND active_seconds = active_micros / 1000000
    )
  );

COMMENT ON COLUMN work_host_usage.active_micros IS
  'MOMO-661 exact settled active microseconds (sum of interval active_micros). NULL means the row was settled before migration 058; those invoices are never recomputed.';

-- The column keeps its name and type because it is still the billed quantity —
-- `unit_rate_micro_usd_second` is priced per second. Its *meaning* changed:
-- before 058 it was Σ floor(interval), after 058 it is floor(Σ interval), so a
-- session with many pause boundaries now settles at up to one second below the
-- true active time instead of up to one second below it per boundary.
COMMENT ON COLUMN work_host_usage.active_seconds IS
  'Billed whole active seconds. From migration 058 this is floor(active_micros / 1000000) — the ledger truncates exactly once, at settlement. Rows settled before 058 retain Σ floor(per interval).';

-- ---------------------------------------------------------------------------
-- 3) The single floor. Everything else is the sealed 053 statement verbatim.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION t3_terminate(
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
  v_active_micros bigint;
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

  -- Sum first, floor once. Paused intervals contribute a generated zero, so
  -- this total is active time and nothing else. Integer division on a
  -- non-negative bigint is the floor, and it is the only truncation in the
  -- billing path: the discarded remainder is now bounded by one second per
  -- settlement instead of one second per pause boundary.
  SELECT COALESCE(sum(active_micros), 0)::bigint
    INTO v_active_micros
    FROM work_host_usage_interval
   WHERE usage_id = v_usage_id;

  v_active_seconds := v_active_micros / 1000000;
  v_debit := v_active_seconds * v_unit_rate;
  v_previous_settlement := current_setting('momo.t3_settlement', true);
  PERFORM set_config('momo.t3_settlement', 'on', true);

  UPDATE work_host_usage
     SET ended_at = clock_timestamp(),
         active_seconds = v_active_seconds,
         active_micros = v_active_micros,
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
  'ADR-0140 idempotent T3 termination: credit/cloud/usage/session/host lock ladder, first-reason settlement, durable destroy intent, and MOMO-661 single-floor microsecond billing.';

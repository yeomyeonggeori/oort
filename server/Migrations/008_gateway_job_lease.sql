-- =============================================================================
-- 008_gateway_job_lease.sql — MOMO-341 durable gateway claim/lease + takeover
--
-- Gateway realtime publications are wake-ups only. The authoritative pending
-- outbox row is claimed through the actor-bound REST recovery endpoint. These
-- columns make that claim durable so overlapping gateway consumers cannot both
-- start provider work, while an expired owner can be taken over after a crash.
--
-- RLS: outbox is an existing schema_v0 table already registered in the FORCE
-- RLS policy DO-block. No new table or policy registration is required.
--
-- Idempotency: columns/index use IF NOT EXISTS and the constraint is guarded by
-- pg_constraint. scripts/migrate.sh still records this numbered file once and
-- verifies the second pass as SKIP.
-- =============================================================================

ALTER TABLE outbox
  ADD COLUMN IF NOT EXISTS lease_owner uuid,
  ADD COLUMN IF NOT EXISTS lease_acquired_at timestamptz,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'outbox_gateway_lease_shape_ck'
       AND conrelid = 'outbox'::regclass
  ) THEN
    ALTER TABLE outbox
      ADD CONSTRAINT outbox_gateway_lease_shape_ck CHECK (
        (lease_owner IS NULL
          AND lease_acquired_at IS NULL
          AND lease_expires_at IS NULL)
        OR
        (lease_owner IS NOT NULL
          AND lease_acquired_at IS NOT NULL
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at > lease_acquired_at)
      );
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS outbox_gateway_claim_idx
  ON outbox (workspace_id, partition_key, available_at, lease_expires_at, id)
  WHERE kind = 'agent_job'
    AND method = 'gateway'
    AND status = 'pending';

COMMENT ON COLUMN outbox.lease_owner IS
  'MOMO-341 opaque single-owner capability for a claimed gateway agent_job.';
COMMENT ON COLUMN outbox.lease_acquired_at IS
  'MOMO-341 timestamp of the current gateway claim/takeover.';
COMMENT ON COLUMN outbox.lease_expires_at IS
  'MOMO-341 bounded claim expiry; an expired pending gateway job is takeover-eligible.';

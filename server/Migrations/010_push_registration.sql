-- =============================================================================
-- 010_push_registration.sql — MOMO-403 (ADR-0120 P-1) device/push_token
-- registration lifecycle indexes.
--
-- schema_v0 (001_init.sql) already ships `device` / `push_token` /
-- `push_dispatch_log` plus UNIQUE (apns_token, env). This migration adds the
-- registration-lifecycle invariants the register/revoke REST relies on:
--
--   1. At most ONE active (invalidated_at IS NULL) push token per
--      (device, env). Registration rotates tokens by invalidating siblings
--      inside the same transaction before upserting the incoming token, so
--      the MOMO-404 notifier can never double-dispatch to one device.
--      Invalidated rows are kept forever — push_dispatch_log references them
--      and revocation is `invalidated_at`, never DELETE (ADR-0120 D4).
--
--   2. A plain device_id lookup index for the revoke path
--      (UPDATE push_token ... WHERE device_id = $1) and for per-device token
--      listing; the FK to device(id) has no supporting index in schema_v0.
-- =============================================================================

CREATE UNIQUE INDEX push_token_device_env_active_uniq
  ON push_token (device_id, env)
  WHERE invalidated_at IS NULL;

CREATE INDEX push_token_device_idx
  ON push_token (device_id);

-- =============================================================================
-- 054_t3_provider_registry.sql — MOMO-670 / ADR-0142 D1+D4
--
-- Migration 045 pinned `work_cloud_host.provider` to the single value 'e2b'
-- (045:103) and defaulted every row to it. ADR-0142 makes the column an
-- adapter-registry identifier instead: BYOC is the base acquisition path and a
-- managed substrate is one adapter among several, so a one-value CHECK is now
-- a false statement about the domain.
--
-- The default is dropped on purpose. A row whose provider was never stated is
-- a row nobody can reconcile — the reconciler would have to guess which
-- adapter owns the instance. Every writer states it.
--
-- ADR-0140's lifecycle (durable intent, transition table, t3_terminate,
-- advisory ladder) is untouched: it was already provider-general.
-- =============================================================================

ALTER TABLE work_cloud_host
  DROP CONSTRAINT work_cloud_host_provider_ck;

-- Existing installations only ever produced 'e2b'. Rewriting them to a
-- registry identifier they can no longer be reconciled against would be a lie
-- about history, so the shape constraint accepts them and the adapters simply
-- have no such entry — an unknown provider fails closed at config load.
ALTER TABLE work_cloud_host
  ADD CONSTRAINT work_cloud_host_provider_ck
  CHECK (provider ~ '^[a-z0-9][a-z0-9-]{0,31}$');

ALTER TABLE work_cloud_host
  ALTER COLUMN provider DROP DEFAULT;

COMMENT ON COLUMN work_cloud_host.provider IS
  'ADR-0142 D2 adapter registry identifier (byoc | managed substrate id). Not a vendor name in policy code.';

COMMENT ON TABLE work_cloud_host IS
  'Provider-neutral cloud host lifecycle binding and one-shot workd bootstrap token digest; never raw secrets.';

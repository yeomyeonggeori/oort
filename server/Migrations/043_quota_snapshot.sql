-- =============================================================================
-- 043_quota_snapshot.sql — MOMO-623 / ADR-0135 D2 (잔여량 프로브 — 경계 보존형)
--
-- Latest-known provider quota gauge, ingested from the side that already holds
-- the credential (the hermes adapter / provider host). momo never queries a
-- provider API for quota: it only accepts the resulting NUMBERS.
--
-- ADR-0004 invariants preserved (this table is the reason D2-A was chosen over
-- D2-B):
--   * No token / bearer / authorization / OAuth / header column exists here and
--     none may ever be added. The row carries a provider LABEL plus a ratio and
--     two timestamps — nothing that can authenticate to a provider.
--   * The REST ingest surface (POST /v1/provider/quota-snapshots) rejects any
--     credential-shaped field or value before it reaches this table
--     (ProviderQuotaSnapshotRoutes, reusing the WorkToolProfileRoutes pattern).
--
-- Storage contract (ADR-0135 D2: "저장은 최신 스냅샷만(테이블 1개, upsert)"):
--   * PRIMARY KEY (provider_ref, quota_window) — exactly one row per gauge.
--   * The ingest UPSERT is monotone in probed_at: an out-of-order/replayed probe
--     that is OLDER than the stored one must not overwrite it. That guard lives
--     in the route's ON CONFLICT ... WHERE clause; this table only guarantees
--     the one-row-per-gauge shape.
--
-- Column naming: the wire contract keeps ADR-0135's `window` field name, but
-- WINDOW is a PostgreSQL reserved keyword, so the column is `quota_window`
-- (unquoted DDL everywhere). The REST layer maps window <-> quota_window.
--
-- Instance-global, exactly like provider_link (039): a provider chain entry is
-- one operator-configured upstream shared by every workspace on the instance,
-- so this table carries no workspace_id.
--
-- schema_v0.sql is not touched (migration-only, per the hard rules).
-- =============================================================================

CREATE TABLE quota_snapshot (
  -- Operator-facing provider label (chain entry ref, e.g. 'codex' / 'claude' /
  -- 'hermes-primary'). Slug-shaped so it can never carry a pasted credential.
  provider_ref     text NOT NULL,
  -- ADR-0135: the reference implementations all expose a short rolling window
  -- plus a weekly window. Two gauges, fixed vocabulary.
  quota_window     text NOT NULL,
  -- 1.0 = untouched, 0.0 = exhausted. Ratio only — never absolute credit/spend,
  -- which would be provider billing data momo has no business mirroring.
  remaining_ratio  double precision NOT NULL,
  -- Absolute reset instant reported by the provider ("{요일 HH:mm} 리셋").
  -- NULL when the provider did not report one; the UI then hides the reset line.
  resets_at        timestamptz,
  -- When the credential-holding side actually probed. Drives the snapshot-age
  -- badge and the last-known-value fallback.
  probed_at        timestamptz NOT NULL,
  -- Server receive time; separate from probed_at so clock skew is visible.
  ingested_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT quota_snapshot_pk PRIMARY KEY (provider_ref, quota_window),
  CONSTRAINT quota_snapshot_window_ck
    CHECK (quota_window IN ('short', 'weekly')),
  CONSTRAINT quota_snapshot_ratio_ck
    CHECK (remaining_ratio >= 0 AND remaining_ratio <= 1),
  CONSTRAINT quota_snapshot_provider_ref_ck
    CHECK (provider_ref ~ '^[a-z0-9][a-z0-9._-]{0,63}$')
);

COMMENT ON TABLE quota_snapshot IS
  'ADR-0135 D2: latest-known provider quota gauge, ingested from the credential '
  'holder as numbers only. Never stores tokens/OAuth/headers (ADR-0004).';
COMMENT ON COLUMN quota_snapshot.quota_window IS
  'short | weekly. Named quota_window because WINDOW is a reserved keyword; the '
  'REST field stays `window` per ADR-0135.';
COMMENT ON COLUMN quota_snapshot.remaining_ratio IS
  'Remaining fraction in 0..1. Ratio only — no absolute provider billing data.';
COMMENT ON COLUMN quota_snapshot.probed_at IS
  'Probe instant reported by the credential holder; the ingest upsert is '
  'monotone in this column so a replayed older probe cannot regress the gauge.';

-- =============================================================================
-- RLS — FORCE, split by intent (provider_link 039 pattern, adapted).
--
-- The table has no workspace_id, so the uniform ws_isolation policy does not
-- apply. Two permissive policies encode the two ADR-0135 D2 audiences:
--
--   * INGEST (write): only a transaction that has set `app.provider_quota_admin`
--     may write. The REST layer sets that GUC only AFTER the agent bearer +
--     `provider:quota:write` scope check has passed, so an ordinary tenant
--     transaction can never insert or mutate a gauge.
--
--   * READ: any workspace-scoped session may SELECT. The dashboard gauge is
--     instance-global operator telemetry that every workspace member is allowed
--     to see ("사용량은 사용자가 전부 트래킹"), and it contains no secret. A
--     session with NO app.workspace_id (unscoped/unauthenticated) still sees
--     nothing — default-deny stays the baseline.
--
-- FORCE keeps even the table owner subject to both policies. The BYPASSRLS
-- background roles (momo_relay / momo_worker / momo_notifier) bypass by design.
-- =============================================================================
ALTER TABLE quota_snapshot ENABLE ROW LEVEL SECURITY;
ALTER TABLE quota_snapshot FORCE ROW LEVEL SECURITY;

CREATE POLICY quota_snapshot_ingest ON quota_snapshot
  FOR ALL
  USING (current_setting('app.provider_quota_admin', true) = 'on')
  WITH CHECK (current_setting('app.provider_quota_admin', true) = 'on');

CREATE POLICY quota_snapshot_member_read ON quota_snapshot
  FOR SELECT
  USING (coalesce(current_setting('app.workspace_id', true), '') <> '');

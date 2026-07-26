-- =============================================================================
-- 042_provider_link_chain.sql — MOMO-622 / ADR-0135 D1
--
-- Ordered provider cascade chain. 039 gave the instance one provider boundary
-- (`provider_link`, a hard singleton: `id boolean CHECK (id = true)`); ADR-0135
-- D1 makes the boundary a *chain* so a run can fall over to a second provider
-- when the first is unreachable / 5xx / rate limited.
--
-- Position model (the "이전 경로" of ADR-0135 D1, read-side):
--   * **position 0 is the legacy `provider_link` singleton** (or, when no row is
--     configured, the boot-time HERMES_* env trio). It is NOT copied into this
--     table: the 039 row stays the single storage for position 0, so the MOMO-577
--     bytea/decrypt gate, the MOMO-583 operator authorization model, and the
--     worker's MOMO-573 resolution path all keep working byte-for-byte, and there
--     is no dual-write drift between two stores for the same hop.
--   * **positions >= 1 live here** — the fallback hops, tried in ascending
--     position order after position 0. Hence the `position >= 1` CHECK: a row at
--     0 would shadow the legacy surface and reintroduce exactly the drift this
--     split avoids. Retiring the singleton (moving 0 into this table) is a
--     separate migration once the legacy surface is dropped.
--
-- Cascade rule (enforced in code, not SQL — server probe + AgentWorker turn):
-- only **no response / 5xx / 429** advance to the next position. Any other 4xx is
-- a user/config error and propagates to the caller instead of silently spending
-- on a second provider. Every transition writes an audit row
-- (`provider.cascade.fallback`) plus an outbox-delivered run event, so a switch
-- is never silent (ADR-0135 D1 "조용한 전환 금지").
--
-- ADR-0004 invariants preserved (identical to 039):
--   * `bearer_ciphertext` is an AES-GCM sealed box under PROVIDER_LINK_MASTER_KEY.
--     The plaintext bearer is write-only: never stored, echoed, logged, audited,
--     or projected into Context Packet / gate evidence.
--   * No codex_oauth_* / openai_oauth_* / raw provider-API-key column exists. The
--     provider OAuth boundary stays outside momo (ADR-0004 Rules #1-#2).
--   * Instance-global operator config (no workspace_id) — reachable only from the
--     operator REST path, which sets `app.provider_link_admin` after the MOMO-583
--     authorization check.
--
-- schema_v0.sql is not touched (migration-only, per the hard rules).
-- =============================================================================

CREATE TABLE provider_link_chain (
  id                uuid PRIMARY KEY DEFAULT uuidv7(),
  -- Cascade order. UNIQUE so "position N" names exactly one hop; >= 1 because
  -- position 0 is the legacy provider_link singleton (see header).
  position          integer NOT NULL UNIQUE,
  base_url          text NOT NULL,
  -- AES-GCM sealed box (version byte || nonce || ciphertext || tag), same format
  -- and same PROVIDER_LINK_MASTER_KEY derivation as provider_link.
  bearer_ciphertext bytea NOT NULL,
  mode              text NOT NULL,
  -- A disabled hop stays configured (bearer retained) but is skipped by both the
  -- cascade and the chain probe — the operator can park a provider without
  -- re-entering its bearer.
  enabled           boolean NOT NULL DEFAULT true,
  updated_by        uuid REFERENCES member(id) ON DELETE SET NULL,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provider_link_chain_position_ck CHECK (position >= 1),
  CONSTRAINT provider_link_chain_base_url_ck CHECK (length(btrim(base_url)) > 0),
  CONSTRAINT provider_link_chain_bearer_ck CHECK (octet_length(bearer_ciphertext) > 0),
  CONSTRAINT provider_link_chain_mode_ck
    CHECK (mode IN ('local-mock', 'internal-host-mock', 'external-hermes'))
);

COMMENT ON TABLE provider_link_chain IS
  'ADR-0135 D1: ordered provider cascade fallback hops (position >= 1). '
  'Position 0 is the legacy provider_link singleton / env fallback. '
  'Bearer is AES-GCM ciphertext (PROVIDER_LINK_MASTER_KEY); never OAuth/raw provider keys.';
COMMENT ON COLUMN provider_link_chain.position IS
  'Cascade order (ascending). 1 = first fallback after the position-0 legacy link.';
COMMENT ON COLUMN provider_link_chain.bearer_ciphertext IS
  'AES-GCM sealed provider bearer (version||nonce||ct||tag). Plaintext never persisted or logged.';
COMMENT ON COLUMN provider_link_chain.enabled IS
  'False parks the hop: skipped by the cascade and the /test chain probe, bearer retained.';

-- Ascending-order scan for the cascade read path.
CREATE INDEX provider_link_chain_order_idx
  ON provider_link_chain (position)
  WHERE enabled;

-- =============================================================================
-- RLS — operator-only, GUC gated. Identical posture to provider_link (039): this
-- table carries no workspace_id, so the uniform ws_isolation policy does not
-- apply. FORCE keeps even the table owner subject to the policy. The NOBYPASSRLS
-- API role (momo_app) can touch rows only inside the operator transaction, which
-- sets `app.provider_link_admin` AFTER the MOMO-583 authorization check. Ordinary
-- tenant transactions (which set only app.workspace_id) get a default-deny empty
-- view.
--
-- Background consumers connect as BYPASSRLS roles (momo_relay / momo_worker) and
-- bypass this policy by design: the AgentWorker's cascade resolver reads and
-- decrypts these rows locally, exactly as it already does for provider_link.
-- =============================================================================
ALTER TABLE provider_link_chain ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_link_chain FORCE ROW LEVEL SECURITY;

CREATE POLICY provider_link_chain_operator ON provider_link_chain
  USING (current_setting('app.provider_link_admin', true) = 'on')
  WITH CHECK (current_setting('app.provider_link_admin', true) = 'on');

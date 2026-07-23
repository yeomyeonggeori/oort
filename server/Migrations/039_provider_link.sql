-- =============================================================================
-- 039_provider_link.sql — MOMO-572 / ADR-0004 증보 1 (D1-D5)
--
-- Instance-global operator config for the OpenAI-compatible Hermes/Kim Intern
-- provider boundary. This is the runtime, DB-backed override for the boot-time
-- env trio (AGENT_PROVIDER_MODE / HERMES_BASE_URL / HERMES_API_KEY): a present,
-- usable row wins over env; otherwise the process falls back to env and strict
-- environments keep failing closed (ADR-0004 Failure Modes).
--
-- ADR-0004 invariants preserved:
--   * The provider bearer is stored ONLY as AES-GCM ciphertext, encrypted with a
--     dedicated PROVIDER_LINK_MASTER_KEY (never reusing OUTBOUND_WEBHOOK_MASTER_KEY
--     or JWT_HMAC). Plaintext never enters logs / Context Packet / audit / gate
--     evidence.
--   * No codex_oauth_* / openai_oauth_* / raw provider-API-key columns exist. The
--     Codex/OpenAI OAuth boundary stays outside momo (ADR-0004 Rules #1-#2).
--   * This table is instance-global operator config — NOT workspace-scoped. It is
--     reachable only from the operator REST path, which sets the
--     `app.provider_link_admin` GUC after verifying the platform:read scope.
--
-- Singleton: at most one row (id boolean fixed to true). schema_v0.sql is not
-- touched (migration-only, per the hard rules).
-- =============================================================================

CREATE TABLE provider_link (
  -- Singleton guard: only the row id=true may exist, so PUT is a clean upsert
  -- and every reader can `SELECT ... LIMIT 1` without a scope key.
  id                boolean PRIMARY KEY DEFAULT true,
  base_url          text NOT NULL,
  -- AES-GCM sealed box (version byte || nonce || ciphertext || tag). Encrypted
  -- with PROVIDER_LINK_MASTER_KEY; the plaintext bearer is never stored.
  bearer_ciphertext bytea NOT NULL,
  mode              text NOT NULL,
  updated_by        uuid REFERENCES member(id) ON DELETE SET NULL,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provider_link_singleton_ck CHECK (id = true),
  CONSTRAINT provider_link_base_url_ck CHECK (length(btrim(base_url)) > 0),
  CONSTRAINT provider_link_bearer_ck CHECK (octet_length(bearer_ciphertext) > 0),
  CONSTRAINT provider_link_mode_ck
    CHECK (mode IN ('local-mock', 'internal-host-mock', 'external-hermes'))
);

COMMENT ON TABLE provider_link IS
  'ADR-0004 증보 1: instance-global operator override for the Hermes provider boundary. '
  'Bearer is AES-GCM ciphertext (PROVIDER_LINK_MASTER_KEY); never OAuth/raw provider keys.';
COMMENT ON COLUMN provider_link.bearer_ciphertext IS
  'AES-GCM sealed provider bearer (version||nonce||ct||tag). Plaintext never persisted or logged.';

-- =============================================================================
-- RLS — operator-only, GUC gated. This table carries no workspace_id, so the
-- uniform ws_isolation policy does not apply. FORCE keeps even the table owner
-- subject to the policy. The NOBYPASSRLS API role (momo_app) can touch the row
-- only inside the operator transaction, which sets `app.provider_link_admin`
-- AFTER the platform:read scope check. Ordinary tenant transactions (which set
-- only app.workspace_id) get a default-deny empty view.
--
-- Background consumers connect as BYPASSRLS roles (momo_relay / momo_worker) and
-- so bypass this policy by design: a future worker-side resolver reads+decrypts
-- the row locally, exactly as it holds HERMES_API_KEY today.
-- =============================================================================
ALTER TABLE provider_link ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_link FORCE ROW LEVEL SECURITY;

CREATE POLICY provider_link_operator ON provider_link
  USING (current_setting('app.provider_link_admin', true) = 'on')
  WITH CHECK (current_setting('app.provider_link_admin', true) = 'on');

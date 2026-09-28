-- =============================================================================
-- 093_provider_default_ai.sql — #3009 (ADR-0147 증보 2026-09-28, ADR-0190 증보
-- 2026-09-28)
--
-- 「기본 AI」의 팀 행 — the instance-global default AI for results the TEAM sees
-- (팀 에이전트 대답, 채널 요약 · 첫 인사). Personal rows (앱 명령, 로컬 터미널,
-- 원격 작업) are device-local and never stored on a server (AI 계정 brief §4.5
-- invariant 4). The guardrail / decision row is not stored: it stays `off` until
-- the 판정기 ADR is Accepted (AI 계정 Q6).
--
-- A row holds a LINK REFERENCE and a MODEL ID, nothing else:
--   * link_position — cascade position: 0 = the provider_link singleton (039) or
--     its env fallback, >= 1 = a provider_link_chain hop (042).
--   * link_endpoint_label — the redacted endpoint label that position had when
--     the operator chose it. 042's `PUT …/chain` deletes and re-inserts every hop,
--     so a position is not a stable id; the snapshot is how a read detects that
--     the position now points at a different provider.
--   * model_id — a provider model id, or NULL for "the link's default". The CHECK
--     is the same shape the server's sanitizer accepts (momo_settings
--     `sanitized_model_id`).
--   * credential_source — CHECKed to 'team_link'. A personal subscription profile
--     can never be a team row's credential (brief §4.5 invariant 2); the route
--     refuses it first, this constraint refuses it again.
-- No bearer, no ciphertext, no path, no token column exists.
--
-- RLS — operator-only, GUC gated, exactly as 039/042. This table carries no
-- workspace_id (it is instance-global, like provider_link), so the uniform
-- ws_isolation policy does not apply. FORCE keeps even the owner subject to the
-- policy. The NOBYPASSRLS API role reaches the rows only inside the operator
-- transaction (`with_provider_link_admin_tx`), which sets
-- `app.provider_link_admin` AFTER the MOMO-583 instance-operator check. Ordinary
-- tenant transactions see nothing. Background consumers (momo_worker) are
-- BYPASSRLS by design and may read the rows, as they read provider_link.
--
-- schema_v0.sql is not touched. Idempotent: every statement is guarded, so a
-- re-run of this file on a database that already has it is a no-op.
-- =============================================================================

CREATE TABLE IF NOT EXISTS provider_default_ai (
  role                 text PRIMARY KEY,
  credential_source    text NOT NULL DEFAULT 'team_link',
  link_position        integer NOT NULL,
  link_endpoint_label  text NOT NULL,
  model_id             text NULL,
  updated_by           uuid REFERENCES member(id) ON DELETE SET NULL,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provider_default_ai_role_ck
    CHECK (role IN ('team_agent', 'summary')),
  CONSTRAINT provider_default_ai_source_ck
    CHECK (credential_source = 'team_link'),
  CONSTRAINT provider_default_ai_position_ck
    CHECK (link_position >= 0),
  CONSTRAINT provider_default_ai_label_ck
    CHECK (length(btrim(link_endpoint_label)) > 0 AND length(link_endpoint_label) <= 512),
  CONSTRAINT provider_default_ai_model_ck
    CHECK (model_id IS NULL OR model_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,63}$')
);

COMMENT ON TABLE provider_default_ai IS
  '#3009 ADR-0147 증보 2026-09-28: 「기본 AI」 team rows (team_agent, summary). '
  'Instance-global operator config: link position + endpoint label snapshot + model id. '
  'No credential material; credential_source is always team_link.';

ALTER TABLE provider_default_ai ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_default_ai FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS provider_default_ai_operator ON provider_default_ai;
CREATE POLICY provider_default_ai_operator ON provider_default_ai
  USING (current_setting('app.provider_link_admin', true) = 'on')
  WITH CHECK (current_setting('app.provider_link_admin', true) = 'on');

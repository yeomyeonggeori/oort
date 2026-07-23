-- =============================================================================
-- 040_work_host_engine.sql — MOMO-579 / WH-1 / ADR-0114 증보1 (B)
--
-- Per-workspace selection of the work host execution engine (opencode | goose |
-- codex-local). WH-2's GUI writes it; momo-workd reads it and launches the
-- matching WorkEngineAdapter. Boot default is opencode, so an absent row means
-- opencode without any write.
--
-- Precedence (WorkdConfig.resolveEngine, provider_link 패턴): this DB row wins
-- over the daemon's MOMO_WORKD_ENGINE env, which wins over the compiled default.
--
-- ADR-0004: this table carries only an engine label — never a provider key,
-- OAuth token, or host-local path. `codex-local` selects the user host's own
-- Codex; the credential boundary stays outside momo (the sidecar is a consumer).
--
-- schema_v0.sql is not touched (migration-only, per the hard rules).
-- =============================================================================

CREATE TABLE work_host_engine (
  workspace_id  uuid PRIMARY KEY REFERENCES workspace(id) ON DELETE CASCADE,
  engine        text NOT NULL DEFAULT 'opencode',
  updated_by    uuid REFERENCES member(id) ON DELETE SET NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT work_host_engine_engine_ck
    CHECK (engine IN ('opencode', 'goose', 'codex-local'))
);

COMMENT ON TABLE work_host_engine IS
  'ADR-0114 증보1 (WH-1): per-workspace work host engine selection. '
  'Engine label only — never provider credentials/OAuth (ADR-0004).';

-- RLS — the uniform workspace isolation policy (identical to 021_work_host).
-- FORCE keeps even the table owner subject to it; the NOBYPASSRLS momo_app role
-- sees only its own workspace's row.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['work_host_engine'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', t);
    EXECUTE format($f$
      CREATE POLICY ws_isolation ON %I
      USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
      WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);
    $f$, t);
  END LOOP;
END $$;

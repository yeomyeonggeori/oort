-- =============================================================================
-- 007_agent_run_a2a_guards.sql — MOMO-301 agent_run A2A loop-guard counters
--
-- L4 spec §3.3 (6-gate AND combination) / §3.4 (A2A loop safety) promise
-- depth<=MAX_DEPTH(4) and round<=R(4), but schema_v0 only stores `depth`
-- (with a `>= 0` check and no cap). This migration makes the §3.4 counters
-- storable AND enforceable at the SoT (Postgres) without touching the
-- canonical schema_v0.sql:
--
--   * round_count            — A2A session round barrier counter (§3.4 R=4)
--   * consecutive_auto_count — G2 consecutive agent auto-reply counter
--                              (worker-observed trailing agent streak; a human
--                              utterance resets it to 0 by breaking the streak)
--   * depth cap CHECK        — §3.4 MAX_DEPTH=4 hop cap (A→B→A ping-pong)
--   * round cap CHECK        — §3.4 R=4 round barrier hard cap
--
-- RLS: agent_run is an EXISTING table already registered in the schema_v0
-- ws_isolation DO-block (verified: 'agent_run' is in the RLS ARRAY). ALTERing
-- columns does not require re-registering policies — no new table, no new
-- RLS entry needed.
--
-- Idempotency: applied exactly once via schema_migrations (scripts/migrate.sh
-- 1-run apply→verify passes; the verify pass must report SKIP for this file).
-- =============================================================================

ALTER TABLE agent_run
  ADD COLUMN IF NOT EXISTS round_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS consecutive_auto_count integer NOT NULL DEFAULT 0;

-- §3.4 hard caps at the SoT. depth already has depth >= 0 in schema_v0;
-- the caps below are additive constraints (new names, no schema_v0 edits).
ALTER TABLE agent_run
  ADD CONSTRAINT agent_run_depth_a2a_cap_ck
    CHECK (depth <= 4),
  ADD CONSTRAINT agent_run_round_cap_ck
    CHECK (round_count >= 0 AND round_count <= 4),
  ADD CONSTRAINT agent_run_consec_auto_nonneg_ck
    CHECK (consecutive_auto_count >= 0);

COMMENT ON COLUMN agent_run.round_count IS
  'MOMO-301 §3.4 A2A round-barrier counter (one utterance per agent per round, hard cap 4). Stored for enforcement; the round scheduler lands with A2A (MOMO-313).';
COMMENT ON COLUMN agent_run.consecutive_auto_count IS
  'MOMO-301 G2 observed consecutive agent auto-reply streak at gate-evaluation time. SoT for the streak itself is the message tail (worker recomputes); this column records what the guard saw.';
COMMENT ON CONSTRAINT agent_run_depth_a2a_cap_ck ON agent_run IS
  'L4 §3.4 MAX_DEPTH=4: A→B→A hop depth beyond 4 is rejected at the SoT, not just in the app layer.';

-- =============================================================================
-- 004_approval_decision.sql — MOMO-167 approval decision idempotency ledger
--
-- Adds a narrow server-owned idempotency/audit companion table for
-- approval_request decisions without changing schema_v0.sql. The canonical
-- approval state remains approval.status; this table distinguishes client
-- retries from contradictory decisions.
-- =============================================================================

CREATE TABLE approval_decision (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id        uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  approval_id         uuid NOT NULL REFERENCES approval(id) ON DELETE CASCADE,
  client_decision_id  uuid NOT NULL,
  decided_by          uuid NOT NULL REFERENCES member(id),
  approve             boolean NOT NULL,
  status              approval_status NOT NULL,
  reason              text,
  receipt             jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT approval_decision_final_status_ck
    CHECK (status IN ('approved','rejected','expired')),
  CONSTRAINT approval_decision_workspace_uniq
    UNIQUE (workspace_id, client_decision_id)
);

CREATE INDEX approval_decision_approval_idx
  ON approval_decision (workspace_id, approval_id, created_at DESC);

COMMENT ON TABLE approval_decision IS
  'MOMO-167 client approval decision idempotency ledger. approval.status remains SoT.';
COMMENT ON COLUMN approval_decision.client_decision_id IS
  'Stable UUID supplied by ApprovalDecisionRequest for safe approve/reject retries.';

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'approval_decision'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', t);
    EXECUTE format($f$
      CREATE POLICY ws_isolation ON %I
      USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
      WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);
    $f$, t);
  END LOOP;
END $$;

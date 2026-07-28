-- =============================================================================
-- 045_t3_provisioner_credit_ledger.sql — MOMO-647 / ADR-0136 D1-D2
--
-- `usage_ledger` is intentionally NOT extended. Its immutable row means one
-- model request and token cost; a T3 work session has multiple active/paused
-- lifecycle intervals and a different settlement unit. Mixing both would make
-- every existing usage aggregation reinterpret heterogeneous rows.
--
-- T3 therefore gets a dedicated session usage ledger plus interval children.
-- The generated interval `active_seconds` is structurally zero for `paused`,
-- satisfying ADR-0139 D4 without relying on a later billing-code subtraction.
-- schema_v0.sql remains unchanged.
-- =============================================================================

CREATE TABLE workspace_credit (
  workspace_id       uuid PRIMARY KEY REFERENCES workspace(id) ON DELETE CASCADE,
  balance_micro_usd  bigint NOT NULL DEFAULT 0,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE credit_entry (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id       uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  delta_micro_usd    bigint NOT NULL,
  reason             text NOT NULL,
  ref_id             uuid NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT credit_entry_delta_ck CHECK (delta_micro_usd <> 0),
  CONSTRAINT credit_entry_reason_ck CHECK (reason IN ('topup', 't3_usage')),
  CONSTRAINT credit_entry_ref_unique UNIQUE (workspace_id, reason, ref_id),
  CONSTRAINT credit_entry_t3_debit_ck CHECK (
    reason <> 't3_usage' OR delta_micro_usd < 0
  )
);

CREATE TABLE work_host_usage (
  id                         uuid PRIMARY KEY DEFAULT uuidv7(),
  session_id                 uuid NOT NULL UNIQUE
                               REFERENCES work_session(id) ON DELETE RESTRICT,
  host_id                    uuid NOT NULL REFERENCES work_host(id) ON DELETE RESTRICT,
  workspace_id               uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  started_at                 timestamptz NOT NULL DEFAULT now(),
  ended_at                   timestamptz,
  active_seconds             bigint,
  unit_rate_micro_usd_second bigint NOT NULL,
  settled_at                 timestamptz,
  CONSTRAINT work_host_usage_rate_ck
    CHECK (unit_rate_micro_usd_second > 0),
  CONSTRAINT work_host_usage_time_ck
    CHECK (ended_at IS NULL OR ended_at >= started_at),
  CONSTRAINT work_host_usage_settlement_ck CHECK (
    (ended_at IS NULL AND active_seconds IS NULL AND settled_at IS NULL)
    OR
    (ended_at IS NOT NULL AND active_seconds IS NOT NULL
      AND active_seconds >= 0 AND settled_at IS NOT NULL)
  )
);

CREATE TABLE work_host_usage_interval (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  usage_id        uuid NOT NULL REFERENCES work_host_usage(id) ON DELETE RESTRICT,
  workspace_id    uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  state           text NOT NULL,
  started_at      timestamptz NOT NULL DEFAULT now(),
  ended_at        timestamptz,
  active_seconds  bigint GENERATED ALWAYS AS (
    CASE
      WHEN state = 'active' AND ended_at IS NOT NULL
        THEN GREATEST(0, floor(extract(epoch FROM (ended_at - started_at)))::bigint)
      ELSE 0
    END
  ) STORED,
  CONSTRAINT work_host_usage_interval_state_ck
    CHECK (state IN ('active', 'paused')),
  CONSTRAINT work_host_usage_interval_time_ck
    CHECK (ended_at IS NULL OR ended_at >= started_at)
);

CREATE UNIQUE INDEX work_host_usage_interval_one_open_idx
  ON work_host_usage_interval (usage_id)
  WHERE ended_at IS NULL;
CREATE INDEX work_host_usage_workspace_started_idx
  ON work_host_usage (workspace_id, started_at DESC, id DESC);
CREATE INDEX credit_entry_workspace_created_idx
  ON credit_entry (workspace_id, created_at DESC, id DESC);

-- A raw bootstrap token never enters PostgreSQL. Only its SHA-256 digest is
-- stored until the cloud workd consumes it once and self-registers Ed25519.
CREATE TABLE work_cloud_host (
  id                         uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id               uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  requester_member_id        uuid NOT NULL REFERENCES member(id) ON DELETE RESTRICT,
  host_id                    uuid UNIQUE REFERENCES work_host(id) ON DELETE RESTRICT,
  provider                   text NOT NULL DEFAULT 'e2b',
  provider_sandbox_id        text UNIQUE,
  state                      text NOT NULL DEFAULT 'provisioning',
  bootstrap_token_digest     text NOT NULL UNIQUE,
  bootstrap_expires_at       timestamptz NOT NULL,
  bootstrap_consumed_at      timestamptz,
  unit_rate_micro_usd_second bigint NOT NULL,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT work_cloud_host_provider_ck CHECK (provider = 'e2b'),
  CONSTRAINT work_cloud_host_state_ck
    CHECK (state IN ('provisioning', 'ready', 'running', 'paused', 'destroyed', 'failed')),
  CONSTRAINT work_cloud_host_digest_ck
    CHECK (bootstrap_token_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT work_cloud_host_rate_ck CHECK (unit_rate_micro_usd_second > 0),
  CONSTRAINT work_cloud_host_sandbox_ck CHECK (
    (state IN ('provisioning', 'failed'))
    OR provider_sandbox_id IS NOT NULL
  ),
  CONSTRAINT work_cloud_host_registration_ck CHECK (
    (host_id IS NULL AND bootstrap_consumed_at IS NULL)
    OR (host_id IS NOT NULL AND bootstrap_consumed_at IS NOT NULL)
  )
);

CREATE INDEX work_cloud_host_workspace_state_idx
  ON work_cloud_host (workspace_id, state, created_at, id);

CREATE FUNCTION apply_credit_entry() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO workspace_credit (workspace_id, balance_micro_usd, updated_at)
  VALUES (NEW.workspace_id, NEW.delta_micro_usd, NEW.created_at)
  ON CONFLICT (workspace_id) DO UPDATE
    SET balance_micro_usd =
          workspace_credit.balance_micro_usd + EXCLUDED.balance_micro_usd,
        updated_at = GREATEST(workspace_credit.updated_at, EXCLUDED.updated_at);
  RETURN NEW;
END $$;

CREATE TRIGGER credit_entry_apply
AFTER INSERT ON credit_entry
FOR EACH ROW EXECUTE FUNCTION apply_credit_entry();

CREATE FUNCTION reject_credit_entry_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'credit_entry is append-only';
END $$;

CREATE TRIGGER credit_entry_no_update
BEFORE UPDATE ON credit_entry
FOR EACH ROW EXECUTE FUNCTION reject_credit_entry_mutation();

COMMENT ON TABLE work_host_usage IS
  'ADR-0136 T3 session settlement ledger; separate from token request usage_ledger.';
COMMENT ON TABLE work_host_usage_interval IS
  'T3 active/paused intervals. Generated active_seconds is always zero while paused.';
COMMENT ON TABLE credit_entry IS
  'Append-only workspace credit mutations; trigger maintains workspace_credit balance.';
COMMENT ON TABLE work_cloud_host IS
  'E2B lifecycle binding and one-shot cloud workd bootstrap token digest; never raw secrets.';

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'workspace_credit',
    'credit_entry',
    'work_host_usage',
    'work_host_usage_interval',
    'work_cloud_host'
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

-- =============================================================================
-- 095_human_control_nonce.sql — #3023 (ADR-0146 개정 2026-09-28 R2-E3: D-5 ·
-- D-9 · D-10 · 「DB 계약」)
--
-- The server half of a person's signed control. Two halves, one file:
--
--   human_control_nonce
--       The server's one-time barrier for `momo.human.control.v1` nonces
--       (D-9). The verify transaction consumes a nonce with
--       `INSERT … ON CONFLICT DO NOTHING RETURNING` — the 048 shape, which
--       cannot be reused as is because `work_host_request.host_id` is NOT NULL
--       (F14) and a person's statement is not a host's request.
--       The key is `(workspace_id, nonce)`, not per device key: a nonce is
--       128 random bits the client picks (for `input` it is the
--       `client_msg_id`), so the same nonce under a second key is a replay,
--       not a coincidence. A row is kept until `expires_at` — the statement's
--       own expiry plus the ±5 min skew window — because until then
--       `check_control_window` could still accept the statement; the verify
--       path prunes older rows before it consumes. With the nonce unique, a
--       statement authorizes at most one control and at most one
--       `action_signature` row (「한 행동 = 한 행」): ECDSA can sign the same
--       bytes many ways, the nonce cannot be spent twice.
--
--   work_control — the signature columns (D-10)
--       What the host needs to rebuild and re-verify the statement
--       (`WorkControl.humanSignature`, E4 #3063 contract table). The columns
--       are all set or all NULL, and the per-kind ones only on their kind:
--         * `human_mode` only on `input` (queue | interrupt);
--         * `human_scope` only on `permission` (once | session);
--         * `human_spawn_agent_member_id` · `human_spawn_folder_id` only on
--           `spawn`;
--       and a signed control is only ever a spawn, an input or a permission —
--       `kill` and `read` are never signed (D-8: the switch-off side needs no
--       signature). `human_signature` is the canonical low-s raw r‖s.
--       Times are the ms values *inside* the signed bytes (bigint), kept
--       verbatim so the bytes can be rebuilt exactly.
--       `work_control_payload_ck` is not changed: the payload stays the
--       domain (what the host acts on), and everything the signature adds
--       lives beside it in these columns.
--
-- Every arm tests IS NOT NULL before IN: a NULL there would make the CHECK
-- NULL, and a NULL CHECK passes.
--
-- The statements are written to be re-runnable (IF [NOT] EXISTS,
-- DROP-then-ADD) so applying the file twice is a no-op. RLS:
-- `human_control_nonce` is a tenant table — ENABLE + FORCE + ws_isolation.
-- schema_v0.sql is not modified.
-- =============================================================================

CREATE TABLE IF NOT EXISTS human_control_nonce (
  workspace_id   uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  nonce          uuid NOT NULL,
  device_key_id  uuid NOT NULL REFERENCES member_device_key(id),
  -- What the statement signed (`kind` line); for the audit reader only.
  kind           text NOT NULL,
  consumed_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at     timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, nonce),
  CONSTRAINT human_control_nonce_kind_ck
    CHECK (kind IN ('spawn', 'input', 'permission', 'bundle_manifest', 'host_register'))
);

CREATE INDEX IF NOT EXISTS human_control_nonce_expiry_idx
  ON human_control_nonce (workspace_id, expires_at);

ALTER TABLE human_control_nonce ENABLE ROW LEVEL SECURITY;
ALTER TABLE human_control_nonce FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ws_isolation ON human_control_nonce;
CREATE POLICY ws_isolation ON human_control_nonce
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

COMMENT ON TABLE human_control_nonce IS
  'ADR-0146 개정 D-9 (#3023): one-time consumption of momo.human.control.v1 nonces, kept until the statement can no longer pass the time window.';
COMMENT ON COLUMN human_control_nonce.expires_at IS
  'The statement''s expires_at_ms plus the 5-minute skew window; rows older than now() are pruned by the verify path.';

-- ---- work_control: the signature columns -----------------------------------

ALTER TABLE work_control
  ADD COLUMN IF NOT EXISTS device_key_id uuid REFERENCES member_device_key(id),
  ADD COLUMN IF NOT EXISTS human_instance_id text,
  ADD COLUMN IF NOT EXISTS human_nonce uuid,
  ADD COLUMN IF NOT EXISTS human_issued_at_ms bigint,
  ADD COLUMN IF NOT EXISTS human_expires_at_ms bigint,
  ADD COLUMN IF NOT EXISTS human_mode text,
  ADD COLUMN IF NOT EXISTS human_scope text,
  ADD COLUMN IF NOT EXISTS human_spawn_agent_member_id uuid,
  ADD COLUMN IF NOT EXISTS human_spawn_folder_id text,
  ADD COLUMN IF NOT EXISTS human_signature text;

ALTER TABLE work_control DROP CONSTRAINT IF EXISTS work_control_human_signature_ck;
ALTER TABLE work_control ADD CONSTRAINT work_control_human_signature_ck CHECK (
  CASE
    WHEN human_signature IS NULL THEN
      device_key_id IS NULL AND human_instance_id IS NULL AND human_nonce IS NULL
      AND human_issued_at_ms IS NULL AND human_expires_at_ms IS NULL
      AND human_mode IS NULL AND human_scope IS NULL
      AND human_spawn_agent_member_id IS NULL AND human_spawn_folder_id IS NULL
    ELSE
      device_key_id IS NOT NULL AND human_nonce IS NOT NULL
      AND human_instance_id IS NOT NULL
      AND length(human_instance_id) BETWEEN 1 AND 256
      AND human_instance_id !~ '[[:cntrl:]]'
      AND human_issued_at_ms IS NOT NULL AND human_expires_at_ms IS NOT NULL
      AND human_expires_at_ms > human_issued_at_ms
      AND human_expires_at_ms - human_issued_at_ms <= 600000
      AND human_signature ~ '^[A-Za-z0-9+/]{86}==$'
      AND CASE kind
        WHEN 'input' THEN
          human_mode IS NOT NULL AND human_mode IN ('queue', 'interrupt')
          AND human_scope IS NULL
          AND human_spawn_agent_member_id IS NULL AND human_spawn_folder_id IS NULL
        WHEN 'permission' THEN
          human_scope IS NOT NULL AND human_scope IN ('once', 'session')
          AND human_mode IS NULL
          AND human_spawn_agent_member_id IS NULL AND human_spawn_folder_id IS NULL
        WHEN 'spawn' THEN
          human_spawn_agent_member_id IS NOT NULL
          AND human_spawn_folder_id IS NOT NULL
          AND length(human_spawn_folder_id) BETWEEN 1 AND 256
          AND human_mode IS NULL AND human_scope IS NULL
        ELSE false
      END
  END
);

-- A nonce authorizes one control (the nonce table already makes it one-time;
-- this keeps the ledger honest if a path ever wrote the columns without it).
CREATE UNIQUE INDEX IF NOT EXISTS work_control_human_nonce_uniq
  ON work_control (workspace_id, human_nonce)
  WHERE human_nonce IS NOT NULL;

COMMENT ON COLUMN work_control.human_signature IS
  'ADR-0146 개정 D-10 (#3023): canonical low-s P-256 r‖s over momo.human.control.v1, relayed to the host as WorkControl.humanSignature. NULL = unsigned.';
COMMENT ON COLUMN work_control.human_instance_id IS
  'The instance id line of the signed statement (MOMO_INSTANCE_ID when it was verified).';

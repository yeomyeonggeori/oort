-- =============================================================================
-- 092_work_permission_request.sql — #3000 (ADR-0188 D5 권한 다리, §8.6 증보)
--
-- ACP `session/request_permission` becomes an oort decision the session's
-- owner makes, and the decision travels back to the host as a `permission`
-- control. Two halves, one file (ADR-0188 §6: 「새 migration은 R1에 하나다」):
--
--   work_permission_request
--       One row per permission request a host relayed as an
--       `approval.requested` session event. The row is keyed by that event's
--       id — the host-issued one-time nonce D5 binds the request to — and by
--       the session and the host it came from. The existing `approval` table is
--       `run_id NOT NULL` (agent_run) and cannot hold a work session's request.
--
--       Only the session owner decides, once: the first `pending → approved |
--       rejected` UPDATE wins. `expired` (the deadline passed) and `cancelled`
--       (the turn, the session or the host went away) are terminal as well.
--       The decided option and its kind are recorded; the kind is closed to
--       `allow_once` | `reject_once` (D5: 「항상 허용」 is never chosen here).
--
--   work_control kind 'permission'
--       The decision, addressed to the host. Created by the server inside the
--       decision transaction and nowhere else (D3). Its payload is closed:
--       exactly the request's event id, the chosen option id and its kind.
--
-- RLS: the new table is a tenant table — ENABLE + FORCE + ws_isolation, the
-- same policy 020 gives work_control. schema_v0.sql is not modified.
-- =============================================================================

CREATE TABLE work_permission_request (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id        uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  work_session_id     uuid NOT NULL REFERENCES work_session(id) ON DELETE CASCADE,
  host_id             uuid NOT NULL REFERENCES work_host(id) ON DELETE CASCADE,
  channel_id          uuid NOT NULL REFERENCES channel(id) ON DELETE CASCADE,
  -- The `approval.requested` event id: host-issued, one per request.
  request_event_id    uuid NOT NULL,
  -- [{option_id, kind}] as the host offered them — only the kinds this bridge
  -- can choose (allow_once, reject_once) are ever stored.
  options             jsonb NOT NULL,
  status              text NOT NULL DEFAULT 'pending',
  expires_at          timestamptz NOT NULL,
  decided_by          uuid REFERENCES member(id),
  decided_option_id   text,
  decided_kind        text,
  decided_at          timestamptz,
  control_id          uuid REFERENCES work_control(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT work_permission_request_status_ck
    CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'cancelled')),
  CONSTRAINT work_permission_request_options_ck CHECK (
    jsonb_typeof(options) = 'array'
    AND jsonb_array_length(options) BETWEEN 1 AND 16
  ),
  CONSTRAINT work_permission_request_decided_kind_ck
    CHECK (decided_kind IS NULL OR decided_kind IN ('allow_once', 'reject_once')),
  -- A decision names who, what and when; nothing else carries any of them.
  CONSTRAINT work_permission_request_decided_ck CHECK (
    CASE status
      WHEN 'approved' THEN
        decided_by IS NOT NULL AND decided_at IS NOT NULL
        AND decided_option_id IS NOT NULL AND decided_kind = 'allow_once'
      WHEN 'rejected' THEN
        decided_by IS NOT NULL AND decided_at IS NOT NULL
        AND decided_option_id IS NOT NULL AND decided_kind = 'reject_once'
      ELSE
        decided_by IS NULL AND decided_option_id IS NULL AND decided_kind IS NULL
    END
  ),
  CONSTRAINT work_permission_request_event_uniq
    UNIQUE (workspace_id, work_session_id, request_event_id)
);

CREATE INDEX work_permission_request_pending_idx
  ON work_permission_request (workspace_id, work_session_id)
  WHERE status = 'pending';
CREATE INDEX work_permission_request_host_pending_idx
  ON work_permission_request (workspace_id, host_id)
  WHERE status = 'pending';

ALTER TABLE work_permission_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_permission_request FORCE ROW LEVEL SECURITY;
CREATE POLICY ws_isolation ON work_permission_request
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

COMMENT ON TABLE work_permission_request IS
  'ADR-0188 D5: an ACP permission request relayed by a member host, decided once by the session owner (#3000).';

-- ---- work_control: the `permission` kind -----------------------------------

ALTER TABLE work_control DROP CONSTRAINT work_control_kind_ck;
ALTER TABLE work_control ADD CONSTRAINT work_control_kind_ck
  CHECK (kind IN ('spawn', 'input', 'read', 'kill', 'permission'));

-- 029's body, unchanged, plus the closed `permission` arm.
ALTER TABLE work_control DROP CONSTRAINT work_control_payload_ck;
ALTER TABLE work_control ADD CONSTRAINT work_control_payload_ck CHECK (
  jsonb_typeof(payload) = 'object'
  AND CASE kind
    WHEN 'spawn' THEN
      payload ? 'tool'
      AND payload ? 'label'
      AND payload - ARRAY['tool', 'label']::text[] = '{}'::jsonb
      AND jsonb_typeof(payload->'tool') = 'string'
      AND payload->>'tool' ~ '^[a-z0-9][a-z0-9._-]{1,63}$'
      AND jsonb_typeof(payload->'label') = 'string'
      AND length(btrim(payload->>'label')) BETWEEN 1 AND 120
    WHEN 'input' THEN
      payload ? 'text'
      AND payload - ARRAY['text']::text[] = '{}'::jsonb
      AND jsonb_typeof(payload->'text') = 'string'
      AND length(payload->>'text') BETWEEN 1 AND 32768
    WHEN 'read' THEN
      payload - ARRAY['tail_lines']::text[] = '{}'::jsonb
      AND (
        NOT payload ? 'tail_lines'
        OR (
          jsonb_typeof(payload->'tail_lines') = 'number'
          AND payload->>'tail_lines' ~ '^[1-9][0-9]{0,3}$'
        )
      )
    WHEN 'kill' THEN payload = '{}'::jsonb
    WHEN 'permission' THEN
      payload ? 'request_event_id'
      AND payload ? 'option_id'
      AND payload ? 'kind'
      AND payload - ARRAY['request_event_id', 'option_id', 'kind']::text[] = '{}'::jsonb
      AND jsonb_typeof(payload->'request_event_id') = 'string'
      AND payload->>'request_event_id'
        ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      AND jsonb_typeof(payload->'option_id') = 'string'
      AND length(payload->>'option_id') BETWEEN 1 AND 128
      AND jsonb_typeof(payload->'kind') = 'string'
      AND payload->>'kind' IN ('allow_once', 'reject_once')
    ELSE false
  END
);

-- One decision control per request, whatever a retry does.
CREATE UNIQUE INDEX work_control_permission_request_uniq
  ON work_control (workspace_id, session_id, (payload->>'request_event_id'))
  WHERE kind = 'permission';

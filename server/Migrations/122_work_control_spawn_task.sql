-- =============================================================================
-- 122_work_control_spawn_task.sql — #3570 T5 / ADR-0198 D4 · 증보 1 D7 /
-- ADR-0146 (E8의 빈칸)
--
-- The owner's signed NEW-WORK spawn (`momo.human.control.v4`). Until now the
-- only signed spawn was a resume: its statement names an agent and a folder
-- and carries the session's 120-character title as the "prompt". A new task is
-- made of more, and the owner signs all of it:
--
--   * the whole prompt          -> `payload.prompt` (1..32768, the `input`
--                                  bound), beside `tool` (the harness) and
--                                  `label` (the short card title, unsigned
--                                  display text);
--   * the agent member, or none -> `human_spawn_agent_member_id` becomes
--                                  nullable for a new-work spawn: a harness
--                                  spawn (「내 도구」, ADR-0198 D1) has no
--                                  member behind it. A resume still needs one;
--   * the thread and the message the owner called from
--                               -> `human_spawn_thread_root_id`,
--                                  `human_spawn_origin_message_id`
--                                  (ADR-0198 증보 1 D7). Columns beside the
--                                  payload, as 095 did for the signature: the
--                                  payload stays what the host acts on.
--
-- `payload ? 'prompt'` is what makes a control a new-work spawn. It is only
-- ever written by the signed route, so:
--   * an unsigned control cannot carry a prompt (an agent bearer's spawn is
--     `{tool,label}` and nothing else);
--   * only a new-work spawn may leave the agent NULL or name a thread/message;
--   * every other kind keeps the thread/message columns NULL.
--
-- Every arm tests IS NOT NULL before IN (a NULL CHECK passes). Re-runnable
-- (DROP-then-ADD). `work_control` is already ENABLE + FORCE RLS; no table is
-- added. schema_v0.sql is not modified.
-- =============================================================================

ALTER TABLE work_control
  ADD COLUMN IF NOT EXISTS human_spawn_thread_root_id uuid,
  ADD COLUMN IF NOT EXISTS human_spawn_origin_message_id uuid;

-- ---- payload: the spawn arm gains an optional `prompt` ---------------------

ALTER TABLE work_control DROP CONSTRAINT IF EXISTS work_control_payload_ck;
ALTER TABLE work_control ADD CONSTRAINT work_control_payload_ck CHECK (
  jsonb_typeof(payload) = 'object'
  AND CASE kind
    WHEN 'spawn' THEN
      payload ? 'tool'
      AND payload ? 'label'
      AND payload - ARRAY['tool', 'label', 'prompt']::text[] = '{}'::jsonb
      AND jsonb_typeof(payload->'tool') = 'string'
      AND payload->>'tool' ~ '^[a-z0-9][a-z0-9._-]{1,63}$'
      AND jsonb_typeof(payload->'label') = 'string'
      AND length(btrim(payload->>'label')) BETWEEN 1 AND 120
      AND (
        NOT payload ? 'prompt'
        OR (
          jsonb_typeof(payload->'prompt') = 'string'
          AND length(payload->>'prompt') BETWEEN 1 AND 32768
        )
      )
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

-- ---- signature columns: the spawn arm -------------------------------------

ALTER TABLE work_control DROP CONSTRAINT IF EXISTS work_control_human_signature_ck;
ALTER TABLE work_control ADD CONSTRAINT work_control_human_signature_ck CHECK (
  CASE
    WHEN human_signature IS NULL THEN
      device_key_id IS NULL AND human_instance_id IS NULL AND human_nonce IS NULL
      AND human_issued_at_ms IS NULL AND human_expires_at_ms IS NULL
      AND human_mode IS NULL AND human_scope IS NULL
      AND human_spawn_agent_member_id IS NULL AND human_spawn_folder_id IS NULL
      AND human_spawn_thread_root_id IS NULL AND human_spawn_origin_message_id IS NULL
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
          AND human_spawn_thread_root_id IS NULL AND human_spawn_origin_message_id IS NULL
        WHEN 'permission' THEN
          human_scope IS NOT NULL AND human_scope IN ('once', 'session')
          AND human_mode IS NULL
          AND human_spawn_agent_member_id IS NULL AND human_spawn_folder_id IS NULL
          AND human_spawn_thread_root_id IS NULL AND human_spawn_origin_message_id IS NULL
        WHEN 'spawn' THEN
          human_spawn_folder_id IS NOT NULL
          AND length(human_spawn_folder_id) BETWEEN 1 AND 256
          AND human_mode IS NULL AND human_scope IS NULL
          AND CASE
            -- A new-work spawn (v4): the agent is optional (a harness spawn
            -- has none), the thread/message are the room position it was
            -- called from.
            WHEN payload ? 'prompt' THEN true
            -- A resume (v2): an agent, and no position.
            ELSE human_spawn_agent_member_id IS NOT NULL
              AND human_spawn_thread_root_id IS NULL
              AND human_spawn_origin_message_id IS NULL
          END
        ELSE false
      END
  END
);

-- A prompt exists only on a signed spawn: it is the owner's statement, and the
-- host re-verifies the signature over exactly these words.
ALTER TABLE work_control DROP CONSTRAINT IF EXISTS work_control_prompt_signed_ck;
ALTER TABLE work_control ADD CONSTRAINT work_control_prompt_signed_ck CHECK (
  NOT (kind = 'spawn' AND payload ? 'prompt') OR human_signature IS NOT NULL
);

COMMENT ON COLUMN work_control.human_spawn_thread_root_id IS
  'ADR-0198 증보 1 D7 (#3570): the thread the owner called from, as the v4 statement named it. NULL = the room''s main line or not a new-work spawn.';
COMMENT ON COLUMN work_control.human_spawn_origin_message_id IS
  'ADR-0198 증보 1 D7 (#3570): the message the owner called from, as the v4 statement named it. NULL = not triggered by a message.';

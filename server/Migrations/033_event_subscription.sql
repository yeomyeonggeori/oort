-- =============================================================================
-- 033_event_subscription.sql — MOMO-535 outbound event subscriptions
--
-- Workspace administrators register public HTTPS webhook targets. The random
-- secret_ref is non-secret derivation material; the signing secret is derived
-- from the server-owned master key, revealed only by the create response, and
-- never persisted. Event triggers enqueue id-only/safe projections in the same
-- transaction as the source mutation. OutboxRelay owns network delivery.
-- =============================================================================

ALTER TYPE outbox_kind ADD VALUE 'webhook_delivery';

CREATE TABLE event_subscription (
  id                    uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id          uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  url                   text NOT NULL,
  secret_ref            text NOT NULL,
  event_kinds           text[] NOT NULL,
  enabled               boolean NOT NULL DEFAULT true,
  delivery_failure_count integer NOT NULL DEFAULT 0,
  disabled_at           timestamptz,
  disabled_reason       text,
  created_by            uuid NOT NULL,
  updated_by            uuid NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT event_subscription_url_ck CHECK (
    length(url) BETWEEN 1 AND 2048
  ),
  CONSTRAINT event_subscription_secret_ref_ck CHECK (
    secret_ref ~ '^[A-Za-z0-9_-]{43}$'
  ),
  CONSTRAINT event_subscription_event_kinds_ck CHECK (
    cardinality(event_kinds) BETWEEN 1 AND 3
    AND event_kinds <@ ARRAY['mention','approval_request','work.status_changed']::text[]
  ),
  CONSTRAINT event_subscription_failure_count_ck CHECK (
    delivery_failure_count >= 0
  ),
  CONSTRAINT event_subscription_disable_ck CHECK (
    (enabled AND disabled_at IS NULL AND disabled_reason IS NULL)
    OR (NOT enabled)
  ),
  CONSTRAINT event_subscription_created_by_workspace_fk
    FOREIGN KEY (workspace_id, created_by) REFERENCES member(workspace_id, id),
  CONSTRAINT event_subscription_updated_by_workspace_fk
    FOREIGN KEY (workspace_id, updated_by) REFERENCES member(workspace_id, id)
);

CREATE INDEX event_subscription_workspace_enabled_idx
  ON event_subscription (workspace_id, created_at DESC)
  WHERE enabled;

COMMENT ON TABLE event_subscription IS
  'Outbound webhook destination and non-secret derivation reference; raw signing secrets are never stored.';

ALTER TABLE event_subscription ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_subscription FORCE ROW LEVEL SECURITY;
CREATE POLICY ws_isolation ON event_subscription
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

-- Enqueue one delivery for every enabled subscription interested in the event.
-- The source row and delivery intent commit atomically through the existing
-- transactional outbox. No URL or secret material is copied into the outbox.
CREATE FUNCTION enqueue_event_subscription_delivery(
  event_workspace_id uuid,
  event_kind text,
  event_id uuid,
  event_occurred_at timestamptz,
  event_data jsonb
) RETURNS void AS $$
BEGIN
  INSERT INTO outbox (workspace_id, kind, method, payload, partition_key)
  SELECT s.workspace_id,
         'webhook_delivery',
         'post',
         jsonb_build_object(
           'schema', 'momo.webhook_delivery.v1',
           'subscription_id', s.id,
           'event', jsonb_build_object(
             'schema', 'momo.event.v0',
             'id', event_id,
             'kind', event_kind,
             'workspace_id', event_workspace_id,
             'occurred_at', event_occurred_at,
             'data', event_data
           )
         ),
         s.id
    FROM event_subscription s
   WHERE s.workspace_id = event_workspace_id
     AND s.enabled
     AND event_kind = ANY(s.event_kinds);
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION message_event_subscription_enqueue() RETURNS trigger AS $$
DECLARE
  old_mentions jsonb;
  new_mentions jsonb;
BEGIN
  old_mentions := CASE WHEN TG_OP = 'UPDATE'
    THEN COALESCE(OLD.props->'mention_member_ids', '[]'::jsonb)
    ELSE '[]'::jsonb
  END;
  new_mentions := COALESCE(NEW.props->'mention_member_ids', '[]'::jsonb);

  IF jsonb_typeof(new_mentions) = 'array'
     AND jsonb_array_length(new_mentions) > 0
     AND (jsonb_typeof(old_mentions) <> 'array' OR jsonb_array_length(old_mentions) = 0)
  THEN
    PERFORM enqueue_event_subscription_delivery(
      NEW.workspace_id,
      'mention',
      NEW.id,
      NEW.created_at,
      jsonb_build_object(
        'message_id', NEW.id,
        'channel_id', NEW.channel_id,
        'seq', NEW.seq,
        'author_member_id', NEW.author_member_id,
        'message_type', NEW.type,
        'body', NEW.body,
        'mention_member_ids', new_mentions,
        'root_id', NEW.root_id,
        'run_id', NEW.run_id
      )
    );
  END IF;

  IF TG_OP = 'INSERT' AND NEW.type = 'approval_request'::message_type THEN
    PERFORM enqueue_event_subscription_delivery(
      NEW.workspace_id,
      'approval_request',
      NEW.id,
      NEW.created_at,
      jsonb_build_object(
        'message_id', NEW.id,
        'channel_id', NEW.channel_id,
        'seq', NEW.seq,
        'author_member_id', NEW.author_member_id,
        'body', NEW.body,
        'props', COALESCE(NEW.props, '{}'::jsonb),
        'run_id', NEW.run_id
      )
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER message_event_subscription_insert_trg
  AFTER INSERT ON message
  FOR EACH ROW EXECUTE FUNCTION message_event_subscription_enqueue();
CREATE TRIGGER message_event_subscription_mentions_trg
  AFTER UPDATE OF props ON message
  FOR EACH ROW EXECUTE FUNCTION message_event_subscription_enqueue();

CREATE FUNCTION work_status_event_subscription_enqueue() RETURNS trigger AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    PERFORM enqueue_event_subscription_delivery(
      NEW.workspace_id,
      'work.status_changed',
      NEW.id,
      clock_timestamp(),
      jsonb_build_object(
        'work_session_id', NEW.id,
        'channel_id', NEW.channel_id,
        'root_message_id', NEW.root_message_id,
        'member_id', NEW.member_id,
        'tool', NEW.tool,
        'previous_status', OLD.status,
        'status', NEW.status,
        'started_at', NEW.started_at,
        'ended_at', NEW.ended_at,
        'exit_code', NEW.exit_code,
        'end_reason', NEW.end_reason,
        'resumed_from_session_id', NEW.resumed_from_session_id
      )
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER work_status_event_subscription_trg
  AFTER UPDATE OF status ON work_session
  FOR EACH ROW EXECUTE FUNCTION work_status_event_subscription_enqueue();

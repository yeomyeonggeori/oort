-- =============================================================================
-- 127_inbox_item_events.sql — #3681 E2 / ADR-0199 D7
--
-- A fresh inbox_item publishes `inbox_item.created` to its recipient's personal
-- realtime channel through the transactional outbox, in the SAME transaction as
-- the message write that created the item. Same channel, envelope and relay path
-- as the read-state broadcast (ADR-0109 D3; `user:read-state#<MEMBER>`): no new
-- Centrifugo namespace, no client publish. The payload is ids only (no body,
-- ADR-0148 rule 3) — the client refetches `GET /inbox` for the content, and a
-- lost event is repaired by the next GET (Postgres is the source of truth).
--
-- Why a trigger on inbox_item rather than a change to 126's projection function:
-- the event follows the ROW, so every writer of a live item is covered and an
-- upsert that only merges reasons into an existing row (no new row) stays silent.
-- Born-read items (the recipient's cursor is already past) and rows whose source
-- message is old (a late mention, the E4 backfill) publish nothing: there is no
-- new unread to announce, and a backfill must not flood a live socket.
--
-- SECURITY INVOKER, like 126: the outbox INSERT runs under the caller's role and
-- tenant context. `inbox_item.read` / `inbox.read_all` are published by the API
-- through `momo_outbox::emit_outbox`; the cursor-driven read is already carried
-- by the read-state broadcast and publishes nothing extra.
-- =============================================================================

CREATE FUNCTION inbox_item_publish_created() RETURNS trigger AS $$
DECLARE
  v_member_token text := upper(NEW.member_id::text);
  v_channel       text := 'user:read-state#' || upper(NEW.member_id::text);
BEGIN
  IF NEW.read_at IS NOT NULL OR NEW.created_at < now() - interval '5 minutes' THEN
    RETURN NEW;
  END IF;
  INSERT INTO outbox (workspace_id, kind, method, payload, partition_key)
  VALUES (
    NEW.workspace_id,
    'broadcast',
    'publish',
    jsonb_build_object(
      'channel', v_channel,
      'data', jsonb_build_object(
        'type', 'inbox_item.created',
        'v', 1,
        'ts', (extract(epoch FROM clock_timestamp()) * 1000)::bigint,
        'payload', jsonb_build_object(
          'workspace_id', upper(NEW.workspace_id::text),
          'member_id', v_member_token,
          'item_id', upper(NEW.id::text),
          'kind', NEW.kind,
          'channel_id', upper(NEW.channel_id::text),
          'created_at', to_char(NEW.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
        )
      ),
      'idempotency_key', v_channel || ':inbox:' || upper(NEW.id::text) || ':created'
    ),
    NEW.member_id
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION inbox_item_publish_created() FROM PUBLIC;

CREATE TRIGGER inbox_item_publish_created_trg
  AFTER INSERT ON inbox_item
  FOR EACH ROW EXECUTE FUNCTION inbox_item_publish_created();

-- =============================================================================
-- 130_agent_run_event_realtime.sql — #3744 S5 / ADR-0200 D2 「실시간」
--
-- Every ledger row puts ONE thin frame on the channel topic, in the SAME transaction
-- (outbox INSERT -> relay -> Centrifugo; no client ever publishes):
--
--   { type: "agent.run.event", v: 1, payload: { run_id, channel_id, kind } }
--
-- The frame carries NO stage text and NO sequence: what a viewer may read is decided
-- by the REST read (membership) at refetch time, and the raw sequence is a cross-tenant
-- counter that must not leave the database (migration 128). The client re-reads the
-- whole ledger (<= 200 rows) on a frame.
--
-- `stage` frames are rate-limited to one per 2 seconds per run: a stage row that follows,
-- within 2 seconds, another stage row THAT EMITTED A FRAME is itself unframed (the ledger
-- row is still written). The rule is against the last FRAMED row, not the last row, so a
-- steady stream still frames every 2 seconds instead of going silent after the first
-- frame (S5 review M-1). The last row of a burst may stay unframed: a frame is a hint to
-- refetch, lifecycle rows always frame, and a client keeps refetching on a timer while a
-- run is active (the ledger is <= 200 rows).
--
-- SECURITY INVOKER: it runs as the writer (momo_app, momo_notifier) under that role's
-- grants and RLS; the notifier already holds outbox INSERT and agent_run SELECT.
-- =============================================================================

ALTER TABLE agent_run_event ADD COLUMN framed boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN agent_run_event.framed IS
  'ADR-0200 D2: whether this row put a realtime frame on the channel (stage rows within 2 s of a framed stage row do not). Set by the BEFORE INSERT trigger, never by a writer.';

CREATE FUNCTION agent_run_event_set_framed() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.framed := NOT (
    NEW.kind = 'stage' AND EXISTS (
      SELECT 1 FROM agent_run_event p
       WHERE p.workspace_id = NEW.workspace_id AND p.run_id = NEW.run_id
         AND p.kind = 'stage' AND p.framed
         AND p.created_at > NEW.created_at - interval '2 seconds')
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER agent_run_event_set_framed_trg
  BEFORE INSERT ON agent_run_event
  FOR EACH ROW EXECUTE FUNCTION agent_run_event_set_framed();

CREATE FUNCTION agent_run_event_emit_frame() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_channel uuid;
  v_topic   text;
BEGIN
  IF NOT NEW.framed THEN
    RETURN NEW;
  END IF;

  SELECT r.channel_id INTO v_channel
    FROM agent_run r
   WHERE r.workspace_id = NEW.workspace_id AND r.id = NEW.run_id;
  IF v_channel IS NULL THEN
    RETURN NEW;
  END IF;

  v_topic := 'ch:ws' || upper(NEW.workspace_id::text) || '.' || upper(v_channel::text);
  INSERT INTO outbox (workspace_id, kind, status, method, payload, partition_key)
  VALUES (
    NEW.workspace_id,
    'broadcast',
    'pending',
    'publish',
    jsonb_build_object(
      'channel', v_topic,
      'data', jsonb_build_object(
        'type', 'agent.run.event',
        'v', 1,
        'ts', (extract(epoch FROM clock_timestamp()) * 1000)::bigint,
        'payload', jsonb_build_object(
          'run_id', NEW.run_id,
          'channel_id', v_channel,
          'kind', NEW.kind
        )
      ),
      'idempotency_key', v_topic || ':agent.run.event:' || NEW.run_id::text || ':' || NEW.seq::text
    ),
    v_channel
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER agent_run_event_emit_frame_trg
  AFTER INSERT ON agent_run_event
  FOR EACH ROW EXECUTE FUNCTION agent_run_event_emit_frame();

COMMENT ON FUNCTION agent_run_event_emit_frame() IS
  'ADR-0200 D2 (#3744): one thin agent.run.event frame per framed ledger row (stage rows rate-limited to 1 per 2 s per run against the last framed one), same tx, via the outbox. No stage text, no sequence.';

-- retention scan: finished runs, oldest first
CREATE INDEX agent_run_finished_at_idx
  ON agent_run (finished_at)
  WHERE finished_at IS NOT NULL;

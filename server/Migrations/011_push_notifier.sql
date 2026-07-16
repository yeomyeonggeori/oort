-- =============================================================================
-- 011_push_notifier.sql — MOMO-404 (ADR-0120 P-2) notifier worker plumbing.
--
-- schema_v0 (001_init.sql) is untouched. This migration adds the push
-- notification candidate feed and the idempotent-dispatch invariant the
-- NotifierWorker relies on:
--
--   1. New outbox kind 'push_candidate'. The transactional outbox already
--      carries two mutually-exclusive consumer feeds (relay: kind='broadcast',
--      AgentWorker/gateway: kind='agent_job'); the notifier claims ONLY
--      kind='push_candidate', so all three consumers' claim WHERE clauses
--      exclude each other by construction. PG12+ allows ALTER TYPE ... ADD
--      VALUE inside a transaction block as long as the new value is not used
--      by DML in the same transaction — nothing below inserts outbox rows.
--
--   2. AFTER INSERT trigger on message that enqueues one push_candidate row
--      in the SAME transaction as the source message (ADR-0120 D3 durable
--      candidate + at-least-once consumption). Every message-creation path
--      (MessageRoutes REST send, AgentGatewayRoutes approval_request,
--      AgentWorker approval pause / final replies) is covered without
--      touching any server write path, and the candidate cannot be lost or
--      observed before its message commits. The candidate payload is id-only
--      by construction — no body, no display names — so conversation content
--      never enters the notification pipeline (ADR-0120 D2).
--      Judgment (DM / mention / approval / future MOMO-395 channel
--      notification settings) lives ONLY in workers/NotifierWorker (P9);
--      this trigger is deliberately unconditional: it records the activity
--      event, never who should be notified.
--
--   3. Partial unique index on push_dispatch_log that makes dispatch
--      idempotent under at-least-once candidate delivery: one dispatch-log
--      row per (member, push_token, collapse_id). The notifier claims a
--      dispatch by inserting the row (apns_status NULL = in flight), calls
--      the push relay, then settles apns_status/apns_reason. A redelivered
--      candidate sees the settled row and never re-sends (verified by
--      scripts/verify_push_notifier.sh restart/redelivery assertions).
--      push_token_id/collapse_id are always set by the notifier; the WHERE
--      clause keeps legacy NULL rows (message_id-only audit rows) out of the
--      uniqueness contract.
-- =============================================================================

ALTER TYPE outbox_kind ADD VALUE 'push_candidate';

-- The function body only references 'push_candidate' as a literal inside an
-- INSERT that runs at trigger-fire time (post-commit of this migration), so
-- the same-transaction "new enum value not usable" restriction does not apply.
CREATE FUNCTION push_candidate_enqueue() RETURNS trigger AS $$
BEGIN
  INSERT INTO outbox (workspace_id, kind, method, payload, partition_key)
  VALUES (
    NEW.workspace_id,
    'push_candidate',
    'notify',
    jsonb_build_object(
      'schema', 'momo.push_candidate.v1',
      'message_id', NEW.id,
      'channel_id', NEW.channel_id,
      'author_member_id', NEW.author_member_id,
      'message_type', NEW.type
    ),
    NEW.channel_id
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER push_candidate_enqueue_trg
  AFTER INSERT ON message
  FOR EACH ROW EXECUTE FUNCTION push_candidate_enqueue();

CREATE UNIQUE INDEX push_dispatch_dedupe_uniq
  ON push_dispatch_log (member_id, push_token_id, collapse_id)
  WHERE push_token_id IS NOT NULL AND collapse_id IS NOT NULL;

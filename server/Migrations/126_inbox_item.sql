-- =============================================================================
-- 126_inbox_item.sql — #3680 E1 / ADR-0199 D1~D5
--
-- The inbox projection: one row per (recipient member, message) that is
-- "related to me" — a mention, a quote-reply to my message, a reply in a thread
-- I take part in, or a message in a DM. `message` stays the source of truth; the
-- projection is a derived, rebuildable copy that carries only ids and the
-- member's own state (`read_at`). No body snapshot (ADR-0148 rule 3).
--
-- Writers (all in the SAME transaction as the source write, no new transport):
--   * AFTER INSERT ON message           — reply_to_me / thread_reply / dm
--     (and mention, if the producer wrote props.mention_member_ids in the INSERT)
--   * AFTER UPDATE OF props ON message  — mention: `record_mentions_in_tx`
--     writes `props.mention_member_ids` in an UPDATE right after the INSERT
--   * AFTER INSERT/UPDATE OF last_read_seq ON read_state — cursor -> item
--     auto-read (D3, one direction only: an item read never moves the cursor)
--
-- Why a trigger and not application calls (ADR-0199 D1): `send_message_in_tx`
-- is `MentionPolicy::Skip` — agent final replies, approval/work cards and
-- gateway completions go through it, so a quote-reply an agent sends records no
-- mention ledger at all. The trigger reads `message.reply_to_id` itself, so every
-- producer is covered by one rule.
--
-- Security: every function here is SECURITY INVOKER. The triggers run inside the
-- caller's transaction under that caller's role and `app.workspace_id`, so RLS
-- (FORCE) applies to the inbox_item write and to every lookup the trigger makes.
-- No SECURITY DEFINER, no BYPASSRLS. Trigger functions cannot be called from SQL.
-- =============================================================================

CREATE TABLE inbox_item (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id    uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  member_id       uuid NOT NULL REFERENCES member(id) ON DELETE CASCADE,
  -- highest-priority reason (reply_to_me > mention > thread_reply > dm)
  kind            text NOT NULL,
  -- every reason that applies, ordered by the same priority; reasons[1] = kind
  reasons         text[] NOT NULL,
  channel_id      uuid NOT NULL REFERENCES channel(id) ON DELETE CASCADE,
  message_id      uuid NOT NULL REFERENCES message(id) ON DELETE CASCADE,
  seq             bigint NOT NULL,
  actor_member_id uuid NOT NULL REFERENCES member(id) ON DELETE CASCADE,
  -- the source message's created_at, so ordering/backfill follow the
  -- conversation, not the moment the projection row was written
  created_at      timestamptz NOT NULL,
  read_at         timestamptz,
  CONSTRAINT inbox_item_kind_ck
    CHECK (kind IN ('reply_to_me', 'mention', 'thread_reply', 'dm')),
  CONSTRAINT inbox_item_reasons_ck
    CHECK (
      cardinality(reasons) BETWEEN 1 AND 4
      AND reasons <@ ARRAY['reply_to_me', 'mention', 'thread_reply', 'dm']::text[]
      AND reasons[1] = kind
    ),
  -- one row per message per recipient (ADR-0199 D2/D5)
  CONSTRAINT inbox_item_member_message_uq UNIQUE (member_id, message_id),
  -- the author is never their own recipient
  CONSTRAINT inbox_item_not_self_ck CHECK (member_id <> actor_member_id)
);

-- list, newest first, keyset (created_at, id)
CREATE INDEX inbox_item_member_created_idx
  ON inbox_item (workspace_id, member_id, created_at DESC, id DESC);
-- unread badge / unread filter
CREATE INDEX inbox_item_member_unread_idx
  ON inbox_item (workspace_id, member_id, created_at DESC, id DESC)
  WHERE read_at IS NULL;
-- cursor -> item auto-read
CREATE INDEX inbox_item_cursor_idx
  ON inbox_item (member_id, channel_id, seq)
  WHERE read_at IS NULL;
-- 30-day retention sweep of read items (E2)
CREATE INDEX inbox_item_read_retention_idx
  ON inbox_item (read_at)
  WHERE read_at IS NOT NULL;

COMMENT ON TABLE inbox_item IS
  'ADR-0199: per-recipient inbox projection derived from message (ids + own read_at only). '
  'Rebuildable from message; the member boundary inside a workspace is a query predicate '
  '(bearer member_id), the tenant boundary is RLS FORCE.';

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['inbox_item'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', t);
    EXECUTE format($f$
      CREATE POLICY ws_isolation ON %I
      USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
      WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);
    $f$, t);
  END LOOP;
END $$;

-- -----------------------------------------------------------------------------
-- reason priority (ADR-0199 D2): reply_to_me > mention > thread_reply > dm
-- -----------------------------------------------------------------------------
CREATE FUNCTION inbox_reason_prio(p_reason text) RETURNS int AS $$
  SELECT CASE p_reason
    WHEN 'reply_to_me'  THEN 1
    WHEN 'mention'      THEN 2
    WHEN 'thread_reply' THEN 3
    WHEN 'dm'           THEN 4
    ELSE 99
  END;
$$ LANGUAGE sql IMMUTABLE PARALLEL SAFE;

-- -----------------------------------------------------------------------------
-- message -> inbox_item
-- -----------------------------------------------------------------------------
CREATE FUNCTION inbox_item_project_message() RETURNS trigger AS $$
DECLARE
  v_quoted_author uuid;
  v_channel_kind  channel_kind;
  v_mentions      jsonb;
  v_insert        boolean := (TG_OP = 'INSERT');
BEGIN
  -- Only human-readable conversation turns. tool_call/tool_result/diff/system
  -- rows are machinery, approval_request is a live "pending approval" fact that
  -- the API merges at read time (ADR-0199 D2).
  IF NEW.type NOT IN ('text'::message_type, 'artifact'::message_type)
     OR NEW.deleted_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- Rule 2 of ADR-0148: a quote target outside this channel names nobody.
  IF NEW.reply_to_id IS NOT NULL THEN
    SELECT q.author_member_id INTO v_quoted_author
      FROM message q
     WHERE q.id = NEW.reply_to_id
       AND q.channel_id = NEW.channel_id;
  END IF;
  -- On UPDATE OF props only the mention set can be new: the reply/thread/dm
  -- reasons were decided at INSERT and are not re-derived (the quoted author is
  -- still resolved so the rule-5 mention is not counted a second time).
  IF v_insert THEN
    SELECT c.kind INTO v_channel_kind FROM channel c WHERE c.id = NEW.channel_id;
  END IF;

  v_mentions := NEW.props -> 'mention_member_ids';
  IF v_mentions IS NULL OR jsonb_typeof(v_mentions) <> 'array' THEN
    v_mentions := '[]'::jsonb;
  END IF;

  WITH cand(member_id, reason) AS (
    -- reply_to_me: the author of the quoted message, in or out of a thread
    SELECT v_quoted_author, 'reply_to_me'
     WHERE v_insert AND v_quoted_author IS NOT NULL
    UNION ALL
    -- mention: server-recorded @mentions; the quoted author is reply_to_me, not
    -- a mention (ADR-0148 rule 5 puts them in the same id list)
    SELECT t.member_id, 'mention'
      FROM (SELECT CASE WHEN x.v ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                        THEN x.v::uuid END AS member_id
              FROM jsonb_array_elements_text(v_mentions) AS x(v)) t
     WHERE t.member_id IS NOT NULL
       AND t.member_id IS DISTINCT FROM v_quoted_author
    UNION ALL
    -- thread_reply: the thread root's author and everyone who already wrote in it
    SELECT p.member_id, 'thread_reply'
      FROM (SELECT r.author_member_id AS member_id FROM message r
             WHERE v_insert AND NEW.root_id IS NOT NULL AND r.id = NEW.root_id
            UNION
            SELECT r.author_member_id FROM message r
             WHERE v_insert AND NEW.root_id IS NOT NULL AND r.root_id = NEW.root_id) p
    UNION ALL
    -- dm: everyone else in a DM channel
    SELECT ms.member_id, 'dm'
      FROM membership ms
     WHERE v_insert AND v_channel_kind = 'dm'::channel_kind
       AND ms.channel_id = NEW.channel_id
       AND ms.left_at IS NULL
  ),
  agg AS (
    SELECT d.member_id,
           array_agg(d.reason ORDER BY inbox_reason_prio(d.reason)) AS reasons
      FROM (SELECT DISTINCT c.member_id, c.reason FROM cand c) d
     GROUP BY d.member_id
  )
  INSERT INTO inbox_item
    (workspace_id, member_id, kind, reasons, channel_id, message_id, seq,
     actor_member_id, created_at, read_at)
  SELECT NEW.workspace_id, a.member_id, a.reasons[1], a.reasons,
         NEW.channel_id, NEW.id, NEW.seq, NEW.author_member_id, NEW.created_at,
         -- a message the recipient's cursor is already past (a late mention on an
         -- old message) is born read, so it does not sit unread forever
         CASE WHEN EXISTS (
                SELECT 1 FROM read_state rs
                 WHERE rs.channel_id = NEW.channel_id
                   AND rs.member_id = a.member_id
                   AND rs.last_read_seq >= NEW.seq)
              THEN now() END
    FROM agg a
    -- recipients must be an active human who is still in the channel; the author
    -- never notifies themselves (ADR-0199 D2). Agents have their own inbox
    -- (hosted inbox, ADR-0162).
    JOIN membership ms
      ON ms.channel_id = NEW.channel_id
     AND ms.member_id = a.member_id
     AND ms.left_at IS NULL
    JOIN member m
      ON m.id = a.member_id
     AND m.workspace_id = NEW.workspace_id
     AND m.kind = 'human'::member_kind
     AND m.status = 'active'::member_status
     AND m.deleted_at IS NULL
   WHERE a.member_id <> NEW.author_member_id
  ON CONFLICT (member_id, message_id) DO UPDATE
     SET reasons = (SELECT array_agg(u.r ORDER BY inbox_reason_prio(u.r))
                      FROM (SELECT DISTINCT unnest(inbox_item.reasons || EXCLUDED.reasons) AS r) u),
         kind = (SELECT (array_agg(u.r ORDER BY inbox_reason_prio(u.r)))[1]
                   FROM (SELECT DISTINCT unnest(inbox_item.reasons || EXCLUDED.reasons) AS r) u);

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION inbox_item_project_message() FROM PUBLIC;

CREATE TRIGGER inbox_item_project_insert_trg
  AFTER INSERT ON message
  FOR EACH ROW EXECUTE FUNCTION inbox_item_project_message();

-- record_mentions_in_tx writes props.mention_member_ids in an UPDATE right after
-- the INSERT, in the same transaction.
CREATE TRIGGER inbox_item_project_mentions_trg
  AFTER UPDATE OF props ON message
  FOR EACH ROW
  WHEN ((NEW.props -> 'mention_member_ids') IS DISTINCT FROM (OLD.props -> 'mention_member_ids'))
  EXECUTE FUNCTION inbox_item_project_message();

-- -----------------------------------------------------------------------------
-- read_state cursor -> inbox_item.read_at (ADR-0199 D3, one direction)
-- Monotonic: only NULL read_at is filled, nothing is ever un-read (so a
-- mark-unread, ADR-0178, which lowers no cursor, cannot flip an item back).
-- -----------------------------------------------------------------------------
CREATE FUNCTION inbox_item_read_by_cursor() RETURNS trigger AS $$
BEGIN
  UPDATE inbox_item
     SET read_at = now()
   WHERE workspace_id = NEW.workspace_id
     AND member_id = NEW.member_id
     AND channel_id = NEW.channel_id
     AND seq <= NEW.last_read_seq
     AND read_at IS NULL;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION inbox_item_read_by_cursor() FROM PUBLIC;

CREATE TRIGGER inbox_item_read_insert_trg
  AFTER INSERT ON read_state
  FOR EACH ROW WHEN (NEW.last_read_seq > 0)
  EXECUTE FUNCTION inbox_item_read_by_cursor();

CREATE TRIGGER inbox_item_read_update_trg
  AFTER UPDATE OF last_read_seq ON read_state
  FOR EACH ROW WHEN (NEW.last_read_seq > OLD.last_read_seq)
  EXECUTE FUNCTION inbox_item_read_by_cursor();

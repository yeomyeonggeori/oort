-- =============================================================================
-- 055_workstream.sql — MOMO-671 / ADR-0143 D1-D3
--
-- Workstream is the goal layer that ADR-0114 never had. It anchors on the
-- thread root message (it does NOT replace the thread) and owns continuity, so
-- work_session.member_id narrows to "the actor of this Run" and is never
-- transferred. Implicit creation lives in the ledger, not in one REST handler:
-- every work_session insert path (human create, human resume, notifier
-- automatic resume, fixtures) goes through the same BEFORE INSERT trigger, so
-- there is no code path that can produce an unattached Run.
--
-- Migration 054 is reserved by a parallel lane; this file is 055 by contract.
-- =============================================================================

CREATE TABLE workstream (
  id                   uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id         uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  channel_id           uuid NOT NULL REFERENCES channel(id) ON DELETE CASCADE,
  -- The anchor thread. UNIQUE keeps the ADR-0143 default of one workstream per
  -- thread; explicit split/merge is P2 and would relax this deliberately.
  root_message_id      uuid NOT NULL UNIQUE REFERENCES message(id) ON DELETE CASCADE,
  goal                 text NOT NULL,
  status               text NOT NULL DEFAULT 'active',
  -- The member who opened the workstream. This is provenance, not ownership:
  -- resume eligibility derives from channel membership (D3), never from here.
  created_by_member_id uuid NOT NULL REFERENCES member(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workstream_status_ck
    CHECK (status IN ('active', 'paused', 'done', 'cancelled')),
  CONSTRAINT workstream_goal_ck
    CHECK (length(btrim(goal)) BETWEEN 1 AND 200),
  CONSTRAINT workstream_workspace_id_id_uniq UNIQUE (workspace_id, id)
);

COMMENT ON TABLE workstream IS
  'ADR-0143 D1 goal layer anchored on a thread root message. Continuity lives here; work_session rows are its Runs.';
COMMENT ON COLUMN workstream.created_by_member_id IS
  'ADR-0143 D2 provenance only. Resume eligibility is channel membership (D3), never this column.';

CREATE INDEX workstream_workspace_created_idx
  ON workstream (workspace_id, created_at DESC, id DESC);
CREATE INDEX workstream_channel_created_idx
  ON workstream (workspace_id, channel_id, created_at DESC, id DESC);

ALTER TABLE work_session
  ADD COLUMN workstream_id uuid;

-- Composite FK: a Run can never point at another tenant's workstream even if
-- application code hands over a foreign uuid. CASCADE (not RESTRICT) because
-- both tables already cascade from the same anchor message; a RESTRICT edge
-- between them would make that existing cascade fail depending on order.
ALTER TABLE work_session
  ADD CONSTRAINT work_session_workstream_fk
  FOREIGN KEY (workspace_id, workstream_id)
  REFERENCES workstream (workspace_id, id)
  ON DELETE CASCADE;

-- -----------------------------------------------------------------------------
-- Backfill: one workstream per existing thread, then link every Run.
-- work_session/message carry FORCE RLS, so the table owner is subject to the
-- tenant policy too; this block turns row security off exactly like the seed
-- migrations (002/005/012) do.
-- -----------------------------------------------------------------------------
SET LOCAL row_security = off;

-- Every projected value comes from a typed work_session column (no literals in
-- the SELECT branch), and the two derived expressions carry explicit ::text —
-- an INSERT...SELECT does not coerce a SELECT branch to the target column type.
INSERT INTO workstream
  (workspace_id, channel_id, root_message_id, goal, status,
   created_by_member_id, created_at, updated_at)
SELECT thread.workspace_id,
       thread.channel_id,
       thread.root_message_id,
       thread.goal,
       thread.status,
       thread.created_by_member_id,
       thread.created_at,
       thread.created_at
  FROM (
    SELECT ws.root_message_id,
           min(ws.started_at) AS created_at,
           (array_agg(ws.workspace_id ORDER BY ws.started_at, ws.id))[1]
             AS workspace_id,
           (array_agg(ws.channel_id ORDER BY ws.started_at, ws.id))[1]
             AS channel_id,
           (array_agg(ws.member_id ORDER BY ws.started_at, ws.id))[1]
             AS created_by_member_id,
           left(
             btrim((array_agg(ws.label ORDER BY ws.started_at, ws.id))[1]),
             200
           )::text AS goal,
           CASE
             WHEN bool_or(ws.status <> 'ended') THEN 'active'::text
             ELSE 'done'::text
           END::text AS status
      FROM work_session ws
     GROUP BY ws.root_message_id
  ) AS thread;

UPDATE work_session ws
   SET workstream_id = w.id
  FROM workstream w
 WHERE w.root_message_id = ws.root_message_id
   AND ws.workstream_id IS NULL;

SET LOCAL row_security = on;

-- Fails loudly (named NOT NULL violation) if the backfill above ever leaves a
-- Run unattached, instead of shipping a half-linked ledger.
ALTER TABLE work_session
  ALTER COLUMN workstream_id SET NOT NULL;

CREATE INDEX work_session_workstream_started_idx
  ON work_session (workstream_id, started_at, id);

-- -----------------------------------------------------------------------------
-- Implicit creation (ADR-0143 D1): the first Run in a thread creates the
-- workstream; every later Run in the same thread joins it. No declaration ritual
-- and no new write path — the existing REST insert is still the only entrypoint.
-- -----------------------------------------------------------------------------
CREATE FUNCTION work_session_attach_workstream() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_workstream_id uuid;
BEGIN
  IF NEW.workstream_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT w.id
    INTO v_workstream_id
    FROM workstream w
   WHERE w.workspace_id = NEW.workspace_id
     AND w.root_message_id = NEW.root_message_id;

  IF v_workstream_id IS NULL THEN
    INSERT INTO workstream
      (workspace_id, channel_id, root_message_id, goal, created_by_member_id)
    VALUES
      (NEW.workspace_id, NEW.channel_id, NEW.root_message_id,
       left(btrim(NEW.label), 200), NEW.member_id)
    -- Concurrent first Runs on one thread: the loser adopts the winner's row
    -- rather than failing. DO UPDATE (not DO NOTHING) so RETURNING always fires.
    ON CONFLICT (root_message_id)
    DO UPDATE SET updated_at = workstream.updated_at
    RETURNING id INTO v_workstream_id;
  END IF;

  NEW.workstream_id := v_workstream_id;
  RETURN NEW;
END $$;

COMMENT ON FUNCTION work_session_attach_workstream() IS
  'ADR-0143 D1 implicit creation. Every work_session insert path attaches to the thread workstream through this trigger.';

CREATE TRIGGER work_session_attach_workstream_trg
  BEFORE INSERT ON work_session
  FOR EACH ROW
  EXECUTE FUNCTION work_session_attach_workstream();

-- -----------------------------------------------------------------------------
-- FORCE RLS, same tenant predicate as work_session (019). Agents are members, so
-- ADR-0143 D3 needs no new gate: channel membership is checked in SQL by the
-- read routes and by the resume path.
-- -----------------------------------------------------------------------------
ALTER TABLE workstream ENABLE ROW LEVEL SECURITY;
ALTER TABLE workstream FORCE ROW LEVEL SECURITY;
CREATE POLICY ws_isolation ON workstream
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

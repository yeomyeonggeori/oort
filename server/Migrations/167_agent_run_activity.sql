-- =============================================================================
-- 167_agent_run_activity.sql — #4656 / ADR-0200 증보 7 (7-S1)
--
-- What an agent says it is doing, kept in the run event ledger: two new closed ledger
-- kinds, `activity` and `plan`, and a per-run total table.
--
--   activity  one row = one activity id in one state. An agent reports a CHANGE (the id's
--             whole state); the ledger is append-only, so a state change is a new row and
--             the read folds to the newest row per id. Columns (this kind only):
--               activity_id          a meaningless number-name (`a1`), [A-Za-z0-9_-]{1,32}
--               activity_kind        run | edit | read | search | web | other | delegate
--               label                optional, 1..40 characters, the shared character rule
--               activity_status      in_progress | completed | failed
--               activity_n           how many things the item bundles, 1..100000
--               activity_started_at  the id's FIRST report time, copied onto every later row
--   plan      one row = the whole plan at that moment (jsonb array <= 12 of
--             {text 1..60 chars, status pending|in_progress|completed}); `[]` clears it.
--
-- Nothing is invented by the server: the agent's words are stored as the agent reported
-- them, in columns that exist only on these two kinds. `stage`, `code`, `approval_id`,
-- `tool`, `duration_ms` are NULL on both. The agent's thinking has no column at all (7-4).
--
-- WHO WRITES: `agent_run_activity_record` is the only writer of both kinds and of the
-- total table. The Agent Port tool path (`oort_run_event`) and any in-server recorder call
-- it, so they cannot tighten or fold differently. The Rust side judges the text first
-- (`momo_agent::ActivityReport::validate`, one function over `momo_wire::report_text`, the rule a
-- stage marker passes through too); the
-- CHECKs below are the SQL backstop and a SUBSET of that rule, so they never fire first.
--
-- FOUR WRITE-AMPLIFICATION GUARDS (7-6):
--   1. fold    — a report whose (kind, label, status, n) equals the id's newest row writes
--                nothing and moves no total. A repeated plan folds the same way.
--   2. append  — rows are never updated (the immutability trigger of 128 stays).
--   3. roll    — past 100 `activity` rows (10 `plan` rows) `agent_run_activity_trim` deletes,
--                in this order: (a) superseded rows, oldest first; (b) the newest row of ENDED
--                activities, oldest first; (c) in-progress activities, oldest first. (a) runs
--                first, so (b)/(c) always remove an id whole and an old row of the same id can
--                never come back to life under the newest-per-id read. Server-measured facts
--                (`tool_call`) are never deleted (T3); the agent's own report is the window
--                that rolls.
--   4. total   — `agent_run_activity_tally` holds, per (run, kind), the units of ENDED
--                activities: for each id, its LAST report if it ended (`completed`/`failed`) is
--                `n` units. Re-ending an id takes the old value off before the new one goes on
--                (so a resend or a correction is not counted twice), and returning to
--                `in_progress` takes it off. The total is the agent's own report, not a count
--                oort made, and it survives the row roll. Limit: an id whose rows were all
--                rolled away and that the agent ends again counts as a new activity.
--
-- The 200-row stage cap (`agent_run_event_trim`) and the stage fold
-- (`agent_run_event_append`) now both look past `activity`/`plan` rows, exactly as 133 made
-- them look past `tool_call`: reports must neither push `stage` rows out of the window nor
-- turn a repeated stage into a new row each time.
--
-- REALTIME: `stage`, `activity` and `plan` share ONE 2-second frame window
-- (`agent_run_event_set_framed`). A call that sends stage + activities + plan is one frame;
-- the frame carries the kind only, never the text or the id (the reader re-reads through the
-- membership-checked REST route).
--
-- LOCKS (the question 7-6 left to this migration). The function does NOT enforce the lock order
-- itself, so read the precondition:
--   * PRECONDITION FOR EVERY CALLER: hold the run row (`FOR UPDATE`, or `FOR NO KEY UPDATE`)
--     BEFORE calling. The Agent Port path does: it reaches this function inside
--     `record_gateway_event_in_tx`, which already holds the run row `FOR UPDATE`
--     (`lock_gateway_run_in_tx`), so same-run tool-path writers are serialized there and the
--     per-run advisory lock taken below is uncontended. The order is run row -> advisory lock ->
--     (the total table's FK check).
--   * A caller that does NOT hold the run row first can deadlock with a concurrent tool-path call
--     on the same run: it takes the advisory lock, its first INSERT into the total table for a
--     (run, kind) then needs KEY SHARE on the run row through the FK (which conflicts with the
--     tool path's FOR UPDATE), while the tool path waits for the advisory lock. No such caller
--     exists today: the in-server helper of ADR-0201 B5-7 is not wired yet, and a managed run
--     has no hosted lease, so the Agent Port path cannot reach it. #4968 must lock the run row
--     first. The function could enforce the order by replacing its run-existence check with
--     `SELECT 1 FROM agent_run ... FOR NO KEY UPDATE`; that is offered to the security review and
--     not done here, because it changes the lock footprint of every caller.
--   * The total table has a foreign key to `agent_run` with ON DELETE CASCADE, like 133's
--     `agent_run_tool_tally`. Its KEY SHARE on the run row is compatible with the tool path's own
--     FOR UPDATE inside one transaction (the precondition above). The 128 reason for NOT putting
--     an FK on the ledger (the claim path holds the outbox row and waits on the run row) does not
--     apply to a writer that locks the run row first. The ledger itself stays FK-free.
--
-- ROLES: SECURITY INVOKER throughout, no SECURITY DEFINER, no BYPASSRLS. The Agent Port
-- writes as `momo_app`, which holds SELECT/INSERT/UPDATE/DELETE on `agent_run_event` (128)
-- and the `agent_run_event_seq` USAGE; the total table is granted to it here. The retention
-- sweep's cross-tenant read runs as `momo_notifier` and gets SELECT on the total table
-- (like 133); its DELETE runs as `momo_app` under RLS. A recorder that is not `momo_app`
-- needs its own GRANT (the in-server helper of ADR-0201 B5-7 must confirm its pool's role).
--
-- LOCK NOTE (operations): ALTER TABLE takes ACCESS EXCLUSIVE until commit. Adding nullable
-- columns without a default is metadata-only. Every CHECK is added `NOT VALID` so no existing
-- row is scanned: the columns are brand new (NULL on every old row) and the widened kind list
-- is a superset of what the old rows hold. New rows are checked either way. No
-- `VALIDATE CONSTRAINT` (there are no old rows to validate), the same reasoning as 162/163.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- The shared text backstop. The Rust rule is a superset of this one (it also refuses
-- the rest of the invisible/direction classes), so a row never reaches this CHECK with text
-- the Rust side would have refused first. Same character class as
-- `work_session_share_stage_markers_ok` (114), which keeps its signature: two tables'
-- CHECKs depend on it.
-- -----------------------------------------------------------------------------
CREATE FUNCTION agent_report_text_ok(t text, max_chars integer) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog AS $$
  SELECT t IS NOT NULL
     AND char_length(t) BETWEEN 1 AND max_chars
     AND t !~ '[[:cntrl:]­؜ -‮⁠-⁯/\\]'
$$;

COMMENT ON FUNCTION agent_report_text_ok(text, integer) IS
  'ADR-0200 증보 7 7-3: the SQL backstop of the agent-report text rule (label 40, plan step 60). A subset of momo_wire::report_text::checked_report_text.';

-- A plan is a jsonb array of at most 12 `{text, status}` objects: exactly those two keys.
-- CASE keeps the guard order (a non-array never reaches jsonb_array_length).
CREATE FUNCTION agent_run_plan_ok(p jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog, public AS $$
  SELECT CASE WHEN jsonb_typeof(p) = 'array' THEN
           jsonb_array_length(p) <= 12
           AND NOT EXISTS (
             SELECT 1 FROM jsonb_array_elements(p) AS e(v)
              WHERE CASE
                      WHEN jsonb_typeof(e.v) <> 'object' THEN true
                      WHEN jsonb_typeof(e.v -> 'text') IS DISTINCT FROM 'string' THEN true
                      WHEN jsonb_typeof(e.v -> 'status') IS DISTINCT FROM 'string' THEN true
                      WHEN (SELECT count(*) FROM jsonb_object_keys(e.v)) <> 2 THEN true
                      WHEN NOT public.agent_report_text_ok(e.v ->> 'text', 60) THEN true
                      WHEN (e.v ->> 'status') NOT IN ('pending', 'in_progress', 'completed') THEN true
                      ELSE false
                    END
           )
         ELSE false END
$$;

COMMENT ON FUNCTION agent_run_plan_ok(jsonb) IS
  'ADR-0200 증보 7 7-2: a plan is an array of <= 12 {text, status} objects, text under agent_report_text_ok(…, 60), status pending|in_progress|completed.';

-- -----------------------------------------------------------------------------
-- Ledger columns and the two new kinds (14 -> 16)
-- -----------------------------------------------------------------------------
ALTER TABLE agent_run_event
  ADD COLUMN activity_id         text,
  ADD COLUMN activity_kind       text,
  ADD COLUMN label               text,
  ADD COLUMN activity_status     text,
  ADD COLUMN activity_n          integer,
  ADD COLUMN activity_started_at timestamptz,
  ADD COLUMN plan                jsonb;

ALTER TABLE agent_run_event DROP CONSTRAINT agent_run_event_kind_ck;
ALTER TABLE agent_run_event ADD CONSTRAINT agent_run_event_kind_ck CHECK (kind IN (
  'queued', 'claimed', 'started', 'stage', 'paused', 'resumed',
  'approval_requested', 'approval_decided',
  'succeeded', 'failed', 'timed_out', 'cancelled',
  'doorbell_rung',
  'tool_call',
  'activity', 'plan'
)) NOT VALID;

-- "That kind exactly when its columns are there", then each column's own rule, then the
-- columns the two kinds never carry. The CASE arms keep the evaluation order.
ALTER TABLE agent_run_event ADD CONSTRAINT agent_run_event_activity_ck CHECK (
  (kind = 'activity') = (activity_id IS NOT NULL)
  AND (kind = 'activity') = (activity_kind IS NOT NULL)
  AND (kind = 'activity') = (activity_status IS NOT NULL)
  AND (kind = 'activity') = (activity_n IS NOT NULL)
  AND (kind = 'activity') = (activity_started_at IS NOT NULL)
  AND (kind = 'activity' OR label IS NULL)
  AND (kind = 'plan') = (plan IS NOT NULL)
  AND CASE WHEN kind = 'activity' THEN
        activity_id ~ '^[A-Za-z0-9_-]{1,32}$'
        AND activity_kind IN ('run', 'edit', 'read', 'search', 'web', 'other', 'delegate')
        AND activity_status IN ('in_progress', 'completed', 'failed')
        AND activity_n BETWEEN 1 AND 100000
        AND (label IS NULL OR agent_report_text_ok(label, 40))
      ELSE true END
  AND CASE WHEN kind = 'plan' THEN agent_run_plan_ok(plan) ELSE true END
  AND (kind NOT IN ('activity', 'plan') OR (
        stage IS NULL AND code IS NULL AND approval_id IS NULL
        AND tool IS NULL AND duration_ms IS NULL))
) NOT VALID;

COMMENT ON COLUMN agent_run_event.activity_id IS
  'ADR-0200 증보 7: `activity` rows only — the agent''s own meaningless number-name for one activity ([A-Za-z0-9_-]{1,32}); shown to channel members as agent-reported text.';
COMMENT ON COLUMN agent_run_event.label IS
  'ADR-0200 증보 7: `activity` rows only — optional agent-reported name of the work (1..40 characters, shared text rule). Untrusted plain text.';
COMMENT ON COLUMN agent_run_event.plan IS
  'ADR-0200 증보 7: `plan` rows only — the whole plan at that moment (<= 12 {text, status}). Untrusted plain text; `[]` clears it.';

-- -----------------------------------------------------------------------------
-- The total table: ended units per (run, activity kind)
-- -----------------------------------------------------------------------------
CREATE TABLE agent_run_activity_tally (
  workspace_id    uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  run_id          uuid NOT NULL,
  kind            text NOT NULL
                  CHECK (kind IN ('run', 'edit', 'read', 'search', 'web', 'other', 'delegate')),
  completed_units bigint NOT NULL DEFAULT 0 CHECK (completed_units >= 0),
  failed_units    bigint NOT NULL DEFAULT 0 CHECK (failed_units >= 0),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, run_id, kind),
  FOREIGN KEY (workspace_id, run_id) REFERENCES agent_run (workspace_id, id) ON DELETE CASCADE
);

COMMENT ON TABLE agent_run_activity_tally IS
  'ADR-0200 증보 7 7-6: per-run, per-kind units of ENDED activities (each id''s last report, if completed/failed). The agent''s own report, not a count oort made; survives the 100-row roll.';

ALTER TABLE agent_run_activity_tally ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_run_activity_tally FORCE ROW LEVEL SECURITY;
CREATE POLICY ws_isolation ON agent_run_activity_tally
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE agent_run_activity_tally TO momo_app;
  END IF;
  -- The retention sweep's cross-tenant READ (`workspaces_with_expired_run_events`) runs as
  -- the BYPASSRLS notifier and also looks at this table. SELECT only; its DELETE runs as
  -- momo_app under RLS. Granted here so an install that does not re-run
  -- bootstrap_runtime_roles.sql after this migration keeps its ledger sweep working.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_notifier') THEN
    GRANT SELECT ON TABLE agent_run_activity_tally TO momo_notifier;
  END IF;
END $$;

-- Move one id's contribution on or off the total: `p_delta` is +n when an id ends (or ends
-- differently) and -n when its previous ended value is taken off. Never goes below zero: a
-- drift would otherwise turn an agent's progress report into a hard error.
CREATE FUNCTION agent_run_activity_tally_add(
  p_workspace_id uuid,
  p_run_id       uuid,
  p_kind         text,
  p_status       text,
  p_delta        bigint
) RETURNS void
LANGUAGE sql
SET search_path = public, pg_temp
AS $$
  INSERT INTO agent_run_activity_tally AS t (workspace_id, run_id, kind, completed_units, failed_units)
  VALUES (p_workspace_id, p_run_id, p_kind,
          CASE WHEN p_status = 'completed' THEN GREATEST(p_delta, 0) ELSE 0 END,
          CASE WHEN p_status = 'failed' THEN GREATEST(p_delta, 0) ELSE 0 END)
  ON CONFLICT (workspace_id, run_id, kind) DO UPDATE
     SET completed_units = GREATEST(t.completed_units
                                    + CASE WHEN p_status = 'completed' THEN p_delta ELSE 0 END, 0),
         failed_units    = GREATEST(t.failed_units
                                    + CASE WHEN p_status = 'failed' THEN p_delta ELSE 0 END, 0),
         updated_at      = now()
$$;

COMMENT ON FUNCTION agent_run_activity_tally_add(uuid, uuid, text, text, bigint) IS
  'ADR-0200 증보 7 7-6: add (or take off, with a negative delta) one activity''s ended units; floors at zero. Internal to agent_run_activity_record.';

-- -----------------------------------------------------------------------------
-- The roll: the only DELETE of `activity` / `plan` rows
-- -----------------------------------------------------------------------------
CREATE FUNCTION agent_run_activity_trim(p_workspace_id uuid, p_run_id uuid) RETURNS integer
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_extra   bigint;
  v_deleted integer := 0;
  v_step    integer;
BEGIN
  -- plans: every plan row but the newest is superseded; keep the newest 10 (the read shows 1)
  DELETE FROM agent_run_event e
   WHERE e.workspace_id = p_workspace_id AND e.run_id = p_run_id AND e.kind = 'plan'
     AND e.seq IN (
       SELECT s.seq FROM agent_run_event s
        WHERE s.workspace_id = p_workspace_id AND s.run_id = p_run_id AND s.kind = 'plan'
        ORDER BY s.seq DESC OFFSET 10
     );
  GET DIAGNOSTICS v_step = ROW_COUNT;
  v_deleted := v_step;

  SELECT count(*) - 100 INTO v_extra
    FROM agent_run_event
   WHERE workspace_id = p_workspace_id AND run_id = p_run_id AND kind = 'activity';
  IF v_extra <= 0 THEN
    RETURN v_deleted;
  END IF;

  -- (a) superseded rows (a newer row of the same id exists), oldest first. Removing them
  --     changes nothing a reader sees.
  DELETE FROM agent_run_event e
   WHERE e.workspace_id = p_workspace_id AND e.run_id = p_run_id AND e.kind = 'activity'
     AND e.seq IN (
       SELECT s.seq FROM agent_run_event s
        WHERE s.workspace_id = p_workspace_id AND s.run_id = p_run_id AND s.kind = 'activity'
          AND EXISTS (
            SELECT 1 FROM agent_run_event n
             WHERE n.workspace_id = s.workspace_id AND n.run_id = s.run_id
               AND n.kind = 'activity' AND n.activity_id = s.activity_id AND n.seq > s.seq)
        ORDER BY s.seq ASC LIMIT v_extra
     );
  GET DIAGNOSTICS v_step = ROW_COUNT;
  v_deleted := v_deleted + v_step;
  v_extra := v_extra - v_step;

  -- (b) only when no superseded row is left (so every id has exactly one row): the newest
  --     row of ENDED activities, oldest first. The id leaves the list whole.
  IF v_extra > 0 THEN
    DELETE FROM agent_run_event e
     WHERE e.workspace_id = p_workspace_id AND e.run_id = p_run_id AND e.kind = 'activity'
       AND e.seq IN (
         SELECT s.seq FROM agent_run_event s
          WHERE s.workspace_id = p_workspace_id AND s.run_id = p_run_id AND s.kind = 'activity'
            AND s.activity_status IN ('completed', 'failed')
          ORDER BY s.seq ASC LIMIT v_extra
       );
    GET DIAGNOSTICS v_step = ROW_COUNT;
    v_deleted := v_deleted + v_step;
    v_extra := v_extra - v_step;
  END IF;

  -- (c) the fallback: in-progress activities, oldest first (a run with 100+ activities all
  --     still open).
  IF v_extra > 0 THEN
    DELETE FROM agent_run_event e
     WHERE e.workspace_id = p_workspace_id AND e.run_id = p_run_id AND e.kind = 'activity'
       AND e.seq IN (
         SELECT s.seq FROM agent_run_event s
          WHERE s.workspace_id = p_workspace_id AND s.run_id = p_run_id AND s.kind = 'activity'
          ORDER BY s.seq ASC LIMIT v_extra
       );
    GET DIAGNOSTICS v_step = ROW_COUNT;
    v_deleted := v_deleted + v_step;
  END IF;
  RETURN v_deleted;
END;
$$;

COMMENT ON FUNCTION agent_run_activity_trim(uuid, uuid) IS
  'ADR-0200 증보 7 7-6: the roll of agent-reported rows — 100 activity rows (superseded, then ended, then in-progress, oldest first) and 10 plan rows per run. The only DELETE of those kinds; never counts or deletes stage/lifecycle/tool_call rows.';

-- -----------------------------------------------------------------------------
-- The one writer of `activity` / `plan` rows and the total.
--
-- `p_activities` is a jsonb array of {id, kind, label?, status, n?} (already judged by the
-- caller; the CHECKs are the backstop), one entry per id with the later entry winning
-- (the caller dedupes); `p_plan` is NULL (leave the plan) or the whole new plan (`[]`
-- clears). Returns how many ledger rows it wrote. 0 when the run is not this agent's run in
-- this tenant (the same refusal 133's recorder gives) — it neither writes nor says why.
-- -----------------------------------------------------------------------------
CREATE FUNCTION agent_run_activity_record(
  p_workspace_id uuid,
  p_run_id       uuid,
  p_actor        uuid,
  p_activities   jsonb,
  p_plan         jsonb
) RETURNS integer
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_item       jsonb;
  v_id         text;
  v_kind       text;
  v_label      text;
  v_status     text;
  v_n          integer;
  v_last       record;
  v_found      boolean;
  v_plan_last  jsonb;
  v_written    integer := 0;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM agent_run
     WHERE workspace_id = p_workspace_id AND id = p_run_id AND agent_member_id = p_actor
  ) THEN
    RETURN 0;
  END IF;

  -- Serialises same-run recorders so the fold, the total and the roll read and write a
  -- stable state. PRECONDITION (header, "LOCKS"): the caller already holds the run row. A
  -- caller that does not can deadlock with the tool path through the total table's FK.
  PERFORM pg_advisory_xact_lock(hashtextextended('agent_run_activity:' || p_run_id::text, 0));

  IF p_activities IS NOT NULL THEN
    FOR v_item IN SELECT value FROM jsonb_array_elements(p_activities) LOOP
      v_id     := v_item ->> 'id';
      v_kind   := v_item ->> 'kind';
      v_label  := v_item ->> 'label';
      v_status := v_item ->> 'status';
      v_n      := COALESCE((v_item ->> 'n')::integer, 1);

      SELECT e.activity_kind, e.label, e.activity_status, e.activity_n, e.activity_started_at
        INTO v_last
        FROM agent_run_event e
       WHERE e.workspace_id = p_workspace_id AND e.run_id = p_run_id
         AND e.kind = 'activity' AND e.activity_id = v_id
       ORDER BY e.seq DESC LIMIT 1;
      v_found := FOUND;

      -- fold: same content as the id's newest row writes nothing and moves no total
      IF v_found
         AND v_last.activity_kind = v_kind
         AND v_last.label IS NOT DISTINCT FROM v_label
         AND v_last.activity_status = v_status
         AND v_last.activity_n = v_n THEN
        CONTINUE;
      END IF;

      -- total: take the previous ended value off, put the new one on
      IF v_found AND v_last.activity_status IN ('completed', 'failed') THEN
        PERFORM agent_run_activity_tally_add(
          p_workspace_id, p_run_id, v_last.activity_kind, v_last.activity_status,
          -v_last.activity_n::bigint);
      END IF;
      IF v_status IN ('completed', 'failed') THEN
        PERFORM agent_run_activity_tally_add(
          p_workspace_id, p_run_id, v_kind, v_status, v_n::bigint);
      END IF;

      INSERT INTO agent_run_event
        (workspace_id, run_id, kind, actor_member_id,
         activity_id, activity_kind, label, activity_status, activity_n, activity_started_at)
      VALUES
        (p_workspace_id, p_run_id, 'activity', p_actor,
         v_id, v_kind, v_label, v_status, v_n,
         CASE WHEN v_found THEN v_last.activity_started_at ELSE now() END);
      v_written := v_written + 1;
    END LOOP;
  END IF;

  IF p_plan IS NOT NULL THEN
    SELECT e.plan INTO v_plan_last
      FROM agent_run_event e
     WHERE e.workspace_id = p_workspace_id AND e.run_id = p_run_id AND e.kind = 'plan'
     ORDER BY e.seq DESC LIMIT 1;
    -- no plan yet reads as the empty plan, so `[]` on a run with no plan folds away
    IF COALESCE(v_plan_last, '[]'::jsonb) IS DISTINCT FROM p_plan THEN
      INSERT INTO agent_run_event (workspace_id, run_id, kind, actor_member_id, plan)
      VALUES (p_workspace_id, p_run_id, 'plan', p_actor, p_plan);
      v_written := v_written + 1;
    END IF;
  END IF;

  IF v_written > 0 THEN
    PERFORM agent_run_activity_trim(p_workspace_id, p_run_id);
  END IF;
  RETURN v_written;
END;
$$;

COMMENT ON FUNCTION agent_run_activity_record(uuid, uuid, uuid, jsonb, jsonb) IS
  'ADR-0200 증보 7 7-6: record one agent report (activities as changes, plan as a whole replacement) on the caller agent''s own run — fold repeats, move the ended-unit total, roll past 100/10 rows. SECURITY INVOKER; the only writer of activity/plan rows.';

-- -----------------------------------------------------------------------------
-- The 200-row stage cap no longer counts `activity` / `plan` rows (they have their own
-- roll above and must not push `stage` rows out). Deletion predicates are unchanged.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION agent_run_event_trim(p_workspace_id uuid, p_run_id uuid) RETURNS integer
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_extra   bigint;
  v_deleted integer := 0;
  v_step    integer;
BEGIN
  SELECT count(*) - 200 INTO v_extra
    FROM agent_run_event
   WHERE workspace_id = p_workspace_id AND run_id = p_run_id
     AND kind NOT IN ('tool_call', 'activity', 'plan');
  IF v_extra <= 0 THEN
    RETURN 0;
  END IF;
  -- 1) oldest stage rows first
  DELETE FROM agent_run_event e
   WHERE e.workspace_id = p_workspace_id AND e.run_id = p_run_id
     AND e.kind = 'stage'
     AND e.seq IN (
       SELECT s.seq FROM agent_run_event s
        WHERE s.workspace_id = p_workspace_id AND s.run_id = p_run_id AND s.kind = 'stage'
        ORDER BY s.seq ASC LIMIT v_extra
     );
  GET DIAGNOSTICS v_step = ROW_COUNT;
  v_deleted := v_step;
  v_extra := v_extra - v_step;
  -- 2) a run re-claimed after endless lease expiries: oldest `claimed` rows, never the newest
  IF v_extra > 0 THEN
    DELETE FROM agent_run_event e
     WHERE e.workspace_id = p_workspace_id AND e.run_id = p_run_id
       AND e.kind = 'claimed'
       AND e.seq IN (
         SELECT s.seq FROM agent_run_event s
          WHERE s.workspace_id = p_workspace_id AND s.run_id = p_run_id AND s.kind = 'claimed'
          ORDER BY s.seq ASC LIMIT v_extra
       )
       AND e.seq <> (
         SELECT max(s.seq) FROM agent_run_event s
          WHERE s.workspace_id = p_workspace_id AND s.run_id = p_run_id AND s.kind = 'claimed'
       );
    GET DIAGNOSTICS v_step = ROW_COUNT;
    v_deleted := v_deleted + v_step;
  END IF;
  RETURN v_deleted;
END;
$$;

COMMENT ON FUNCTION agent_run_event_trim(uuid, uuid) IS
  'ADR-0200 D2: 200-row cap over rows other than tool_call/activity/plan — deletes the oldest stage rows (then oldest claimed rows). tool_call rows are neither counted nor deleted (증보 2026-10-15 T3); activity/plan rows have their own roll (agent_run_activity_trim, 증보 7). Called by the stage writer, never by a trigger.';

-- -----------------------------------------------------------------------------
-- The stage fold looks past `activity` / `plan` rows as it looks past `tool_call` rows:
-- every report that carries activities leaves rows between two identical stages, and
-- without this a repeated stage would stop being "immediate" and add a row per report.
-- Same function, same signature, still no lock (128).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION agent_run_event_append(
  p_workspace_id uuid,
  p_run_id       uuid,
  p_kind         text,
  p_stage        text DEFAULT NULL,
  p_code         text DEFAULT NULL,
  p_approval_id  uuid DEFAULT NULL,
  p_actor        uuid DEFAULT NULL
) RETURNS bigint
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_seq  bigint;
  v_last record;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM agent_run WHERE workspace_id = p_workspace_id AND id = p_run_id
  ) THEN
    RETURN NULL;
  END IF;

  IF p_kind = 'stage' THEN
    SELECT seq, kind, stage INTO v_last
      FROM agent_run_event
     WHERE workspace_id = p_workspace_id AND run_id = p_run_id
       AND kind NOT IN ('tool_call', 'activity', 'plan')
     ORDER BY seq DESC LIMIT 1;
    IF v_last.kind = 'stage' AND v_last.stage IS NOT DISTINCT FROM p_stage THEN
      RETURN v_last.seq;
    END IF;
  END IF;

  INSERT INTO agent_run_event
    (workspace_id, run_id, kind, stage, code, approval_id, actor_member_id)
  VALUES
    (p_workspace_id, p_run_id, p_kind, p_stage, p_code, p_approval_id, p_actor)
  RETURNING seq INTO v_seq;
  RETURN v_seq;
END;
$$;

COMMENT ON FUNCTION agent_run_event_append(uuid, uuid, text, text, text, uuid, uuid) IS
  'ADR-0200 D2: the INSERT into agent_run_event for every kind but tool_call/activity/plan. SECURITY INVOKER; takes no lock; folds an immediate stage repeat (tool_call/activity/plan rows in between do not count); NULL for a missing run.';

-- -----------------------------------------------------------------------------
-- One frame window for `stage`, `activity` and `plan` (7-6 "실시간"): a row of those three
-- kinds is unframed when a framed row of those three kinds is within 2 seconds. Rows of one
-- call share `created_at` (now() is the transaction start), so a call is one frame.
-- `tool_call` still never frames (133); lifecycle kinds always frame (130).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION agent_run_event_set_framed() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.kind = 'tool_call' THEN
    NEW.framed := false;
    RETURN NEW;
  END IF;
  NEW.framed := NOT (
    NEW.kind IN ('stage', 'activity', 'plan') AND EXISTS (
      SELECT 1 FROM agent_run_event p
       WHERE p.workspace_id = NEW.workspace_id AND p.run_id = NEW.run_id
         AND p.kind IN ('stage', 'activity', 'plan') AND p.framed
         AND p.created_at > NEW.created_at - interval '2 seconds')
  );
  RETURN NEW;
END;
$$;

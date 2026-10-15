-- =============================================================================
-- 133_agent_run_event_tool_call.sql — #3840 / ADR-0200 증보 2026-10-15 (#3838) T1~T5
--
-- One new closed ledger kind, `tool_call`: the Agent Port dispatcher records, on the ONE
-- run a call points at (a sealed lease handle it opened, or the job it handed out), that
-- the agent called an oort tool, how long the server took, and how it ended. Nothing else:
--   tool        = the catalog name (`oort_*`), never arguments
--   duration_ms = the server's own monotonic measure, 0..600000
--   code        = `ok` or one of the seven closed ToolFailure codes
-- No arguments, no result body, no lease handle, no channel/message id, no error text.
--
-- Bounds without deletion (성재 결재 「행을 지우지 않는다」):
--   * at most 100 `tool_call` rows per run; past that the row is not written and only the
--     tally moves (`agent_run_tool_call_record`).
--   * `agent_run_event_trim` neither counts nor deletes `tool_call` rows.
--   * `agent_run_tool_tally` keeps per (run, tool) ok/error counts and the duration sum for
--     EVERY recorded call, so totals stay exact after the row cap.
--   * lifetime: rows and tally go with the run (delete trigger / FK CASCADE) and with the
--     existing retention sweep — no cap deletion anywhere.
--
-- The stage fold in `agent_run_event_append` compares with the last NON-tool_call row, so
-- a repeated stage still folds when tool calls sit in between.
--
-- Realtime: a `tool_call` row is written `framed = false`, so it puts no `agent.run.event`
-- frame on the channel (a frame per tool call would flood the topic).
--
-- Security: SECURITY INVOKER throughout; the writer is `momo_app` in a tenant transaction
-- (RLS FORCE applies). No SECURITY DEFINER, no BYPASSRLS.
-- =============================================================================

ALTER TABLE agent_run_event
  ADD COLUMN tool text,
  ADD COLUMN duration_ms integer;

ALTER TABLE agent_run_event DROP CONSTRAINT agent_run_event_kind_ck;
ALTER TABLE agent_run_event ADD CONSTRAINT agent_run_event_kind_ck CHECK (kind IN (
  'queued', 'claimed', 'started', 'stage', 'paused', 'resumed',
  'approval_requested', 'approval_decided',
  'succeeded', 'failed', 'timed_out', 'cancelled',
  'doorbell_rung',
  'tool_call'
));

-- `tool` and `duration_ms` exist exactly on `tool_call` rows, and a `tool_call` row carries
-- nothing but them, the closed code and the acting agent.
ALTER TABLE agent_run_event ADD CONSTRAINT agent_run_event_tool_call_ck CHECK (
  (kind = 'tool_call') = (tool IS NOT NULL)
  AND (kind = 'tool_call') = (duration_ms IS NOT NULL)
  AND (tool IS NULL OR tool ~ '^oort_[a-z_]{1,40}$')
  AND (duration_ms IS NULL OR duration_ms BETWEEN 0 AND 600000)
  AND (kind <> 'tool_call' OR (
        stage IS NULL AND approval_id IS NULL
        AND code IS NOT NULL
        AND code IN ('ok', 'invalid_arguments', 'not_authorized', 'unavailable',
                     'conflict', 'already_claimed', 'claim_expired', 'internal')))
);

COMMENT ON COLUMN agent_run_event.tool IS
  'ADR-0200 증보 T1: oort tool name on `tool_call` rows only (catalog name, no arguments).';
COMMENT ON COLUMN agent_run_event.duration_ms IS
  'ADR-0200 증보 T1: server-measured tool duration on `tool_call` rows only (0..600000).';

-- -----------------------------------------------------------------------------
-- The tally: exact totals per (run, tool), past the row cap too.
-- -----------------------------------------------------------------------------
CREATE TABLE agent_run_tool_tally (
  workspace_id    uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  run_id          uuid NOT NULL,
  tool            text NOT NULL CHECK (tool ~ '^oort_[a-z_]{1,40}$'),
  ok_count        bigint NOT NULL DEFAULT 0 CHECK (ok_count >= 0),
  error_count     bigint NOT NULL DEFAULT 0 CHECK (error_count >= 0),
  duration_ms_sum bigint NOT NULL DEFAULT 0 CHECK (duration_ms_sum >= 0),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, run_id, tool),
  FOREIGN KEY (workspace_id, run_id) REFERENCES agent_run (workspace_id, id) ON DELETE CASCADE
);

COMMENT ON TABLE agent_run_tool_tally IS
  'ADR-0200 증보 T3: per-run, per-tool oort call totals (ok/error counts, duration sum). Every attributed call moves it; the 100-row ledger cap does not.';

ALTER TABLE agent_run_tool_tally ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_run_tool_tally FORCE ROW LEVEL SECURITY;
CREATE POLICY ws_isolation ON agent_run_tool_tally
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE agent_run_tool_tally TO momo_app;
  END IF;
  -- The retention sweep's cross-tenant READ (`workspaces_with_expired_run_events`) runs as
  -- the BYPASSRLS notifier and now looks at the tally too. SELECT only — its DELETE runs
  -- as momo_app under RLS. Granted here so an install that does not re-run
  -- bootstrap_roles.sql after this migration keeps its existing ledger sweep working.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_notifier') THEN
    GRANT SELECT ON TABLE agent_run_tool_tally TO momo_notifier;
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- The one writer of `tool_call` rows and the tally.
--
-- Returns 'row' (ledger row + tally), 'tally' (row cap reached: tally only) or 'skipped'
-- (the run is not in this workspace, or is not this agent's run — nothing written).
--
-- The advisory lock serialises only concurrent recorders of the SAME run so the 100-row
-- cap is exact. It cannot close a cycle with the claim/approve/cancel paths (the reason
-- agent_run_event_append takes no lock, migration 128): this function runs in its own
-- short transaction that holds nothing else, and no other path waits on this lock or on
-- the tally rows.
-- -----------------------------------------------------------------------------
CREATE FUNCTION agent_run_tool_call_record(
  p_workspace_id uuid,
  p_run_id       uuid,
  p_actor        uuid,
  p_tool         text,
  p_duration_ms  integer,
  p_code         text
) RETURNS text
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_rows bigint;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM agent_run
     WHERE workspace_id = p_workspace_id AND id = p_run_id AND agent_member_id = p_actor
  ) THEN
    RETURN 'skipped';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('agent_run_tool_call:' || p_run_id::text, 0));

  INSERT INTO agent_run_tool_tally AS t
    (workspace_id, run_id, tool, ok_count, error_count, duration_ms_sum)
  VALUES
    (p_workspace_id, p_run_id, p_tool,
     CASE WHEN p_code = 'ok' THEN 1 ELSE 0 END,
     CASE WHEN p_code = 'ok' THEN 0 ELSE 1 END,
     p_duration_ms)
  ON CONFLICT (workspace_id, run_id, tool) DO UPDATE
     SET ok_count        = t.ok_count + EXCLUDED.ok_count,
         error_count     = t.error_count + EXCLUDED.error_count,
         duration_ms_sum = t.duration_ms_sum + EXCLUDED.duration_ms_sum,
         updated_at      = now();

  SELECT count(*) INTO v_rows
    FROM agent_run_event
   WHERE workspace_id = p_workspace_id AND run_id = p_run_id AND kind = 'tool_call';
  IF v_rows >= 100 THEN
    RETURN 'tally';
  END IF;

  INSERT INTO agent_run_event
    (workspace_id, run_id, kind, code, actor_member_id, tool, duration_ms)
  VALUES
    (p_workspace_id, p_run_id, 'tool_call', p_code, p_actor, p_tool, p_duration_ms);
  RETURN 'row';
END;
$$;

COMMENT ON FUNCTION agent_run_tool_call_record(uuid, uuid, uuid, text, integer, text) IS
  'ADR-0200 증보 T1~T3: record one oort tool call on the caller agent''s own run — tally always, ledger row while the run has < 100 tool_call rows. SECURITY INVOKER.';

-- -----------------------------------------------------------------------------
-- The 200-row cap no longer sees `tool_call` rows (T3): they are bounded by their own
-- 100-row cap and are never deleted by it. Deletion predicates are unchanged
-- (stage first, then claimed).
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
     AND kind <> 'tool_call';
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
  'ADR-0200 D2: 200-row cap over non-tool_call rows — deletes the oldest stage rows (then oldest claimed rows). tool_call rows are neither counted nor deleted (증보 2026-10-15 T3). Called by the stage writer, never by a trigger.';

-- -----------------------------------------------------------------------------
-- The stage fold looks past `tool_call` rows. `agent_run_event_append` folds an immediate
-- repeat of the same stage into the existing row by comparing with the run's LAST row;
-- every `oort_run_event` now also leaves a `tool_call` row, so without this a repeated
-- stage would never be "immediate" again and would add a row per report. Same function,
-- same signature, still no lock (migration 128) — only the last-row lookup skips
-- `tool_call`.
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
       AND kind <> 'tool_call'
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
  'ADR-0200 D2: the INSERT into agent_run_event for every kind but tool_call. SECURITY INVOKER; takes no lock; folds an immediate stage repeat (tool_call rows in between do not count); NULL for a missing run.';

-- -----------------------------------------------------------------------------
-- No realtime frame for `tool_call` (T5). Same rule as migration 130 otherwise.
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
    NEW.kind = 'stage' AND EXISTS (
      SELECT 1 FROM agent_run_event p
       WHERE p.workspace_id = NEW.workspace_id AND p.run_id = NEW.run_id
         AND p.kind = 'stage' AND p.framed
         AND p.created_at > NEW.created_at - interval '2 seconds')
  );
  RETURN NEW;
END;
$$;

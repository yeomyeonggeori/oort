-- =============================================================================
-- 128_agent_run_event.sql — #3740 S1 / ADR-0200 D2, D4
--
-- Two RLS-FORCE tables:
--   * agent_run_event       — the run event ledger: what the panel reads after it
--                             was closed. One row per lifecycle step of a HOSTED
--                             agent's run (queued, claimed, started, stage,
--                             approval requested/decided, terminal ...). Ids,
--                             closed codes and one <=80 char stage marker only:
--                             no `detail`, no `textDelta`, no free text.
--   * hosted_agent_liveness — per-connection "last heard from" facts (written by
--                             S3; the table lands here so the schema is one unit).
--
-- Writers: the SQL function agent_run_event_append(). The lifecycle rows are
-- written by AFTER triggers on agent_run / approval, so every producer (REST
-- create, gateway/hosted tools, approval sweep, worker) is covered by one rule
-- (ADR-0199 D1 precedent); `claimed` and `stage` are written by the server code
-- through the same function.
--
-- Security: every function here is SECURITY INVOKER. They run in the caller's
-- transaction under that caller's role and `app.workspace_id`, so RLS (FORCE)
-- applies to every read and write. No SECURITY DEFINER, no BYPASSRLS.
--
-- Scope: hosted agents only (a hosted_agent_connection row exists for the run's
-- agent), as migration 120 does; managed/BYOA runs write nothing (ADR-0200 D6).
-- =============================================================================

-- seq is an ORDERING key allocated from a sequence, not a per-run counter and never a
-- count: it is unique and increasing in allocation order, with gaps, and across tenants.
-- Why not `max(seq)+1` under a lock: the writers hold different locks in different orders
-- (claim holds the outbox row, approval decide holds the approval row, cancel holds the
-- run row), so any lock the append takes can close a cycle (#3740 security review H1).
-- The append takes NO lock. The trade-off is that two transactions appending to the SAME
-- run concurrently may commit out of seq order; the ledger is at most 200 rows, so readers
-- re-read it whole instead of resuming from a cursor (ADR-0200 D2). The API must never
-- hand the raw seq out as a count (cross-tenant volume side channel).
CREATE SEQUENCE agent_run_event_seq AS bigint;

CREATE TABLE agent_run_event (
  workspace_id    uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  run_id          uuid NOT NULL,
  seq             bigint NOT NULL DEFAULT nextval('agent_run_event_seq') CHECK (seq > 0),
  kind            text NOT NULL,
  -- agent-reported marker. The route's validator (momo-t3 work_share) runs first; this
  -- CHECK reuses work_session_share's SQL marker rule as the backstop (ADR-0162 증보 3
  -- D11). The Rust set is a superset of the SQL set, so the CHECK never fires first.
  stage           text,
  -- closed machine vocabulary (approval_expired, lease_abandoned, approved ...)
  code            text,
  -- soft references (no FK): they only ever travel back to members of the same
  -- workspace through the run's own visibility predicate
  approval_id     uuid,
  actor_member_id uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, run_id, seq),
  -- NO foreign key to agent_run, on purpose (re-review M-A): the FK check takes KEY SHARE
  -- on the run row, which conflicts with the gateway callbacks' `FOR UPDATE` on that row
  -- while the claim path holds the outbox row — the same cycle the advisory lock closed.
  -- Integrity is kept by agent_run_event_append (EXISTS under RLS), the WITH CHECK, and
  -- the AFTER DELETE trigger on agent_run below that replaces ON DELETE CASCADE.
  CONSTRAINT agent_run_event_kind_ck CHECK (kind IN (
    'queued', 'claimed', 'started', 'stage', 'paused', 'resumed',
    'approval_requested', 'approval_decided',
    'succeeded', 'failed', 'timed_out', 'cancelled'
  )),
  CONSTRAINT agent_run_event_stage_ck CHECK (
    (kind = 'stage') = (stage IS NOT NULL)
    AND (stage IS NULL OR work_session_share_stage_markers_ok(jsonb_build_array(stage)))
  ),
  CONSTRAINT agent_run_event_code_ck CHECK (
    code IS NULL OR code ~ '^[a-z0-9_]{1,64}$'
  )
);

ALTER SEQUENCE agent_run_event_seq OWNED BY agent_run_event.seq;

COMMENT ON TABLE agent_run_event IS
  'ADR-0200 D2: hosted-agent run event ledger (ids, closed codes, one stage marker). Append-only (no UPDATE). '
  'Cap 200 rows/run enforced by agent_run_event_trim (oldest stage rows go first; lifecycle rows only as a last resort).';

CREATE TABLE hosted_agent_liveness (
  workspace_id        uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  connection_id       uuid NOT NULL,
  agent_member_id     uuid NOT NULL,
  last_inbox_read_at  timestamptz,
  last_claim_at       timestamptz,
  last_run_event_at   timestamptz,
  last_ping_at        timestamptz,
  last_ping_state     text,
  last_tool_call_at   timestamptz,
  last_tool_error_at  timestamptz,
  last_tool_error_code text,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, connection_id),
  FOREIGN KEY (workspace_id, connection_id, agent_member_id)
    REFERENCES hosted_agent_connection (workspace_id, id, agent_member_id) ON DELETE CASCADE,
  CONSTRAINT hosted_agent_liveness_ping_state_ck
    CHECK (last_ping_state IS NULL OR last_ping_state IN ('idle', 'working')),
  CONSTRAINT hosted_agent_liveness_error_code_ck
    CHECK (last_tool_error_code IS NULL OR last_tool_error_code ~ '^[a-z0-9_]{1,64}$')
);

COMMENT ON TABLE hosted_agent_liveness IS
  'ADR-0200 D4: per-connection last-signal timestamps. Closed codes only; the doorbell result stays on hosted_agent_doorbell.';

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['agent_run_event', 'hosted_agent_liveness'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', t);
    EXECUTE format($f$
      CREATE POLICY ws_isolation ON %I
      USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
      WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);
    $f$, t);
  END LOOP;
END $$;

DO $$
DECLARE r text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE agent_run_event, hosted_agent_liveness TO momo_app;
  END IF;
  -- USAGE for the sequence that allocates `seq`, for every role that updates agent_run (and so
  -- fires the trigger). No UPDATE: nobody needs setval(). Bootstrap re-grants ALL SEQUENCES
  -- on managed installs; this line closes the self-host path that skips that (re-review L-D).
  FOREACH r IN ARRAY ARRAY['momo_app', 'momo_relay', 'momo_worker'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE agent_run_event_seq TO %I', r);
    END IF;
  END LOOP;
END $$;

-- -----------------------------------------------------------------------------
-- The one INSERT. Takes no lock. Returns the new seq, the existing seq when an immediate
-- stage repeat folds (the same fold `output.stages` applies), or NULL when the run does
-- not exist (a job pointing at a missing run must not poison a claim — review M1).
-- -----------------------------------------------------------------------------
CREATE FUNCTION agent_run_event_append(
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
  'ADR-0200 D2: the only INSERT into agent_run_event. SECURITY INVOKER; takes no lock; folds an immediate stage repeat; NULL for a missing run.';

-- -----------------------------------------------------------------------------
-- The 200-row cap, as its own function: the append above runs under roles that
-- hold no DELETE (the notifier's approval-expiry sweep fires it through a
-- trigger), so the only DELETE lives here and is called by the stage writer
-- (momo_app) alone. Oldest `stage` rows go first; only a run with no stage rows left to
-- shed (endless re-claims) loses its oldest `claimed` rows. Other lifecycle rows are
-- bounded by max_steps and the approval caps and are never deleted.
-- -----------------------------------------------------------------------------
CREATE FUNCTION agent_run_event_trim(p_workspace_id uuid, p_run_id uuid) RETURNS integer
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
   WHERE workspace_id = p_workspace_id AND run_id = p_run_id;
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
  'ADR-0200 D2: 200-row cap — deletes the oldest stage rows (then oldest claimed rows). Called by the stage writer, never by a trigger.';

-- hosted agents only (migration 120 predicate)
CREATE FUNCTION agent_run_event_is_hosted(p_workspace_id uuid, p_agent_member_id uuid)
RETURNS boolean
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM hosted_agent_connection hc
     WHERE hc.workspace_id = p_workspace_id AND hc.agent_member_id = p_agent_member_id
  )
$$;

-- -----------------------------------------------------------------------------
-- agent_run lifecycle -> ledger
-- -----------------------------------------------------------------------------
CREATE FUNCTION agent_run_event_on_run() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_kind text;
  v_code text;
BEGIN
  IF NOT agent_run_event_is_hosted(NEW.workspace_id, NEW.agent_member_id) THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    v_kind := CASE NEW.status::text
      WHEN 'queued' THEN 'queued'
      WHEN 'running' THEN 'started'
      WHEN 'paused' THEN 'paused'
      WHEN 'awaiting_approval' THEN NULL
      ELSE NEW.status::text
    END;
  ELSE
    v_kind := CASE NEW.status::text
      WHEN 'queued' THEN 'queued'
      WHEN 'running' THEN CASE OLD.status::text WHEN 'queued' THEN 'started' ELSE 'resumed' END
      WHEN 'paused' THEN 'paused'
      WHEN 'awaiting_approval' THEN NULL  -- approval_requested says it, with the approval id
      ELSE NEW.status::text
    END;
  END IF;
  IF v_kind IS NULL THEN
    RETURN NEW;
  END IF;

  IF v_kind IN ('succeeded', 'failed', 'timed_out', 'cancelled')
     AND jsonb_typeof(NEW.error -> 'code') = 'string'
     AND (NEW.error ->> 'code') ~ '^[a-z0-9_]{1,64}$' THEN
    v_code := NEW.error ->> 'code';
  END IF;

  PERFORM agent_run_event_append(NEW.workspace_id, NEW.id, v_kind, NULL, v_code, NULL, NULL);
  RETURN NEW;
END;
$$;

CREATE TRIGGER agent_run_event_ins_trg
  AFTER INSERT ON agent_run
  FOR EACH ROW EXECUTE FUNCTION agent_run_event_on_run();

CREATE TRIGGER agent_run_event_upd_trg
  AFTER UPDATE OF status ON agent_run
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION agent_run_event_on_run();

-- -----------------------------------------------------------------------------
-- approval lifecycle -> ledger
-- -----------------------------------------------------------------------------
CREATE FUNCTION agent_run_event_on_approval() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_agent uuid;
BEGIN
  SELECT r.agent_member_id INTO v_agent
    FROM agent_run r
   WHERE r.workspace_id = NEW.workspace_id AND r.id = NEW.run_id;
  IF v_agent IS NULL OR NOT agent_run_event_is_hosted(NEW.workspace_id, v_agent) THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    PERFORM agent_run_event_append(
      NEW.workspace_id, NEW.run_id, 'approval_requested', NULL, NULL, NEW.id, NEW.requested_by);
  ELSE
    PERFORM agent_run_event_append(
      NEW.workspace_id, NEW.run_id, 'approval_decided', NULL, NEW.status::text, NEW.id, NEW.decided_by);
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER agent_run_event_approval_ins_trg
  AFTER INSERT ON approval
  FOR EACH ROW EXECUTE FUNCTION agent_run_event_on_approval();

CREATE TRIGGER agent_run_event_approval_upd_trg
  AFTER UPDATE OF status ON approval
  FOR EACH ROW WHEN (OLD.status = 'pending' AND NEW.status <> 'pending')
  EXECUTE FUNCTION agent_run_event_on_approval();

COMMENT ON FUNCTION agent_run_event_on_run() IS
  'ADR-0200 D2: hosted-agent run lifecycle transitions -> agent_run_event (same tx).';
COMMENT ON FUNCTION agent_run_event_on_approval() IS
  'ADR-0200 D2: approval requested/decided -> agent_run_event (same tx).';

-- -----------------------------------------------------------------------------
-- Append-only (review M3): no role can rewrite history. DELETE stays — the stage cap,
-- retention (S5) and the run's ON DELETE CASCADE need it — but UPDATE does not.
-- -----------------------------------------------------------------------------
CREATE FUNCTION agent_run_event_immutable() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'agent_run_event rows are immutable' USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER agent_run_event_immutable_trg
  BEFORE UPDATE ON agent_run_event
  FOR EACH ROW EXECUTE FUNCTION agent_run_event_immutable();

-- -----------------------------------------------------------------------------
-- The replacement for `ON DELETE CASCADE` (no FK, see the table): a run that goes —
-- directly, or through its channel or workspace — takes its ledger with it.
-- -----------------------------------------------------------------------------
CREATE FUNCTION agent_run_event_on_run_delete() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  DELETE FROM agent_run_event WHERE workspace_id = OLD.workspace_id AND run_id = OLD.id;
  RETURN OLD;
END;
$$;

CREATE TRIGGER agent_run_event_del_trg
  AFTER DELETE ON agent_run
  FOR EACH ROW EXECUTE FUNCTION agent_run_event_on_run_delete();

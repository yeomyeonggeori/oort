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

CREATE TABLE agent_run_event (
  workspace_id    uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  run_id          uuid NOT NULL,
  -- per-run monotonic, commit-ordered: allocated under a per-run advisory lock
  seq             bigint NOT NULL CHECK (seq > 0),
  kind            text NOT NULL,
  -- agent-reported marker: the SAME validator work_session_share uses (ADR-0162
  -- 증보 3 D11 — one rule, not a copy)
  stage           text,
  -- closed machine vocabulary (approval_expired, lease_abandoned, approved ...)
  code            text,
  -- soft references (no FK): they only ever travel back to members of the same
  -- workspace through the run's own visibility predicate
  approval_id     uuid,
  actor_member_id uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, run_id, seq),
  FOREIGN KEY (workspace_id, run_id)
    REFERENCES agent_run (workspace_id, id) ON DELETE CASCADE,
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

COMMENT ON TABLE agent_run_event IS
  'ADR-0200 D2: hosted-agent run event ledger (ids, closed codes, one stage marker). '
  'Cap 200 rows/run enforced by agent_run_event_append (oldest stage rows go first; lifecycle rows never).';

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
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE agent_run_event, hosted_agent_liveness TO momo_app;
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- The one writer. Returns the new seq (or the existing seq when an identical
-- stage repeats — an immediate repeat folds, exactly like output.stages).
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
  v_seq   bigint;
  v_last  record;
BEGIN
  -- A per-run advisory lock (not the run row lock): `claimed` is written by a
  -- transaction that holds the outbox row, other paths hold the run row first, so
  -- locking the run here would invert that order. This lock is a leaf.
  PERFORM pg_advisory_xact_lock(hashtextextended('agent_run_event:' || p_run_id::text, 0));

  SELECT seq, kind, stage INTO v_last
    FROM agent_run_event
   WHERE workspace_id = p_workspace_id AND run_id = p_run_id
   ORDER BY seq DESC LIMIT 1;

  IF p_kind = 'stage' AND v_last.kind = 'stage' AND v_last.stage IS NOT DISTINCT FROM p_stage THEN
    RETURN v_last.seq;
  END IF;

  v_seq := COALESCE(v_last.seq, 0) + 1;
  INSERT INTO agent_run_event
    (workspace_id, run_id, seq, kind, stage, code, approval_id, actor_member_id)
  VALUES
    (p_workspace_id, p_run_id, v_seq, p_kind, p_stage, p_code, p_approval_id, p_actor);

  RETURN v_seq;
END;
$$;

COMMENT ON FUNCTION agent_run_event_append(uuid, uuid, text, text, text, uuid, uuid) IS
  'ADR-0200 D2: the only INSERT into agent_run_event. SECURITY INVOKER; per-run advisory lock; folds an immediate stage repeat.';

-- -----------------------------------------------------------------------------
-- The 200-row cap, as its own function: the append above runs under roles that
-- hold no DELETE (the notifier's approval-expiry sweep fires it through a
-- trigger), so the only DELETE lives here and is called by the stage writer
-- (momo_app) alone. Oldest `stage` rows go first; lifecycle rows never.
-- -----------------------------------------------------------------------------
CREATE FUNCTION agent_run_event_trim(p_workspace_id uuid, p_run_id uuid) RETURNS integer
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_extra bigint;
  v_deleted integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('agent_run_event:' || p_run_id::text, 0));
  SELECT count(*) - 200 INTO v_extra
    FROM agent_run_event
   WHERE workspace_id = p_workspace_id AND run_id = p_run_id;
  IF v_extra <= 0 THEN
    RETURN 0;
  END IF;
  DELETE FROM agent_run_event e
   WHERE e.workspace_id = p_workspace_id AND e.run_id = p_run_id
     AND e.kind = 'stage'
     AND e.seq IN (
       SELECT s.seq FROM agent_run_event s
        WHERE s.workspace_id = p_workspace_id AND s.run_id = p_run_id AND s.kind = 'stage'
        ORDER BY s.seq ASC LIMIT v_extra
     );
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

COMMENT ON FUNCTION agent_run_event_trim(uuid, uuid) IS
  'ADR-0200 D2: 200-row cap — deletes the oldest stage rows only. Called by the stage writer, never by a trigger.';

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

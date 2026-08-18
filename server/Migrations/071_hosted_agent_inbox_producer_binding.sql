-- =============================================================================
-- 071_hosted_agent_inbox_producer_binding.sql — HAP-E5 / ADR-0162 D3,D6
--
-- 070 opened the hosted inbox with **no producer**. This goal opens the
-- producer, and a producer is exactly what turns two schema gaps into live
-- corruption paths, so both are closed here, in the database, before any code
-- can write through them.
--
-- Gap 1 — the outbox reference did not bind `kind`.
--   070's FK is (workspace_id, source_outbox_id, agent_member_id) →
--   outbox(workspace_id, id, partition_key). `partition_key = agent uuid`
--   is NOT a synonym for `kind = 'agent_job'`: the mention producer emits a
--   `broadcast` wake row with `partition_key = agent_member_id` in the very
--   same transaction as the job (see momo-server `routes/agent_mentions.rs`).
--   An `event_kind='agent_job'` row pointing at that wake row satisfied every
--   070 constraint. A generated `source_outbox_kind` column plus a
--   kind-inclusive unique index makes the reference kind-true by construction;
--   the column is NULL for every non-job event, so MATCH SIMPLE leaves the
--   message/run shapes untouched.
--
-- Gap 2 — the job reference and the run reference were unrelated.
--   The two columns of an `agent_job` row (source_outbox_id, source_run_id)
--   were each independently valid: the run FK proved the run belongs to this
--   agent and channel, and the outbox FK proved the job belongs to this agent,
--   but nothing proved they are the SAME piece of work. A trigger is used
--   rather than another FK because the job's run identity lives in
--   `outbox.payload->>'run_id'` — a jsonb expression, which PostgreSQL cannot
--   put behind a foreign key without a stored generated column on `outbox`
--   itself (a full rewrite of a hot table, and a hard failure on any legacy row
--   whose payload carries a non-uuid run_id). The trigger has the same
--   fail-closed strength on the only table that gains rows here.
--
-- No new ledger, queue, or projection table. `schema_v0.sql` is untouched.
-- =============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS outbox_workspace_id_id_partition_key_kind_uniq
  ON outbox (workspace_id, id, partition_key, kind);

ALTER TABLE hosted_agent_inbox_event
  ADD COLUMN source_outbox_kind outbox_kind
  GENERATED ALWAYS AS (
    CASE WHEN event_kind = 'agent_job' THEN 'agent_job'::outbox_kind END
  ) STORED;

COMMENT ON COLUMN hosted_agent_inbox_event.source_outbox_kind IS
  'Server-generated mirror of the referenced outbox kind; exists only so the outbox FK can bind kind. Never written by a producer.';

ALTER TABLE hosted_agent_inbox_event
  DROP CONSTRAINT hosted_agent_inbox_event_outbox_fk;

ALTER TABLE hosted_agent_inbox_event
  ADD CONSTRAINT hosted_agent_inbox_event_outbox_fk
  FOREIGN KEY (workspace_id, source_outbox_id, agent_member_id, source_outbox_kind)
  REFERENCES outbox(workspace_id, id, partition_key, kind) ON DELETE RESTRICT;

CREATE FUNCTION hosted_agent_inbox_event_job_binding()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  job_run_id text;
  job_agent_id text;
  job_method text;
  job_found boolean;
BEGIN
  IF NEW.event_kind <> 'agent_job' THEN
    RETURN NEW;
  END IF;
  SELECT true, o.payload->>'run_id', o.payload->>'agent_member_id', o.method
    INTO job_found, job_run_id, job_agent_id, job_method
    FROM outbox o
   WHERE o.workspace_id = NEW.workspace_id AND o.id = NEW.source_outbox_id;
  IF job_found IS NOT TRUE THEN
    RAISE EXCEPTION 'hosted agent inbox job reference has no visible source job';
  END IF;
  IF job_method IS DISTINCT FROM 'gateway' THEN
    RAISE EXCEPTION 'hosted agent inbox job reference must name a gateway job';
  END IF;
  -- Producers disagree on run_id casing (momo_agent::mention writes uppercase,
  -- the work/resume producers lowercase), so the comparison is case-folded for
  -- the same reason `retire_pending_agent_jobs_for_run_in_tx` folds it.
  IF lower(job_run_id) IS DISTINCT FROM lower(NEW.source_run_id::text) THEN
    RAISE EXCEPTION 'hosted agent inbox job and run references name different work';
  END IF;
  IF lower(job_agent_id) IS DISTINCT FROM lower(NEW.agent_member_id::text) THEN
    RAISE EXCEPTION 'hosted agent inbox job reference names another agent';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER hosted_agent_inbox_event_job_binding_guard
BEFORE INSERT ON hosted_agent_inbox_event
FOR EACH ROW EXECUTE FUNCTION hosted_agent_inbox_event_job_binding();

COMMENT ON FUNCTION hosted_agent_inbox_event_job_binding() IS
  'ADR-0162 producer closure: an agent_job reference must name a gateway job of this agent whose payload run_id is the referenced run.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'hosted_agent_inbox_event_outbox_fk'
       AND conrelid = 'hosted_agent_inbox_event'::regclass
       AND array_length(conkey, 1) = 4
  ) THEN
    RAISE EXCEPTION 'hosted inbox outbox FK did not gain the kind column';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'hosted_agent_inbox_event'::regclass
       AND tgname = 'hosted_agent_inbox_event_job_binding_guard'
       AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'hosted inbox job/run binding trigger is missing';
  END IF;
END $$;

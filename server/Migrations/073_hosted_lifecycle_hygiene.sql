-- =============================================================================
-- 073_hosted_lifecycle_hygiene.sql — #1375 + #1386 / ADR-0162 D3,D6,D7
--
-- 070 opened the hosted inbox ledger and 072 opened the disconnect manifest.
-- Neither is misbehaving today; both carry rules that are true only by accident
-- of what no caller happens to do yet. This migration converts the accidents
-- into constraints, and writes down — here, in the header, where a reviewer of
-- the next migration will read it — the three places it deliberately did NOT.
--
-- Every claim below was measured against PostgreSQL 18 with the full migration
-- set applied, before the fix; the paragraph says which way the measurement went.
--
-- =============================================================================
-- PART A — the inbox ledger (#1375)
-- =============================================================================
--
-- ## A1. The connection FK: RESTRICT was protecting the wrong verb
--
-- 070 gave `hosted_agent_inbox_event` an `ON DELETE RESTRICT` FK to the
-- connection, while 069 makes the connection CASCADE from both `workspace` and
-- `agent`. The review (#1375) predicted that a workspace hard delete would wedge
-- on it. **Measured: it does not.** PostgreSQL queues every FK action of the
-- top-level `DELETE FROM workspace` as an after-trigger before any action those
-- cascades queue in turn, so the ledger's own workspace-CASCADE always runs
-- before the connection-CASCADE's RESTRICT check. That is a property of the
-- queue, not of this schema's constraint order, and it holds.
--
-- The **agent** half of the same sentence is where the wedge actually lives:
--
--     DELETE FROM agent WHERE workspace_id = … AND member_id = …
--     ERROR: update or delete on table "hosted_agent_connection" violates
--            RESTRICT setting of foreign key constraint
--            "hosted_agent_inbox_event_connection_fk"
--
-- The ledger does not cascade from the agent, so nothing removes it first, and
-- the RESTRICT fires. Worse, the operator cannot then clear it by hand: 070's
-- append-only trigger refuses a direct DELETE, so the wedge has no exit.
--
-- The bug is not that the connection is protected. It is that a foreign key
-- cannot tell *deleting this connection* from *the agent that owns it is being
-- torn down*, and RESTRICT answers both with the same refusal. So the two verbs
-- are separated: the FK becomes CASCADE (teardown carries the ledger with it,
-- because a connection-scoped cursor projection has no meaning once its
-- connection is gone), and the refusal moves to a BEFORE DELETE guard on
-- `hosted_agent_connection` that fires only when the connection's owners are
-- **still there** — which is exactly the "someone is deleting this one row"
-- case that RESTRICT was worth having for.
--
-- Owner-liveness, not `pg_trigger_depth()`, is the discriminator, because it is
-- order-independent: the workspace row is deleted before any of its cascades
-- run, and the agent row before the connection cascade it triggers, so in a
-- teardown at least one owner is always already gone no matter which FK the
-- queue reaches first.
--
-- ## A2. The append-only guard was open to every trigger in the database
--
-- 070's guard refuses `TG_OP='UPDATE' OR pg_trigger_depth() = 1`. The depth
-- test was meant to say "this is the workspace cascade". It says "this is not
-- top level", which any trigger anywhere satisfies. **Measured** before the fix,
-- an unrelated `AFTER INSERT` trigger on an unrelated table deleted an entire
-- workspace's ledger and committed.
--
-- The replacement asks the question the depth test was standing in for: is the
-- row's owner already gone? A workspace teardown and a connection teardown both
-- answer yes; a top-level DELETE, a plpgsql function and an arbitrary trigger
-- all answer no. The exception text is unchanged, because it was already right.
--
-- ## A3. The outbox reference and the queue-pruning contract — DECIDED, not changed
--
-- `outbox` is documented as a queue whose rows are deleted after consumption
-- (schema_v0.sql, Centrifugo-native-consumer compatibility), and 071 bound the
-- ledger's job reference to `outbox(workspace_id, id, partition_key, kind)` so
-- an `agent_job` event cannot point at a wake broadcast. Those two facts are in
-- tension and this migration resolves it in favour of the reference:
--
--   **The hosted inbox ledger is the retention floor for the outbox rows it
--   names.** A referenced job row is not prunable while the ledger row exists,
--   and the ledger row lives as long as its connection does (A1). A pruner must
--   therefore anti-join the ledger rather than filter on age alone; the index
--   added below is what makes that anti-join cheap, and it is the only reason
--   this section writes DDL at all.
--
-- Snapshot columns were the alternative and are refused: a hosted agent fetches
-- the job the reference names, so a reference whose target has been pruned is
-- not a preserved fact but a dangling one. Nothing is gained by recording it
-- more durably than the thing it points at.
--
-- The FK stays RESTRICT. NO ACTION would move the failure from the offending
-- row to the end of the statement without letting a single additional prune
-- succeed, and RESTRICT names the row a pruner has to exclude.
--
-- ## A4. The tombstone note (#1375, "결정 필요") — VERIFIED CLOSED, no change
--
-- 070's review noted that `append_message_reference_in_tx` reads `message.seq`
-- without a `deleted_at` filter, so a soft-deleted message could in principle
-- enter the ledger as a reference. HAP-E5 placed the producer inside the send
-- transaction, immediately after the message row is created
-- (`momo-messaging/src/message.rs`, step 5), which is the only call site that
-- exists. A message cannot be tombstoned before it is sent, so the filter would
-- be unreachable code. Recorded as closed by placement rather than by predicate.
--
-- =============================================================================
-- PART B — the disconnect manifest (#1386 remainder)
-- =============================================================================
--
-- 072 put four clauses behind the terminal transition and named, in its own
-- header, the four things it left for this migration. Three of them are fixed
-- here and the fourth is decided.
--
-- ## B1. A row that arrives already terminal
--
-- 072's trigger is `BEFORE UPDATE OF status`, so every clause it enforces is
-- reachable only by a caller that *transitions*. **Measured**: an INSERT
-- carrying `status='disconnected'` satisfies 069's shape CHECKs and lands, with
-- no manifest, no revoke and no pause. `cleanup_pending` inserts the same way.
-- Both are now refused: the two terminal-ward states are products of the
-- disconnect lifecycle and a connection is born before it has one.
--
-- ## B2. Leaving the terminal
--
-- 072 returns early when `OLD.status = 'disconnected'`, so the terminal was a
-- state the guard stopped watching. **Measured**: `disconnected → detected`
-- committed. Every Rust path already refuses it — this is the repair-script
-- exposure #1386 F3 names — so the database now refuses it too, and
-- `disconnected` becomes what its name claims: final.
--
-- ## B3. `acknowledged_by → member` — SEALED, with the reason
--
-- 072's actor FK is NO ACTION, so hard-deleting a human member who acknowledged
-- an artifact would fail. It is sealed rather than relaxed, on three findings:
--
--   1. **The wedge is not this table's.** Measured, a human member hard delete
--      already fails on `message_author_member_id_fkey` (schema_v0) for anyone
--      who ever posted, and on `agent_run.agent_member_id` for any agent that
--      ever ran. `acknowledged_by` adds no case that is not already blocked.
--   2. **Members are soft-deleted.** `member.deleted_at` and `member.status`
--      are the removal verbs the product actually uses; 069 makes the identical
--      choice for `confirmed_by`, `created_by`, `detected_by` and `proved_by`.
--   3. **`ON DELETE SET NULL` is not available.** A resolved artifact whose
--      `source = 'manual'` must carry an actor
--      (`hosted_agent_connection_artifact_ack_shape_ck`), so nulling the column
--      trades a foreign-key failure for a check failure and destroys the audit
--      fact on the way. The wedge would not even be removed.
--
-- Workspace teardown is unaffected and measured green: NO ACTION is checked at
-- end of statement, by which time the artifact rows have cascaded away.
--
-- ## B4. Not tightened here, and why — the manifest completeness gate
--
-- 072's non-empty-manifest clause is weaker than the rule it stands for: it
-- accepts a manifest holding one row where the lifecycle seeds six. The
-- honest clause is per-kind completeness, and it is not written here because
-- three landed fixtures across the E4 and E5 verifiers encode the single-row
-- shape; changing the clause means rewriting fixtures those goals own. The
-- retry path that could have *created* a partial manifest is closed in Rust
-- instead (`seed_manifest_in_tx` reseeds every missing kind on retry, without
-- the `server_verified` provenance a retry has not earned), so no code path
-- reaches the gap. It belongs to a fixture-normalization goal, not to this one.
--
-- No message, audit, ledger or manifest row is deleted by this migration, and
-- `schema_v0.sql` is untouched.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- A1 — teardown cascades; a bare connection delete does not.
-- ---------------------------------------------------------------------------
ALTER TABLE hosted_agent_inbox_event
  DROP CONSTRAINT hosted_agent_inbox_event_connection_fk;

ALTER TABLE hosted_agent_inbox_event
  ADD CONSTRAINT hosted_agent_inbox_event_connection_fk
  FOREIGN KEY (workspace_id, connection_id, agent_member_id)
  REFERENCES hosted_agent_connection(workspace_id, id, agent_member_id) ON DELETE CASCADE;

CREATE FUNCTION hosted_agent_connection_ledger_delete_guard()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  -- Owner already gone ⇒ this DELETE is a teardown cascade, and the ledger is
  -- meant to travel with it. Checked in the order the cascades fire.
  IF NOT EXISTS (SELECT 1 FROM public.workspace w WHERE w.id = OLD.workspace_id) THEN
    RETURN OLD;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.agent a
     WHERE a.workspace_id = OLD.workspace_id AND a.member_id = OLD.agent_member_id
  ) THEN
    RETURN OLD;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.hosted_agent_inbox_event e
     WHERE e.workspace_id = OLD.workspace_id AND e.connection_id = OLD.id
  ) THEN
    RAISE EXCEPTION
      'hosted connection with inbox ledger rows cannot be deleted directly';
  END IF;
  RETURN OLD;
END $$;

CREATE TRIGGER hosted_agent_connection_ledger_delete_guard_trigger
BEFORE DELETE ON hosted_agent_connection
FOR EACH ROW EXECUTE FUNCTION hosted_agent_connection_ledger_delete_guard();

COMMENT ON FUNCTION hosted_agent_connection_ledger_delete_guard() IS
  'ADR-0162 #1375: the RESTRICT that 070 put on the inbox ledger FK, re-expressed so it refuses a bare connection delete without wedging an agent or workspace teardown.';

-- ---------------------------------------------------------------------------
-- A2 — append-only means append-only at every trigger depth.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION hosted_agent_inbox_event_append_only()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'hosted agent inbox events are append-only';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.workspace w WHERE w.id = OLD.workspace_id) THEN
    RETURN OLD;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.hosted_agent_connection c
     WHERE c.workspace_id = OLD.workspace_id AND c.id = OLD.connection_id
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'hosted agent inbox events are append-only';
END $$;

COMMENT ON FUNCTION hosted_agent_inbox_event_append_only() IS
  'ADR-0162 #1375: a ledger row is deletable only while its workspace or its connection is itself being removed; pg_trigger_depth() admitted every trigger in the database.';

-- ---------------------------------------------------------------------------
-- A3 — the pruner's anti-join, indexed. The FK is unchanged by decision.
-- ---------------------------------------------------------------------------
CREATE INDEX hosted_agent_inbox_event_outbox_ref_idx
  ON hosted_agent_inbox_event (workspace_id, source_outbox_id)
  WHERE event_kind = 'agent_job';

COMMENT ON INDEX hosted_agent_inbox_event_outbox_ref_idx IS
  'Retention contract (#1375): an outbox row named by a hosted inbox job reference is not prunable while the reference exists. This index is how a pruner excludes them without a sequential scan of the ledger.';

COMMENT ON CONSTRAINT hosted_agent_inbox_event_outbox_fk ON hosted_agent_inbox_event IS
  'RESTRICT by decision, not by omission: the ledger is the retention floor for the job rows it names, because a hosted agent fetches the job the reference resolves to.';

-- ---------------------------------------------------------------------------
-- B1/B2 — the terminal state is entered by exactly one transition and left by
-- none. The four HAP-E6 clauses are unchanged; INSERT and terminal-exit are the
-- two doors 072 named and left open.
-- ---------------------------------------------------------------------------
CREATE FUNCTION hosted_agent_connection_terminal_insert_guard()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.status IN ('cleanup_pending', 'disconnected') THEN
    RAISE EXCEPTION
      'hosted connection cannot be created in %', NEW.status;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER hosted_agent_connection_terminal_insert_guard_trigger
BEFORE INSERT ON hosted_agent_connection
FOR EACH ROW EXECUTE FUNCTION hosted_agent_connection_terminal_insert_guard();

COMMENT ON FUNCTION hosted_agent_connection_terminal_insert_guard() IS
  'ADR-0162 HAP-E6 / #1386 F2: cleanup_pending and disconnected are products of the disconnect lifecycle, so no row is born in either.';

CREATE OR REPLACE FUNCTION hosted_agent_connection_terminal_guard()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  -- #1386 F3: terminal is terminal. Refused before anything else, so a
  -- resurrection cannot be disguised as a transition to some third state.
  IF OLD.status = 'disconnected' THEN
    IF NEW.status <> 'disconnected' THEN
      RAISE EXCEPTION
        'hosted connection cannot leave disconnected for %', NEW.status;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status <> 'disconnected' THEN
    RETURN NEW;
  END IF;
  IF OLD.status <> 'cleanup_pending' THEN
    RAISE EXCEPTION
      'hosted connection cannot reach disconnected from %', OLD.status;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.hosted_agent_connection_artifact a
     WHERE a.workspace_id = NEW.workspace_id AND a.connection_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'hosted connection has no cleanup artifact manifest';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.hosted_agent_connection_artifact a
     WHERE a.workspace_id = NEW.workspace_id AND a.connection_id = NEW.id
       AND a.required AND NOT a.resolved
  ) THEN
    RAISE EXCEPTION 'hosted connection has unresolved required cleanup artifacts';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.token t
     WHERE t.workspace_id = NEW.workspace_id AND t.hosted_connection_id = NEW.id
       AND t.revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'hosted connection still has a live credential';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.agent_profile p
     WHERE p.workspace_id = NEW.workspace_id
       AND p.agent_member_id = NEW.agent_member_id AND p.paused
  ) THEN
    RAISE EXCEPTION 'hosted connection agent is not paused';
  END IF;
  RETURN NEW;
END $$;

COMMENT ON FUNCTION hosted_agent_connection_terminal_guard() IS
  'ADR-0162 HAP-E6: disconnected is reachable only from cleanup_pending, and only with a seeded manifest whose required artifacts are all resolved, zero live hosted credentials, and a paused dedicated agent — and (#1386 F3) it is never left.';

-- ---------------------------------------------------------------------------
-- B3 — the actor FK is sealed by decision. The comment is the artifact.
-- ---------------------------------------------------------------------------
COMMENT ON CONSTRAINT hosted_agent_connection_artifact_actor_fk
  ON hosted_agent_connection_artifact IS
  'NO ACTION by decision (#1386 F5): members are soft-deleted, a human who ever posted is already pinned by message_author_member_id_fkey, and ON DELETE SET NULL would violate the acknowledgement shape CHECK rather than free the row. Workspace teardown is unaffected — NO ACTION is checked once the artifact rows have cascaded away.';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'hosted_agent_inbox_event_connection_fk'
       AND conrelid = 'hosted_agent_inbox_event'::regclass
       AND confdeltype <> 'c'
  ) THEN
    RAISE EXCEPTION 'hosted inbox connection FK did not become ON DELETE CASCADE';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'hosted_agent_inbox_event_outbox_fk'
       AND conrelid = 'hosted_agent_inbox_event'::regclass
       AND array_length(conkey, 1) = 4
       AND confdeltype = 'r'
  ) THEN
    RAISE EXCEPTION 'hosted inbox outbox FK lost its kind column or its RESTRICT';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'hosted_agent_connection'::regclass
       AND tgname = 'hosted_agent_connection_ledger_delete_guard_trigger'
       AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'hosted connection ledger delete guard trigger is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'hosted_agent_connection'::regclass
       AND tgname = 'hosted_agent_connection_terminal_insert_guard_trigger'
       AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'hosted connection terminal insert guard trigger is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
     WHERE i.indrelid = 'hosted_agent_inbox_event'::regclass
       AND c.relname = 'hosted_agent_inbox_event_outbox_ref_idx'
  ) THEN
    RAISE EXCEPTION 'hosted inbox outbox retention index is missing';
  END IF;
END $$;

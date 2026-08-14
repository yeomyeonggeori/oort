-- =============================================================================
-- 072_hosted_agent_disconnect_manifest.sql — HAP-E6 / ADR-0162 D7
--
-- 069 gave `hosted_agent_connection` two terminal-ward states (`cleanup_pending`,
-- `disconnected`) and a free-form `cleanup_manifest` jsonb that nothing wrote.
-- A jsonb blob cannot carry the rule this goal exists to enforce, so the
-- manifest becomes rows, and the rules become constraints.
--
-- ## What #1344 measured, and what each measurement costs in schema
--
-- 1. **A connector `Uninstall` left the local plugin files on disk.** So
--    `connector` and `local_plugin_files` are two *rows*, never one. Resolving
--    the connector cannot resolve the files, because nothing in this table lets
--    one row's disposition reach another's.
-- 2. **An inactive Routine is still a Routine.** So "is it still there" and
--    "what was decided about it" are two columns: `current_status` may say
--    `inactive` forever and the row stays unresolved, because only
--    `disposition` resolves and `inactive` is not a disposition.
-- 3. **Deleting a Grok Bot deletes its chat history, with no confirmation.**
--    So `bot` is the one kind whose legal terminal set contains `preserved`.
--    oort never auto-deletes provider chat history, and the schema makes
--    "preserve" a first-class answer rather than an unresolved excuse.
--
-- ## Why a disposition and not a boolean `resolved`
--
-- A boolean would let a caller write the *conclusion* without the *decision*.
-- Here the conclusion is derived: `resolved` is a STORED generated column over
-- `disposition`, so no writer can claim resolution while leaving the decision
-- blank, and the terminal transition's `NOT EXISTS (… AND required AND NOT
-- resolved)` reads one indexed column instead of re-deriving a rule that two
-- code paths could spell differently.
--
-- ## Provenance is a closed vocabulary, not a client string
--
-- `source` is `server_verified` or `manual`. `server_verified` is reserved for
-- what THIS server can observe in its own tables — today exactly one thing: the
-- hosted bearer it revoked itself. Everything a provider owns is `manual`, and
-- a manual row must carry evidence text and a human actor. An untrusted client
-- cannot promote itself: the API never reads `source` from a request body.
--
-- No message, chat, audit or inbox row is deleted here, and nothing cascades
-- into one. `schema_v0.sql` is untouched.
-- =============================================================================

CREATE TABLE hosted_agent_connection_artifact (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id     uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  connection_id    uuid NOT NULL,
  agent_member_id  uuid NOT NULL,
  kind             text NOT NULL CHECK (kind IN (
                     'bot','routine','plugin','connector','local_plugin_files','secret')),
  -- A bounded, non-secret provider-side identifier. NULL is the seeded
  -- per-kind row: "this kind, as a whole". A named item is an extra row.
  external_ref     text CHECK (external_ref IS NULL OR (
                     octet_length(external_ref) BETWEEN 1 AND 200
                     AND external_ref NOT LIKE 'momo\_pair\_v1.%'
                     AND external_ref NOT LIKE 'momo\_agent\_v1.%')),
  expected_action  text NOT NULL CHECK (expected_action IN ('remove','revoke','decide')),
  current_status   text NOT NULL DEFAULT 'unknown'
                     CHECK (current_status IN ('unknown','present','inactive','absent')),
  disposition      text NOT NULL DEFAULT 'pending'
                     CHECK (disposition IN ('pending','removed','preserved','revoked')),
  -- Derived, never written. This is the only definition of "resolved".
  resolved         boolean GENERATED ALWAYS AS (disposition <> 'pending') STORED,
  required         boolean NOT NULL DEFAULT true,
  source           text CHECK (source IN ('server_verified','manual')),
  acknowledged_by  uuid,
  acknowledged_at  timestamptz,
  evidence         text CHECK (evidence IS NULL OR octet_length(evidence) BETWEEN 1 AND 2000),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hosted_agent_connection_artifact_connection_fk
    FOREIGN KEY (workspace_id, connection_id, agent_member_id)
    REFERENCES hosted_agent_connection(workspace_id, id, agent_member_id) ON DELETE CASCADE,
  CONSTRAINT hosted_agent_connection_artifact_actor_fk
    FOREIGN KEY (workspace_id, acknowledged_by) REFERENCES member(workspace_id, id),
  -- #1344 lesson 3: `preserved` is legal for a bot and for nothing else, and a
  -- secret is revoked rather than removed. The expected action follows the kind
  -- so a row cannot be seeded asking a bot to be silently removed.
  CONSTRAINT hosted_agent_connection_artifact_kind_action_ck CHECK (
    (kind = 'bot' AND expected_action = 'decide')
    OR (kind = 'secret' AND expected_action = 'revoke')
    OR (kind IN ('routine','plugin','connector','local_plugin_files')
        AND expected_action = 'remove')
  ),
  CONSTRAINT hosted_agent_connection_artifact_disposition_ck CHECK (
    disposition = 'pending'
    OR (kind = 'bot' AND disposition IN ('removed','preserved'))
    OR (kind = 'secret' AND disposition = 'revoked')
    OR (kind IN ('routine','plugin','connector','local_plugin_files')
        AND disposition = 'removed')
  ),
  -- A resolution without a recorded actor, time and provenance is not a
  -- resolution. The reverse is equally load-bearing: an unresolved row cannot
  -- carry an acknowledgement, so an observation can never look like a decision.
  CONSTRAINT hosted_agent_connection_artifact_ack_shape_ck CHECK (
    (disposition = 'pending'
      AND source IS NULL AND acknowledged_by IS NULL AND acknowledged_at IS NULL)
    OR (disposition <> 'pending'
      AND source IS NOT NULL AND acknowledged_at IS NOT NULL
      AND (source = 'server_verified'
           OR (acknowledged_by IS NOT NULL AND evidence IS NOT NULL)))
  ),
  -- Only oort's own credential can ever be server-verified: it is the single
  -- artifact whose removal this server performs and can read back.
  CONSTRAINT hosted_agent_connection_artifact_server_verified_ck CHECK (
    source IS DISTINCT FROM 'server_verified' OR kind = 'secret'
  )
);

-- One seeded row per kind, plus at most one row per named item. `COALESCE` is
-- what makes the seeded row and a named item distinguishable in one index.
CREATE UNIQUE INDEX hosted_agent_connection_artifact_item_uniq
  ON hosted_agent_connection_artifact (workspace_id, connection_id, kind,
                                       COALESCE(external_ref, ''));
CREATE INDEX hosted_agent_connection_artifact_unresolved_idx
  ON hosted_agent_connection_artifact (workspace_id, connection_id)
  WHERE required AND NOT resolved;

COMMENT ON TABLE hosted_agent_connection_artifact IS
  'ADR-0162 HAP-E6 cleanup manifest: one row per provider artifact a disconnect must resolve. Never provider credentials or chat content.';
COMMENT ON COLUMN hosted_agent_connection_artifact.resolved IS
  'Derived from disposition. A connector row resolving never resolves the local_plugin_files row; an inactive routine is not a disposition.';
COMMENT ON COLUMN hosted_agent_connection_artifact.source IS
  'server_verified is reserved for artifacts this server removes itself (the hosted bearer); provider-owned artifacts are manual and carry actor plus evidence.';

ALTER TABLE hosted_agent_connection_artifact ENABLE ROW LEVEL SECURITY;
ALTER TABLE hosted_agent_connection_artifact FORCE ROW LEVEL SECURITY;
CREATE POLICY ws_isolation ON hosted_agent_connection_artifact
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

-- ---------------------------------------------------------------------------
-- The terminal state is guarded in the database as well as in the transaction.
--
-- The Rust transition already refuses an unresolved manifest, but the rule that
-- matters most in this goal is exactly the kind that a later caller — a repair
-- script, a future admin route, a migration backfill — reaches around. So the
-- database holds it too: `disconnected` requires every required artifact
-- resolved AND no live hosted credential left on the connection.
-- ---------------------------------------------------------------------------
CREATE FUNCTION hosted_agent_connection_terminal_guard()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.status <> 'disconnected' OR OLD.status = 'disconnected' THEN
    RETURN NEW;
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

CREATE TRIGGER hosted_agent_connection_terminal_guard_trigger
BEFORE UPDATE OF status ON hosted_agent_connection
FOR EACH ROW EXECUTE FUNCTION hosted_agent_connection_terminal_guard();

COMMENT ON FUNCTION hosted_agent_connection_terminal_guard() IS
  'ADR-0162 HAP-E6: disconnected requires every required artifact resolved, zero live hosted credentials, and a paused dedicated agent.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = current_schema()
       AND tablename = 'hosted_agent_connection_artifact' AND policyname = 'ws_isolation'
  ) THEN
    RAISE EXCEPTION 'missing ws_isolation policy on hosted_agent_connection_artifact';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = current_schema() AND c.relname = 'hosted_agent_connection_artifact'
       AND c.relrowsecurity AND c.relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'RLS FORCE missing on hosted_agent_connection_artifact';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'hosted_agent_connection'::regclass
       AND tgname = 'hosted_agent_connection_terminal_guard_trigger'
       AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'hosted connection terminal guard trigger is missing';
  END IF;
END $$;

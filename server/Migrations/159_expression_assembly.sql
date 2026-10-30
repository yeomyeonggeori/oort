-- ADR-0218 G3.6, #4820 C1b. The server keeps what `oort_expression_assemble` built under an
-- `assemblyId` for one hour, bound to the workspace, the requesting agent and the person the
-- run was raised by. It is the sibling of `expression_draft` / `expression_draft_image`
-- (158): the same three renditions with the same immutable-pixel CHECKs, the same one-hour
-- TTL, the same reclaim (bytes deleted, the row stays as a record in state `expired`) and the
-- same sweep. Nothing here stores a picture the agent sent: only what the assembler built.
CREATE TABLE expression_assembly (
  workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT uuidv7(),
  agent_member_id uuid NOT NULL,
  requester_member_id uuid NOT NULL,
  -- G3.6: what the server received at assembly time becomes the candidates' `origin`.
  prompt text NOT NULL CHECK (char_length(prompt) BETWEEN 1 AND 2000),
  -- G1: a record pointer, not a key to the attachment. No foreign key: it survives a deleted
  -- attachment. Never copied to an audit row, a log line or an outbox row.
  source_attachment_id uuid,
  -- Candidates that were built too large (G3.8 partial failure): `[{index, motion, code, bytes}]`.
  -- They hold no bytes, so they never count against the agent's twelve; a later
  -- `expression.create` reads the hole's code from here.
  failed jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(failed) = 'array' AND jsonb_array_length(failed) <= 4),
  state text NOT NULL DEFAULT 'ready' CHECK (state IN ('ready','expired')),
  expires_at timestamptz NOT NULL DEFAULT (clock_timestamp() + interval '1 hour'),
  PRIMARY KEY (workspace_id,id),
  FOREIGN KEY (workspace_id,agent_member_id) REFERENCES member(workspace_id,id),
  FOREIGN KEY (workspace_id,requester_member_id) REFERENCES member(workspace_id,id)
);
CREATE INDEX expression_assembly_ttl_idx ON expression_assembly(workspace_id,expires_at) WHERE state = 'ready';
CREATE INDEX expression_assembly_agent_idx ON expression_assembly(workspace_id,agent_member_id) WHERE state = 'ready';

-- One row per rendition of one candidate (`small`, `large`, `thumb`), made the way 158 made
-- `expression_draft_image`: LIKE keeps the byte caps, the dimension caps, the GIF/PNG shape
-- rules and the `sha256 = sha256(bytes)` proof; the expression it would belong to does not exist.
CREATE TABLE expression_assembly_image (
  LIKE expression_image INCLUDING DEFAULTS INCLUDING CONSTRAINTS,
  assembly_id uuid NOT NULL,
  candidate_index integer NOT NULL CHECK (candidate_index BETWEEN 0 AND 3),
  motion text NOT NULL CHECK (motion IN ('bounce','wobble','pulse','sparkle','sprite')),
  PRIMARY KEY (workspace_id,id),
  UNIQUE (workspace_id,assembly_id,candidate_index,variant),
  FOREIGN KEY (workspace_id,assembly_id) REFERENCES expression_assembly(workspace_id,id) ON DELETE CASCADE
);
ALTER TABLE expression_assembly_image DROP COLUMN expression_id;

-- Pixels never change after they are written; the header may only retire (ready -> expired).
CREATE FUNCTION expression_assembly_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'expression_assembly_image' THEN
    RAISE EXCEPTION 'expression pixels are immutable' USING ERRCODE = '23514';
  END IF;
  IF (to_jsonb(NEW) - 'state') IS DISTINCT FROM (to_jsonb(OLD) - 'state')
     OR (OLD.state = 'expired' AND NEW.state <> 'expired') THEN
    RAISE EXCEPTION 'assembly identity is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER expression_assembly_identity BEFORE UPDATE ON expression_assembly
  FOR EACH ROW EXECUTE FUNCTION expression_assembly_immutable();
CREATE TRIGGER expression_assembly_image_immutable BEFORE UPDATE ON expression_assembly_image
  FOR EACH ROW EXECUTE FUNCTION expression_assembly_immutable();

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['expression_assembly','expression_assembly_image'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY ws_isolation ON %I USING (workspace_id = current_setting(''app.workspace_id'',true)::uuid) WITH CHECK (workspace_id = current_setting(''app.workspace_id'',true)::uuid)',t);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_app') THEN
      EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO momo_app',t);
    END IF;
  END LOOP;
END $$;

-- A held assembly is the requesting agent's alone (G3.6: another agent's `assemblyId` is the
-- same "invalid arguments" as an unknown one). `app.agent_member_id` is the server-
-- authenticated caller `momo-db` binds in every tenant transaction of an Agent Port request
-- (ADR-0217); outside one (the TTL sweep, a person's decision) it is empty and this policy
-- adds nothing. RESTRICTIVE, so `ws_isolation` cannot OR it away. The image table has no agent
-- column: it follows its header, and the header's own policy decides what that sees.
CREATE POLICY expression_assembly_agent ON expression_assembly AS RESTRICTIVE
  USING (NULLIF(current_setting('app.agent_member_id', true), '') IS NULL
         OR agent_member_id = NULLIF(current_setting('app.agent_member_id', true), '')::uuid);
CREATE POLICY expression_assembly_image_agent ON expression_assembly_image AS RESTRICTIVE
  USING (NULLIF(current_setting('app.agent_member_id', true), '') IS NULL
         OR EXISTS (SELECT 1 FROM expression_assembly a
                     WHERE a.workspace_id = expression_assembly_image.workspace_id
                       AND a.id = expression_assembly_image.assembly_id));

-- Discovery follows the existing notifier polling exception (158): the notifier learns which
-- tenants have something expired; reclamation itself always uses momo_app with a
-- workspace-bound NOBYPASSRLS transaction.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_notifier') THEN
    GRANT SELECT (workspace_id,state,expires_at) ON expression_assembly TO momo_notifier;
  END IF;
END $$;

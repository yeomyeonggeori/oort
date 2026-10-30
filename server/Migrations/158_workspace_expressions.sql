-- ADR-0218 D1–D3/D6, #4676. Model (a); permanent names, immutable pixels.
ALTER TABLE approval ADD CONSTRAINT expression_approval_ws_id UNIQUE (workspace_id,id);
CREATE TABLE expression_catalog (
  workspace_id uuid PRIMARY KEY REFERENCES workspace(id) ON DELETE CASCADE,
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  add_policy text NOT NULL DEFAULT 'members' CHECK (add_policy IN ('members','admins'))
);

CREATE FUNCTION expression_tags_valid(tags jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT CASE WHEN jsonb_typeof(tags) <> 'array' THEN false ELSE
    jsonb_array_length(tags) <= 8 AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(tags) t
      WHERE jsonb_typeof(t) <> 'string' OR char_length(t #>> '{}') NOT BETWEEN 1 AND 16
        OR (t #>> '{}') ~ '[[:cntrl:]@<>\[\]`\\]'
    ) AND (SELECT count(*) = count(DISTINCT t) FROM jsonb_array_elements(tags) t) END
$$;

CREATE TABLE expression (
  workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT uuidv7(),
  name text NOT NULL CHECK (name ~ '^[a-z0-9_-]{2,30}$'),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 40 AND display_name !~ '[[:cntrl:]@<>\[\]`\\]'),
  tags jsonb NOT NULL CHECK (expression_tags_valid(tags)),
  subject_member_id uuid,
  origin jsonb NOT NULL,
  created_by uuid NOT NULL,
  proposed_by uuid,
  approval_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','hidden','deleted')),
  version bigint NOT NULL CHECK (version > 0),
  hidden_at timestamptz,
  deleted_at timestamptz,
  PRIMARY KEY (workspace_id,id),
  UNIQUE (workspace_id,name),
  FOREIGN KEY (workspace_id,created_by) REFERENCES member(workspace_id,id),
  FOREIGN KEY (workspace_id,subject_member_id) REFERENCES member(workspace_id,id),
  FOREIGN KEY (workspace_id,proposed_by) REFERENCES member(workspace_id,id),
  FOREIGN KEY (workspace_id,approval_id) REFERENCES approval(workspace_id,id)
);
CREATE INDEX expression_delta_idx ON expression(workspace_id,version);

CREATE TABLE expression_draft (
  workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT uuidv7(),
  name text NOT NULL CHECK (name ~ '^[a-z0-9_-]{2,30}$'),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 40),
  tags jsonb NOT NULL CHECK (expression_tags_valid(tags)),
  subject_member_id uuid,
  origin jsonb NOT NULL,
  creator uuid NOT NULL,
  approval_id uuid,
  candidate_index integer CHECK (candidate_index BETWEEN 0 AND 3),
  state text NOT NULL CHECK (state IN ('ready','manual_upload_required','activated','expired')),
  code text CHECK (code IN ('source_blocked','source_unavailable','source_too_large','source_unsupported','source_timeout','source_invalid_media','video_processing_unavailable','video_conversion_failed')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  expires_at timestamptz NOT NULL DEFAULT (clock_timestamp() + interval '1 hour'),
  submitted_by uuid,
  submitted_revision bigint,
  submitted_sha256 text,
  receipt jsonb,
  PRIMARY KEY (workspace_id,id),
  UNIQUE (workspace_id,id,revision),
  FOREIGN KEY (workspace_id,creator) REFERENCES member(workspace_id,id),
  FOREIGN KEY (workspace_id,subject_member_id) REFERENCES member(workspace_id,id),
  FOREIGN KEY (workspace_id,submitted_by) REFERENCES member(workspace_id,id),
  FOREIGN KEY (workspace_id,approval_id) REFERENCES approval(workspace_id,id),
  CHECK ((state = 'manual_upload_required') = (code IS NOT NULL)),
  CHECK ((state = 'activated') = (receipt IS NOT NULL)),
  CHECK (state <> 'activated' OR (submitted_by IS NOT NULL AND submitted_revision IS NOT NULL AND submitted_sha256 ~ '^[a-f0-9]{64}$'))
);
CREATE INDEX expression_draft_ttl_idx ON expression_draft(workspace_id,expires_at) WHERE state <> 'activated';

CREATE TABLE expression_image (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT uuidv7(),
  expression_id uuid NOT NULL,
  variant text NOT NULL CHECK (variant IN ('small','large','thumb')),
  mime text NOT NULL CHECK (mime IN ('image/png','image/gif')),
  bytes bytea NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  width integer NOT NULL CHECK (width > 0),
  height integer NOT NULL CHECK (height > 0),
  frame_count integer NOT NULL,
  duration_ms integer NOT NULL,
  PRIMARY KEY (workspace_id,id),
  UNIQUE (workspace_id,expression_id,variant),
  FOREIGN KEY (workspace_id,expression_id) REFERENCES expression(workspace_id,id) ON DELETE CASCADE,
  CHECK (octet_length(bytes) BETWEEN 1 AND CASE WHEN variant = 'large' THEN 1048576 ELSE 262144 END),
  CHECK (greatest(width,height) <= CASE WHEN variant = 'large' THEN 512 ELSE 128 END),
  CHECK ((mime = 'image/png' AND frame_count = 1 AND duration_ms = 0) OR
         (mime = 'image/gif' AND variant <> 'thumb' AND frame_count BETWEEN 2 AND 100 AND duration_ms BETWEEN 20 AND 10000)),
  CHECK (sha256 = encode(sha256(bytes),'hex'))
);

CREATE TABLE expression_draft_image (
  LIKE expression_image INCLUDING DEFAULTS INCLUDING CONSTRAINTS,
  draft_id uuid NOT NULL,
  revision bigint NOT NULL,
  PRIMARY KEY (workspace_id,id),
  UNIQUE (workspace_id,draft_id,variant),
  FOREIGN KEY (workspace_id,draft_id,revision) REFERENCES expression_draft(workspace_id,id,revision) ON DELETE CASCADE
);
-- LIKE does not copy FKs; the draft has no expression yet.
ALTER TABLE expression_draft_image DROP COLUMN expression_id;

CREATE TABLE expression_report (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT uuidv7(),
  expression_id uuid NOT NULL,
  reporter_id uuid NOT NULL,
  reason text NOT NULL CHECK (reason IN ('copyright','face','other')),
  detail text CHECK (char_length(detail) <= 500),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,id),
  UNIQUE (workspace_id,expression_id,reporter_id),
  FOREIGN KEY (workspace_id,expression_id) REFERENCES expression(workspace_id,id),
  FOREIGN KEY (workspace_id,reporter_id) REFERENCES member(workspace_id,id)
);

CREATE FUNCTION expression_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- A tenant deletion may cascade; a living tenant's names never disappear.
    IF EXISTS (SELECT 1 FROM workspace WHERE id=OLD.workspace_id) THEN
      RAISE EXCEPTION 'expression name tombstones are permanent' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  ELSIF TG_TABLE_NAME IN ('expression_image','expression_draft_image') THEN
    RAISE EXCEPTION 'expression pixels are immutable' USING ERRCODE = '23514';
  ELSIF TG_TABLE_NAME = 'expression' THEN
    IF (to_jsonb(NEW) - ARRAY['display_name','tags','status','version','hidden_at','deleted_at']) IS DISTINCT FROM
       (to_jsonb(OLD) - ARRAY['display_name','tags','status','version','hidden_at','deleted_at']) OR
       (OLD.status = 'deleted' AND NEW.status <> 'deleted') OR
       (OLD.status = 'hidden' AND NEW.status = 'active') THEN
      RAISE EXCEPTION 'expression identity is immutable' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF (to_jsonb(NEW) - ARRAY['revision','state','code','submitted_by','submitted_revision','submitted_sha256','receipt']) IS DISTINCT FROM
       (to_jsonb(OLD) - ARRAY['revision','state','code','submitted_by','submitted_revision','submitted_sha256','receipt']) OR
       OLD.state = 'activated' THEN
      RAISE EXCEPTION 'draft identity and receipt are immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER expression_identity BEFORE UPDATE ON expression FOR EACH ROW EXECUTE FUNCTION expression_immutable();
CREATE TRIGGER expression_name_tombstone BEFORE DELETE ON expression FOR EACH ROW EXECUTE FUNCTION expression_immutable();
CREATE TRIGGER expression_draft_identity BEFORE UPDATE ON expression_draft FOR EACH ROW EXECUTE FUNCTION expression_immutable();
CREATE TRIGGER expression_image_immutable BEFORE UPDATE ON expression_image FOR EACH ROW EXECUTE FUNCTION expression_immutable();
CREATE TRIGGER expression_draft_image_immutable BEFORE UPDATE ON expression_draft_image FOR EACH ROW EXECUTE FUNCTION expression_immutable();

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['expression_catalog','expression','expression_image','expression_draft','expression_draft_image','expression_report'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY ws_isolation ON %I USING (workspace_id = current_setting(''app.workspace_id'',true)::uuid) WITH CHECK (workspace_id = current_setting(''app.workspace_id'',true)::uuid)',t);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_app') THEN
      EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO momo_app',t);
    END IF;
  END LOOP;
END $$;

-- Discovery follows the existing notifier polling exception; reclamation
-- itself always uses momo_app with a workspace-bound NOBYPASSRLS transaction.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_notifier') THEN
    GRANT SELECT (workspace_id,state,expires_at) ON expression_draft TO momo_notifier;
  END IF;
END $$;

-- RESTRICTIVE: ws_isolation cannot OR away the administrator-only SELECT.
CREATE POLICY expression_report_admin ON expression_report AS RESTRICTIVE FOR SELECT USING (
  EXISTS (SELECT 1 FROM workspace_membership wm JOIN member m ON (m.workspace_id,m.id) = (wm.workspace_id,wm.member_id)
    WHERE wm.workspace_id = expression_report.workspace_id
      AND wm.member_id = nullif(current_setting('app.expression_member_id',true),'')::uuid
      AND wm.role IN ('owner','admin') AND m.kind = 'human' AND m.status = 'active' AND m.deleted_at IS NULL)
);
CREATE POLICY expression_report_submitter ON expression_report AS RESTRICTIVE FOR INSERT WITH CHECK (
  reporter_id = nullif(current_setting('app.expression_member_id',true),'')::uuid
  AND EXISTS (SELECT 1 FROM workspace_membership wm JOIN member m ON (m.workspace_id,m.id) = (wm.workspace_id,wm.member_id)
    WHERE wm.workspace_id = expression_report.workspace_id AND wm.member_id = expression_report.reporter_id
      AND m.kind = 'human' AND m.status = 'active' AND m.deleted_at IS NULL)
);
CREATE POLICY expression_report_no_update ON expression_report AS RESTRICTIVE FOR UPDATE USING (false);
CREATE POLICY expression_report_no_delete ON expression_report AS RESTRICTIVE FOR DELETE USING (false);

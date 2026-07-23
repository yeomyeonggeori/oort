-- MOMO-571 (ADR-0117 §D1-A) operator workspace creation.
--
-- The migrate image invokes this file only through its `workspace-create`
-- command. Every value (workspace name/slug, initial owner email/password)
-- arrives through the process environment and psql \getenv so the password is
-- never placed in argv, SQL source, or command output (ADR-0004).
--
-- One transaction provisions the full minimal workspace:
--   workspace row + owner member(kind=human) + human profile
--   + workspace_membership(role=owner) + #general channel + channel_seq
--   + owner channel membership(role=owner) + workspace.created audit row.
--
-- slug re-run policy: EXPLICIT REFUSAL. A duplicate slug raises and aborts the
-- transaction (no partial workspace). Re-provisioning is deliberately not
-- idempotent because a second run with a fresh owner password would silently
-- mint a second owner identity; operators must pick a distinct slug or reuse
-- the existing workspace via `migrate set-owner`.

\getenv ws_name MOMO_OPS_WORKSPACE_NAME
\getenv ws_slug MOMO_OPS_WORKSPACE_SLUG
\getenv owner_email MOMO_OPS_OWNER_EMAIL
\getenv owner_password MOMO_OPS_OWNER_PASSWORD

BEGIN;

CREATE TEMP TABLE momo_ops_workspace_input (
  name     text NOT NULL,
  slug     text NOT NULL,
  email    text NOT NULL,
  password text NOT NULL
) ON COMMIT DROP;

INSERT INTO momo_ops_workspace_input (name, slug, email, password)
VALUES (
  btrim(:'ws_name'),
  lower(btrim(:'ws_slug')),
  lower(btrim(:'owner_email')),
  :'owner_password'
);

DO $$
DECLARE
  input          momo_ops_workspace_input%ROWTYPE;
  ws_id          uuid := uuidv7();
  owner_id       uuid := uuidv7();
  channel_id     uuid := uuidv7();
  owner_handle   text;
  owner_name     text;
BEGIN
  SELECT * INTO STRICT input FROM momo_ops_workspace_input;

  -- ---- validation -----------------------------------------------------------
  IF char_length(input.name) < 1 OR char_length(input.name) > 200 THEN
    RAISE EXCEPTION 'MOMO_OPS_WORKSPACE_NAME must be 1..200 characters';
  END IF;
  IF input.slug !~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$' THEN
    RAISE EXCEPTION 'MOMO_OPS_WORKSPACE_SLUG must be 1..63 chars of lowercase letters, digits, or hyphens (no leading/trailing hyphen)';
  END IF;
  IF char_length(input.email) < 3
     OR char_length(input.email) > 320
     OR strpos(input.email, '@') = 0
     OR input.email LIKE '@%'
     OR input.email LIKE '%@' THEN
    RAISE EXCEPTION 'MOMO_OPS_OWNER_EMAIL is invalid';
  END IF;
  IF input.password = '' THEN
    RAISE EXCEPTION 'MOMO_OPS_OWNER_PASSWORD must not be empty';
  END IF;

  -- Derive a safe owner handle/display name from the email local part.
  owner_name := split_part(input.email, '@', 1);
  owner_handle := btrim(regexp_replace(lower(owner_name), '[^a-z0-9]+', '-', 'g'), '-');
  IF owner_handle = '' THEN
    owner_handle := 'owner';
  END IF;
  IF owner_name = '' THEN
    owner_name := 'owner';
  END IF;

  -- Establish the tenant RLS context before any workspace-scoped INSERT. The
  -- workspace table is itself RLS FORCE (migration 009, USING id = app.workspace_id),
  -- so a cross-tenant slug probe would see nothing; the workspace_slug_uniq
  -- constraint is the authoritative, race-free duplicate detector.
  PERFORM set_config('app.workspace_id', ws_id::text, true);

  -- ---- workspace ------------------------------------------------------------
  -- slug re-run policy: EXPLICIT REFUSAL (no partial workspace).
  BEGIN
    INSERT INTO workspace (id, slug, name)
    VALUES (ws_id, input.slug, input.name);
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'workspace slug already exists: %', input.slug;
  END;

  -- ---- owner member + human profile -----------------------------------------
  INSERT INTO member (id, workspace_id, kind, status, display_name, handle)
  VALUES (owner_id, ws_id, 'human', 'active', owner_name, owner_handle);

  INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash)
  VALUES (owner_id, ws_id, input.email, true, momo_password_hash(input.password));

  -- ---- workspace-level owner role (ADR-0128) --------------------------------
  INSERT INTO workspace_membership (workspace_id, member_id, role)
  VALUES (ws_id, owner_id, 'owner');

  -- ---- default #general channel + gapless seq counter -----------------------
  INSERT INTO channel (id, workspace_id, kind, name, topic, created_by)
  VALUES (channel_id, ws_id, 'public', 'general', 'Team general channel', owner_id);

  INSERT INTO channel_seq (channel_id, workspace_id, last_seq)
  VALUES (channel_id, ws_id, 0);

  -- ---- owner channel membership ---------------------------------------------
  INSERT INTO membership (workspace_id, channel_id, member_id, role)
  VALUES (ws_id, channel_id, owner_id, 'owner');

  -- ---- audit trail ----------------------------------------------------------
  INSERT INTO audit_log (
    workspace_id, actor_member_id, action, target_type, target_id, detail
  )
  VALUES (
    ws_id,
    owner_id,
    'workspace.created',
    'workspace',
    ws_id,
    jsonb_build_object(
      'slug', input.slug,
      'default_channel', 'general',
      'source', 'momo-ops'
    )
  );

  -- The workspace id is the operator's handle for follow-up ops (invite-create,
  -- member list). Emit it on a NOTICE channel; no secret is present here.
  RAISE NOTICE 'workspace created: id=% slug=%', ws_id, input.slug;
END
$$;

COMMIT;

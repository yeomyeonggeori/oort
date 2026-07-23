-- MOMO-560 operator invite creation.
-- The raw bearer code and all selectors arrive through psql \getenv. The code
-- is hashed before persistence and is never selected or emitted by this SQL.
\getenv workspace_id MOMO_OPS_WORKSPACE_ID
\getenv created_by MOMO_OPS_CREATED_BY
\getenv invite_role MOMO_OPS_INVITE_ROLE
\getenv invite_max_uses MOMO_OPS_INVITE_MAX_USES
\getenv invite_expires_days MOMO_OPS_INVITE_EXPIRES_DAYS
\getenv invite_code MOMO_OPS_INVITE_CODE

BEGIN;
SET LOCAL app.workspace_id = :'workspace_id';

CREATE TEMP TABLE momo_ops_invite_input (
  workspace_id uuid NOT NULL,
  created_by uuid,
  invite_role membership_role NOT NULL,
  max_uses integer NOT NULL,
  expires_days integer NOT NULL,
  raw_code text NOT NULL
) ON COMMIT DROP;

INSERT INTO momo_ops_invite_input
VALUES (
  :'workspace_id'::uuid,
  NULLIF(:'created_by', '')::uuid,
  :'invite_role'::membership_role,
  :'invite_max_uses'::integer,
  :'invite_expires_days'::integer,
  :'invite_code'
);

DO $$
DECLARE
  input momo_ops_invite_input%ROWTYPE;
  actor_id uuid;
  invite_id uuid;
BEGIN
  SELECT * INTO STRICT input FROM momo_ops_invite_input;

  IF input.invite_role = 'owner' THEN
    RAISE EXCEPTION 'operator invite role must not be owner';
  END IF;
  IF input.max_uses NOT BETWEEN 1 AND 10000 THEN
    RAISE EXCEPTION 'operator invite max uses is outside 1..10000';
  END IF;
  IF input.expires_days NOT BETWEEN 1 AND 365 THEN
    RAISE EXCEPTION 'operator invite expiry is outside 1..365 days';
  END IF;
  IF octet_length(input.raw_code) < 32 THEN
    RAISE EXCEPTION 'operator invite code has insufficient entropy';
  END IF;

  IF input.created_by IS NULL THEN
    SELECT wm.member_id
      INTO actor_id
      FROM workspace_membership wm
      JOIN member m
        ON m.workspace_id = wm.workspace_id
       AND m.id = wm.member_id
     WHERE wm.workspace_id = input.workspace_id
       AND wm.role = 'owner'
       AND m.kind = 'human'
       AND m.status = 'active'
       AND m.deleted_at IS NULL
     ORDER BY wm.joined_at, wm.member_id
     LIMIT 1;
  ELSE
    SELECT wm.member_id
      INTO actor_id
      FROM workspace_membership wm
      JOIN member m
        ON m.workspace_id = wm.workspace_id
       AND m.id = wm.member_id
     WHERE wm.workspace_id = input.workspace_id
       AND wm.member_id = input.created_by
       AND wm.role IN ('owner', 'admin')
       AND m.kind = 'human'
       AND m.status = 'active'
       AND m.deleted_at IS NULL;
  END IF;

  IF actor_id IS NULL THEN
    RAISE EXCEPTION 'workspace has no eligible active human owner/admin invite actor';
  END IF;

  INSERT INTO invite_code (
    workspace_id, code_hash, code_preview, role, max_uses, expires_at,
    created_by, metadata
  )
  VALUES (
    input.workspace_id,
    momo_invite_code_hash(input.raw_code),
    right(input.raw_code, 6),
    input.invite_role,
    input.max_uses,
    now() + make_interval(days => input.expires_days),
    actor_id,
    jsonb_build_object('source', 'momo-ops')
  )
  RETURNING id INTO invite_id;

  INSERT INTO audit_log (
    workspace_id, actor_member_id, action, target_type, target_id, detail
  )
  VALUES (
    input.workspace_id,
    actor_id,
    'invite.created',
    'invite_code',
    invite_id,
    jsonb_build_object(
      'role', input.invite_role::text,
      'max_uses', input.max_uses,
      'source', 'momo-ops'
    )
  );
END
$$;

COMMIT;

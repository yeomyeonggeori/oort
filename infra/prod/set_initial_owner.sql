-- MOMO-561: one-shot bootstrap owner credential takeover.
--
-- The migrate image invokes this file only through its `set-owner` command.
-- Both values arrive through the process environment and psql \getenv so the
-- password is never placed in argv, SQL source, or command output.

\getenv owner_email MOMO_INITIAL_OWNER_EMAIL
\getenv owner_password MOMO_INITIAL_OWNER_PASSWORD

BEGIN;
SET LOCAL app.workspace_id = '00000000-0000-7000-8000-000000000001';

CREATE TEMP TABLE momo_initial_owner_input (
  email text NOT NULL,
  password text NOT NULL
) ON COMMIT DROP;

INSERT INTO momo_initial_owner_input (email, password)
VALUES (lower(btrim(:'owner_email')), :'owner_password');

DO $$
DECLARE
  owner_email text;
  owner_password text;
  updated_rows integer;
BEGIN
  SELECT email, password
    INTO owner_email, owner_password
    FROM momo_initial_owner_input;

  IF char_length(owner_email) < 3
     OR char_length(owner_email) > 320
     OR strpos(owner_email, '@') = 0
     OR owner_email LIKE '@%'
     OR owner_email LIKE '%@' THEN
    RAISE EXCEPTION 'MOMO_INITIAL_OWNER_EMAIL is invalid';
  END IF;
  IF owner_password = '' THEN
    RAISE EXCEPTION 'MOMO_INITIAL_OWNER_PASSWORD must not be empty';
  END IF;

  UPDATE human h
     SET email = owner_email,
         email_verified = true,
         password_hash = momo_password_hash(owner_password)
    FROM member m
    JOIN workspace_membership wm
      ON wm.workspace_id = m.workspace_id
     AND wm.member_id = m.id
     AND wm.role = 'owner'
   WHERE h.member_id = m.id
     AND h.workspace_id = m.workspace_id
     AND h.member_id = '00000000-0000-7000-8000-000000000101'
     AND h.workspace_id = '00000000-0000-7000-8000-000000000001'
     AND m.kind = 'human'
     AND m.status = 'active'
     AND m.deleted_at IS NULL;

  GET DIAGNOSTICS updated_rows = ROW_COUNT;
  IF updated_rows <> 1 THEN
    RAISE EXCEPTION 'bootstrap owner is absent, inactive, or no longer an owner';
  END IF;

  -- A deliberate re-run is a credential rotation. Existing sessions must not
  -- survive a password reset performed at the database-owner boundary.
  UPDATE token
     SET revoked_at = COALESCE(revoked_at, now())
   WHERE workspace_id = '00000000-0000-7000-8000-000000000001'
     AND actor_member_id = '00000000-0000-7000-8000-000000000101'
     AND revoked_at IS NULL;
END
$$;

COMMIT;

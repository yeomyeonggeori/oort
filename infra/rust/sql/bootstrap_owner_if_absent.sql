-- #1227: first-boot owner bootstrap — the ONLY-IF-ABSENT twin of
-- `set_initial_owner.sql`.
--
-- Why two files. Migration 012 locks the seeded owner's public `dev-password`
-- (fail-closed, and correct), which leaves a freshly migrated database with a
-- healthy API nobody can log into. `set_initial_owner.sql` is the operator's
-- deliberate *rotation*: it always overwrites and always revokes live sessions.
-- That semantic is wrong for something the `migrate` service runs on every
-- `up -d` — a restart must never reset a password the owner has since changed,
-- and must never sign every device out. So this file writes exactly once, when
-- there is no usable password to preserve, and is a silent no-op forever after.
--
-- The migrate binary invokes it only from its `migrate` command, and only when
-- both MOMO_INITIAL_OWNER_EMAIL and MOMO_INITIAL_OWNER_PASSWORD carry a value.
-- Absent env = no invocation = migration 012's lock stands (fail-closed).
--
-- Both values arrive through the process environment and psql \getenv, so the
-- password is never placed in argv, SQL source, or command output (ADR-0004).

\getenv owner_email MOMO_INITIAL_OWNER_EMAIL
\getenv owner_password MOMO_INITIAL_OWNER_PASSWORD

BEGIN;
SET LOCAL app.workspace_id = '00000000-0000-7000-8000-000000000001';

CREATE TEMP TABLE momo_bootstrap_owner_input (
  email text NOT NULL,
  password text NOT NULL
) ON COMMIT DROP;

INSERT INTO momo_bootstrap_owner_input (email, password)
VALUES (lower(btrim(:'owner_email')), :'owner_password');

DO $$
DECLARE
  owner_email text;
  owner_password text;
  updated_rows integer;
  adoptable_rows integer;
BEGIN
  SELECT email, password
    INTO owner_email, owner_password
    FROM momo_bootstrap_owner_input;

  -- Same input contract as set_initial_owner.sql. A malformed value is a hard
  -- error even here: the operator typed it into an env file on purpose, and
  -- silently ignoring it would leave them locked out with a green boot log.
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

  -- The idempotency guard. `password_hash IS NULL OR = ''` is precisely the
  -- state migration 012 leaves behind (and the state migration 005 repaired
  -- for pre-MOMO-217 rows), so "absent" is a fact about this database rather
  -- than a marker this file has to write and later trust.
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
     AND m.deleted_at IS NULL
     AND (h.password_hash IS NULL OR h.password_hash = '');

  GET DIAGNOSTICS updated_rows = ROW_COUNT;
  IF updated_rows = 1 THEN
    -- No token revocation: there cannot be a live session for an account that
    -- had no usable password, and revoking here would make a routine restart
    -- destructive the moment the guard above ever regressed.
    RAISE NOTICE 'MOMO_BOOTSTRAP_OWNER=created bootstrap owner password set from the environment';
    RETURN;
  END IF;

  -- Nothing was written. Distinguish the two reasons, because one is the
  -- steady state and the other means this database has no owner to adopt.
  SELECT count(*)
    INTO adoptable_rows
    FROM human h
    JOIN member m
      ON m.id = h.member_id
     AND m.workspace_id = h.workspace_id
    JOIN workspace_membership wm
      ON wm.workspace_id = m.workspace_id
     AND wm.member_id = m.id
     AND wm.role = 'owner'
   WHERE h.member_id = '00000000-0000-7000-8000-000000000101'
     AND h.workspace_id = '00000000-0000-7000-8000-000000000001'
     AND m.kind = 'human'
     AND m.status = 'active'
     AND m.deleted_at IS NULL;

  IF adoptable_rows = 1 THEN
    RAISE NOTICE 'MOMO_BOOTSTRAP_OWNER=skipped bootstrap owner already has a password (rotate with: migrate set-owner)';
  ELSE
    -- Deliberately NOT an exception. This file runs on every `up -d`; if an
    -- operator deactivates or removes the seeded owner, raising here would
    -- turn every subsequent restart into a stack-wide outage. The explicit
    -- `migrate set-owner` command keeps its hard failure for the same case,
    -- because that one is a human asking for a specific write.
    RAISE NOTICE 'MOMO_BOOTSTRAP_OWNER=absent no active bootstrap owner to adopt; MOMO_INITIAL_OWNER_* had no effect';
  END IF;
END
$$;

COMMIT;

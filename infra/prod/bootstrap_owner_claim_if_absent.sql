-- #1651 / ADR-0166: first-boot owner claim — the opt-in twin of
-- `bootstrap_owner_if_absent.sql`.
--
-- momo-migrate generates the raw token (OS CSPRNG, 32 bytes, base64url) and
-- passes it through the process environment. This file hashes it inside
-- Postgres and never writes or echos the plaintext (ADR-0004 / ADR-0166 D1).
-- The binary prints `/claim/<token>` once after this file reports stored.

\getenv owner_email MOMO_INITIAL_OWNER_EMAIL
\getenv claim_token MOMO_BOOTSTRAP_CLAIM_TOKEN
\getenv ttl_seconds MOMO_OWNER_CLAIM_TTL_SECONDS

BEGIN;
SET LOCAL app.workspace_id = '00000000-0000-7000-8000-000000000001';

CREATE TEMP TABLE momo_bootstrap_claim_input (
  email text NOT NULL,
  token text NOT NULL,
  ttl_seconds bigint NOT NULL
) ON COMMIT DROP;

INSERT INTO momo_bootstrap_claim_input (email, token, ttl_seconds)
VALUES (
  lower(btrim(:'owner_email')),
  :'claim_token',
  :'ttl_seconds'::bigint
);

DO $$
DECLARE
  owner_email text;
  claim_token text;
  ttl_seconds bigint;
  updated_rows integer;
BEGIN
  -- Qualify every selected column. PL/pgSQL DECLARE names that match a
  -- column (`ttl_seconds`) make an unqualified SELECT INTO ambiguous (#1673).
  SELECT i.email, i.token, i.ttl_seconds
    INTO owner_email, claim_token, ttl_seconds
    FROM momo_bootstrap_claim_input i;

  IF char_length(owner_email) < 3
     OR char_length(owner_email) > 320
     OR strpos(owner_email, '@') = 0
     OR owner_email LIKE '@%'
     OR owner_email LIKE '%@' THEN
    RAISE EXCEPTION 'MOMO_INITIAL_OWNER_EMAIL is invalid';
  END IF;
  IF claim_token IS NULL OR claim_token = '' THEN
    RAISE EXCEPTION 'MOMO_BOOTSTRAP_CLAIM_TOKEN must not be empty';
  END IF;
  IF ttl_seconds IS NULL OR ttl_seconds < 1 THEN
    RAISE EXCEPTION 'MOMO_OWNER_CLAIM_TTL_SECONDS must be a positive integer';
  END IF;

  -- Adopt the seeded owner only while it still has no usable password.
  -- A later `up -d` must not rotate a password the owner already set.
  UPDATE human h
     SET email = owner_email,
         email_verified = true
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
  IF updated_rows <> 1 THEN
    RAISE EXCEPTION 'MOMO_BOOTSTRAP_CLAIM=absent no claim-pending owner to adopt';
  END IF;

  -- Drop expired unconsumed rows for this owner so a restart after TTL can
  -- issue a replacement. Live unconsumed rows are not this file's job:
  -- migrate refuses to generate a token unless the plan said `issue`.
  DELETE FROM credential_claim
   WHERE workspace_id = '00000000-0000-7000-8000-000000000001'
     AND member_id = '00000000-0000-7000-8000-000000000101'
     AND kind = 'owner_bootstrap'
     AND consumed_at IS NULL
     AND expires_at <= now();

  INSERT INTO credential_claim (workspace_id, member_id, token_hash, expires_at, kind)
  VALUES (
    '00000000-0000-7000-8000-000000000001',
    '00000000-0000-7000-8000-000000000101',
    digest(claim_token, 'sha256'),
    now() + (ttl_seconds * interval '1 second'),
    'owner_bootstrap'
  );

  RAISE NOTICE 'MOMO_BOOTSTRAP_CLAIM=created';
END
$$;

COMMIT;

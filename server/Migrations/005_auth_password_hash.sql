-- =============================================================================
-- 005_auth_password_hash.sql — pgcrypto password verification v0
--
-- Adds DB-owned password hash/verify helpers and backfills seeded/dev fixture
-- humans to the deterministic dev password used by local runtime gates.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION momo_password_hash(raw_password text)
RETURNS text
LANGUAGE sql
VOLATILE
STRICT
AS $$
  SELECT crypt(raw_password, gen_salt('bf'));
$$;

CREATE OR REPLACE FUNCTION momo_password_verify(raw_password text, stored_hash text)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
    WHEN raw_password IS NULL OR raw_password = '' THEN false
    WHEN stored_hash IS NULL OR stored_hash = '' THEN false
    WHEN stored_hash !~ '^\$2[abxy]?\$[0-9]{2}\$[./A-Za-z0-9]{53}$' THEN false
    ELSE crypt(raw_password, stored_hash) = stored_hash
  END;
$$;

SET LOCAL row_security = off;

UPDATE human
   SET password_hash = momo_password_hash('dev-password')
 WHERE password_hash IS NULL
    OR password_hash = ''
    OR password_hash = 'dev-password-stub';

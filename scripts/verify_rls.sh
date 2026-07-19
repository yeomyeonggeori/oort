#!/usr/bin/env sh
# =============================================================================
# scripts/verify_rls.sh — MOMO-003 runtime RLS gate
#
# Verifies tenant isolation against Docker PostgreSQL with non-superuser app
# credentials plus explicit BYPASSRLS relay/worker and read-only platform roles. The script is intended
# to run after `make up && make migrate`.
# =============================================================================
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)

ENV_FILE=${ENV_FILE:-}
if [ "$ENV_FILE" = "" ]; then
  for candidate in "$REPO_ROOT/.env.worktree" "$REPO_ROOT/.env" "$REPO_ROOT/infra/.env.example"; do
    if [ -f "$candidate" ]; then
      ENV_FILE=$candidate
      break
    fi
  done
fi

if [ "$ENV_FILE" != "" ] && [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  set -a; . "$ENV_FILE"; set +a
fi

if command -v psql >/dev/null 2>&1; then
  PSQL_BIN=$(command -v psql)
elif [ -x /opt/homebrew/opt/libpq/bin/psql ]; then
  PSQL_BIN=/opt/homebrew/opt/libpq/bin/psql
elif [ -x /usr/local/opt/libpq/bin/psql ]; then
  PSQL_BIN=/usr/local/opt/libpq/bin/psql
else
  echo "[rls] psql not found; install PostgreSQL client/libpq and retry." >&2
  exit 1
fi

PSQL_FLAGS="-v ON_ERROR_STOP=1 --no-psqlrc"

psql_run() {
  if [ "${DATABASE_URL:-}" != "" ]; then
    "$PSQL_BIN" "$DATABASE_URL" $PSQL_FLAGS "$@"
  else
    "$PSQL_BIN" $PSQL_FLAGS "$@"
  fi
}

echo "[rls] using env file: ${ENV_FILE:-<none>}"
echo "[rls] preparing runtime roles and two-workspace fixture"

psql_run <<'SQL'
\echo [rls] create app/relay/worker/platform runtime roles
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_app') THEN
    CREATE ROLE momo_app LOGIN PASSWORD 'momo_app_dev_pw';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_relay') THEN
    CREATE ROLE momo_relay LOGIN PASSWORD 'momo_relay_dev_pw';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_worker') THEN
    CREATE ROLE momo_worker LOGIN PASSWORD 'momo_worker_dev_pw';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momo_platform_admin') THEN
    CREATE ROLE momo_platform_admin LOGIN PASSWORD 'momo_platform_admin_dev_pw';
  END IF;
END $$;

ALTER ROLE momo_app
  WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'momo_app_dev_pw';
ALTER ROLE momo_relay
  WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS PASSWORD 'momo_relay_dev_pw';
ALTER ROLE momo_worker
  WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS PASSWORD 'momo_worker_dev_pw';
ALTER ROLE momo_platform_admin
  WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS PASSWORD 'momo_platform_admin_dev_pw';

DO $$
BEGIN
  EXECUTE format(
    'GRANT CONNECT ON DATABASE %I TO momo_app, momo_relay, momo_worker, momo_platform_admin',
    current_database()
  );
END $$;
GRANT USAGE ON SCHEMA public TO momo_app, momo_relay, momo_worker, momo_platform_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public
  TO momo_app, momo_relay, momo_worker;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public
  TO momo_app, momo_relay, momo_worker;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public
  TO momo_app, momo_relay, momo_worker;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM momo_platform_admin;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO momo_platform_admin;
REVOKE ALL ON SCHEMA momo_join_private
  FROM PUBLIC, momo_relay, momo_worker, momo_platform_admin;
REVOKE ALL ON FUNCTION momo_join_private.invite_workspace_id(text)
  FROM PUBLIC, momo_relay, momo_worker, momo_platform_admin;
GRANT USAGE ON SCHEMA momo_join_private TO momo_app;
GRANT EXECUTE ON FUNCTION momo_join_private.invite_workspace_id(text) TO momo_app;

\echo [rls] assert role contract
DO $$
BEGIN
  IF (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = 'momo_app') THEN
    RAISE EXCEPTION 'momo_app must not be superuser or BYPASSRLS';
  END IF;
  IF NOT (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'momo_relay') THEN
    RAISE EXCEPTION 'momo_relay must be BYPASSRLS';
  END IF;
  IF NOT (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'momo_worker') THEN
    RAISE EXCEPTION 'momo_worker must be BYPASSRLS';
  END IF;
  IF NOT (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'momo_platform_admin') THEN
    RAISE EXCEPTION 'momo_platform_admin must be BYPASSRLS';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pg_roles
     WHERE rolname IN ('momo_app', 'momo_relay', 'momo_worker', 'momo_platform_admin')
       AND rolsuper
  ) THEN
    RAISE EXCEPTION 'runtime roles must not be superusers';
  END IF;
  IF has_table_privilege('momo_platform_admin', 'workspace', 'INSERT')
     OR has_table_privilege('momo_platform_admin', 'workspace', 'UPDATE')
     OR has_table_privilege('momo_platform_admin', 'workspace', 'DELETE') THEN
    RAISE EXCEPTION 'momo_platform_admin workspace access must be SELECT-only';
  END IF;
END $$;

\echo [rls] assert FORCE RLS is enabled on tenant-critical tables
DO $$
DECLARE missing text;
BEGIN
  SELECT string_agg(v.relname, ', ' ORDER BY v.relname)
    INTO missing
    FROM (VALUES ('workspace'), ('member'), ('channel'), ('membership'), ('message'),
                 ('invite_code'), ('work_session')) AS v(relname)
    LEFT JOIN pg_class c ON c.relname = v.relname
   WHERE c.oid IS NULL
      OR NOT c.relrowsecurity
      OR NOT c.relforcerowsecurity;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'RLS/FORCE missing on: %', missing;
  END IF;
END $$;

\echo [rls] seed workspace A/B fixture as admin
BEGIN;
SET LOCAL row_security = off;

INSERT INTO workspace (id, slug, name)
VALUES
  ('10000000-0000-7000-8000-000000000001', 'momo-rls-a', 'MOMO RLS Workspace A'),
  ('20000000-0000-7000-8000-000000000001', 'momo-rls-b', 'MOMO RLS Workspace B')
ON CONFLICT (id) DO UPDATE
SET slug = EXCLUDED.slug,
    name = EXCLUDED.name,
    updated_at = now();

INSERT INTO member (id, workspace_id, kind, status, display_name, handle)
VALUES
  ('10000000-0000-7000-8000-000000000101', '10000000-0000-7000-8000-000000000001',
   'human', 'active', 'RLS Human A', 'rls-a-human'),
  ('10000000-0000-7000-8000-000000000102', '10000000-0000-7000-8000-000000000001',
   'human', 'active', 'RLS Nonmember A', 'rls-a-nonmember'),
  ('20000000-0000-7000-8000-000000000101', '20000000-0000-7000-8000-000000000001',
   'human', 'active', 'RLS Human B', 'rls-b-human')
ON CONFLICT (id) DO UPDATE
SET status = EXCLUDED.status,
    display_name = EXCLUDED.display_name,
    handle = EXCLUDED.handle,
    updated_at = now();

INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash, tz)
VALUES
  ('10000000-0000-7000-8000-000000000101', '10000000-0000-7000-8000-000000000001',
   'rls-a@momo.local', true, momo_password_hash('dev-password'), 'Asia/Seoul'),
  ('10000000-0000-7000-8000-000000000102', '10000000-0000-7000-8000-000000000001',
   'rls-a-nonmember@momo.local', true, momo_password_hash('dev-password'), 'Asia/Seoul'),
  ('20000000-0000-7000-8000-000000000101', '20000000-0000-7000-8000-000000000001',
   'rls-b@momo.local', true, momo_password_hash('dev-password'), 'Asia/Seoul')
ON CONFLICT (member_id) DO UPDATE
SET email = EXCLUDED.email,
    email_verified = EXCLUDED.email_verified,
    password_hash = EXCLUDED.password_hash,
    tz = EXCLUDED.tz;

INSERT INTO channel (id, workspace_id, kind, name, topic, created_by)
VALUES
  ('10000000-0000-7000-8000-000000000201', '10000000-0000-7000-8000-000000000001',
   'public', 'rls-general-a', 'RLS fixture A', '10000000-0000-7000-8000-000000000101'),
  ('20000000-0000-7000-8000-000000000201', '20000000-0000-7000-8000-000000000001',
   'public', 'rls-general-b', 'RLS fixture B', '20000000-0000-7000-8000-000000000101')
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name,
    topic = EXCLUDED.topic,
    updated_at = now();

INSERT INTO channel_seq (channel_id, workspace_id, last_seq)
VALUES
  ('10000000-0000-7000-8000-000000000201', '10000000-0000-7000-8000-000000000001', 1),
  ('20000000-0000-7000-8000-000000000201', '20000000-0000-7000-8000-000000000001', 1)
ON CONFLICT (channel_id) DO UPDATE
SET last_seq = GREATEST(channel_seq.last_seq, EXCLUDED.last_seq);

INSERT INTO membership (id, workspace_id, channel_id, member_id, role)
VALUES
  ('10000000-0000-7000-8000-000000000301', '10000000-0000-7000-8000-000000000001',
   '10000000-0000-7000-8000-000000000201', '10000000-0000-7000-8000-000000000101', 'owner'),
  ('20000000-0000-7000-8000-000000000301', '20000000-0000-7000-8000-000000000001',
   '20000000-0000-7000-8000-000000000201', '20000000-0000-7000-8000-000000000101', 'owner')
ON CONFLICT (id) DO UPDATE
SET role = EXCLUDED.role,
    left_at = NULL;

INSERT INTO invite_code
  (id, workspace_id, code_hash, code_preview, role, max_uses, used_count, expires_at, created_by)
VALUES
  ('10000000-0000-7000-8000-000000000601', '10000000-0000-7000-8000-000000000001',
   momo_invite_code_hash('rls-a-invite-code'), 'odeA', 'member', 5, 0, now() + interval '1 day',
   '10000000-0000-7000-8000-000000000101'),
  ('20000000-0000-7000-8000-000000000601', '20000000-0000-7000-8000-000000000001',
   momo_invite_code_hash('rls-b-invite-code'), 'odeB', 'member', 5, 0, now() + interval '1 day',
   '20000000-0000-7000-8000-000000000101')
ON CONFLICT (id) DO UPDATE
SET code_hash = EXCLUDED.code_hash,
    code_preview = EXCLUDED.code_preview,
    role = EXCLUDED.role,
    max_uses = EXCLUDED.max_uses,
    used_count = EXCLUDED.used_count,
    expires_at = EXCLUDED.expires_at,
    revoked_at = NULL,
    revoked_by = NULL,
    revocation_reason = NULL,
    updated_at = now();

INSERT INTO message
  (id, workspace_id, channel_id, seq, hlc_ts, hlc_count, author_member_id, type, body, client_msg_id)
VALUES
  ('10000000-0000-7000-8000-000000000401', '10000000-0000-7000-8000-000000000001',
   '10000000-0000-7000-8000-000000000201', 1, 1782360000000, 0,
   '10000000-0000-7000-8000-000000000101', 'text', 'workspace A fixture',
   '10000000-0000-7000-8000-000000000501'),
  ('20000000-0000-7000-8000-000000000401', '20000000-0000-7000-8000-000000000001',
   '20000000-0000-7000-8000-000000000201', 1, 1782360000000, 0,
   '20000000-0000-7000-8000-000000000101', 'text', 'workspace B fixture',
   '20000000-0000-7000-8000-000000000501')
ON CONFLICT (id) DO UPDATE
SET body = EXCLUDED.body,
    deleted_at = NULL;

COMMIT;

\echo [rls] app role without workspace context sees zero tenant rows
SET ROLE momo_app;
DO $$
DECLARE
  got int;
  resolved uuid;
BEGIN
  SELECT count(*) INTO got FROM workspace WHERE id IN (
    '10000000-0000-7000-8000-000000000001',
    '20000000-0000-7000-8000-000000000001'
  );
  IF got <> 0 THEN RAISE EXCEPTION 'workspace leaked without app.workspace_id: %', got; END IF;
  SELECT count(*) INTO got FROM member WHERE handle LIKE 'rls-%';
  IF got <> 0 THEN RAISE EXCEPTION 'member leaked without app.workspace_id: %', got; END IF;
  SELECT count(*) INTO got FROM channel WHERE name LIKE 'rls-%';
  IF got <> 0 THEN RAISE EXCEPTION 'channel leaked without app.workspace_id: %', got; END IF;
  SELECT count(*) INTO got FROM membership WHERE id IN (
    '10000000-0000-7000-8000-000000000301',
    '20000000-0000-7000-8000-000000000301'
  );
  IF got <> 0 THEN RAISE EXCEPTION 'membership leaked without app.workspace_id: %', got; END IF;
  SELECT count(*) INTO got FROM message WHERE id IN (
    '10000000-0000-7000-8000-000000000401',
    '20000000-0000-7000-8000-000000000401'
  );
  IF got <> 0 THEN RAISE EXCEPTION 'message leaked without app.workspace_id: %', got; END IF;
  SELECT count(*) INTO got FROM invite_code WHERE id IN (
    '10000000-0000-7000-8000-000000000601',
    '20000000-0000-7000-8000-000000000601'
  );
  IF got <> 0 THEN RAISE EXCEPTION 'invite_code leaked without app.workspace_id: %', got; END IF;

  SELECT momo_join_private.invite_workspace_id('rls-a-invite-code') INTO resolved;
  IF resolved IS DISTINCT FROM '10000000-0000-7000-8000-000000000001'::uuid THEN
    RAISE EXCEPTION 'exact invite lookup returned unexpected workspace: %', resolved;
  END IF;
  SELECT momo_join_private.invite_workspace_id('arbitrary-nonexistent-invite') INTO resolved;
  IF resolved IS NOT NULL THEN
    RAISE EXCEPTION 'nonexistent invite exposed a workspace id: %', resolved;
  END IF;
  SELECT count(*) INTO got FROM workspace;
  IF got <> 0 THEN RAISE EXCEPTION 'invite lookup widened workspace visibility: %', got; END IF;
END $$;
RESET ROLE;

\echo [rls] invite lookup is a fixed-path EXECUTE-only DB-owner primitive
DO $$
DECLARE
  function_owner text;
  function_owner_oid oid;
  app_oid oid;
  function_source text;
  is_security_definer boolean;
  function_config text[];
BEGIN
  SELECT owner.rolname, owner.oid, p.prosrc, p.prosecdef, p.proconfig
    INTO function_owner, function_owner_oid, function_source, is_security_definer, function_config
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_roles owner ON owner.oid = p.proowner
   WHERE n.nspname = 'momo_join_private'
     AND p.proname = 'invite_workspace_id'
     AND pg_get_function_identity_arguments(p.oid) = 'raw_code text';
  IF function_owner IS NULL OR function_owner IN ('momo_app', 'momo_relay', 'momo_worker', 'momo_platform_admin') THEN
    RAISE EXCEPTION 'invite lookup must be owned by the migration/database owner: %', function_owner;
  END IF;
  IF NOT is_security_definer THEN
    RAISE EXCEPTION 'invite lookup must be SECURITY DEFINER';
  END IF;
  IF function_config IS DISTINCT FROM ARRAY['search_path=pg_catalog']::text[] THEN
    RAISE EXCEPTION 'invite lookup search_path is not fixed: %', function_config;
  END IF;
  IF function_source ~* '(execute|format[[:space:]]*\()' THEN
    RAISE EXCEPTION 'invite lookup must use static SQL';
  END IF;
  SELECT oid INTO app_oid FROM pg_roles WHERE rolname = 'momo_app';
  IF EXISTS (
    SELECT 1
      FROM pg_proc p,
           aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
     WHERE p.oid = 'momo_join_private.invite_workspace_id(text)'::regprocedure
       AND acl.grantee = 0
       AND acl.privilege_type = 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'PUBLIC must not execute invite lookup';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pg_proc p,
           aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
     WHERE p.oid = 'momo_join_private.invite_workspace_id(text)'::regprocedure
       AND (
         acl.privilege_type <> 'EXECUTE'
         OR acl.grantee NOT IN (function_owner_oid, app_oid)
       )
  ) THEN
    RAISE EXCEPTION 'invite lookup ACL contains a non-allowlisted grant';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pg_namespace n,
           aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) acl
     WHERE n.nspname = 'momo_join_private'
       AND (
         acl.grantee NOT IN (n.nspowner, app_oid)
         OR (acl.grantee = app_oid AND acl.privilege_type <> 'USAGE')
       )
  ) THEN
    RAISE EXCEPTION 'private schema ACL contains a non-allowlisted grant';
  END IF;
  IF NOT has_schema_privilege('momo_app', 'momo_join_private', 'USAGE')
     OR NOT has_function_privilege('momo_app', 'momo_join_private.invite_workspace_id(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'momo_app must execute invite lookup';
  END IF;
  IF has_schema_privilege('momo_relay', 'momo_join_private', 'USAGE')
     OR has_schema_privilege('momo_worker', 'momo_join_private', 'USAGE')
     OR has_schema_privilege('momo_platform_admin', 'momo_join_private', 'USAGE')
     OR has_function_privilege('momo_relay', 'momo_join_private.invite_workspace_id(text)', 'EXECUTE')
     OR has_function_privilege('momo_worker', 'momo_join_private.invite_workspace_id(text)', 'EXECUTE')
     OR has_function_privilege('momo_platform_admin', 'momo_join_private.invite_workspace_id(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'invite lookup execution widened beyond momo_app';
  END IF;
END $$;

\echo [rls] broad public grants cannot make privileged invite lookup callable by bypass roles
SET ROLE momo_relay;
DO $$
BEGIN
  BEGIN
    PERFORM momo_join_private.invite_workspace_id('rls-a-invite-code');
    RAISE EXCEPTION 'momo_relay unexpectedly called private invite lookup';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END $$;
RESET ROLE;

SET ROLE momo_worker;
DO $$
BEGIN
  BEGIN
    PERFORM momo_join_private.invite_workspace_id('rls-a-invite-code');
    RAISE EXCEPTION 'momo_worker unexpectedly called private invite lookup';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END $$;
RESET ROLE;

SET ROLE momo_platform_admin;
DO $$
BEGIN
  BEGIN
    PERFORM momo_join_private.invite_workspace_id('rls-a-invite-code');
    RAISE EXCEPTION 'momo_platform_admin unexpectedly called private invite lookup';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END $$;
RESET ROLE;

\echo [rls] workspace A context cannot read workspace B rows and can use allowed membership
SET ROLE momo_app;
BEGIN;
SELECT set_config('app.workspace_id', '10000000-0000-7000-8000-000000000001', true);
DO $$
DECLARE got int;
BEGIN
  SELECT count(*) INTO got FROM workspace
   WHERE id = '10000000-0000-7000-8000-000000000001';
  IF got <> 1 THEN RAISE EXCEPTION 'workspace A root unavailable in exact context: %', got; END IF;
  SELECT count(*) INTO got FROM workspace
   WHERE id = '20000000-0000-7000-8000-000000000001';
  IF got <> 0 THEN RAISE EXCEPTION 'workspace B root leaked into A context: %', got; END IF;
  SELECT count(*) INTO got FROM member WHERE workspace_id = '20000000-0000-7000-8000-000000000001';
  IF got <> 0 THEN RAISE EXCEPTION 'workspace B member leaked into A context: %', got; END IF;
  SELECT count(*) INTO got FROM channel WHERE id = '20000000-0000-7000-8000-000000000201';
  IF got <> 0 THEN RAISE EXCEPTION 'workspace B channel leaked into A context: %', got; END IF;
  SELECT count(*) INTO got FROM membership WHERE id = '20000000-0000-7000-8000-000000000301';
  IF got <> 0 THEN RAISE EXCEPTION 'workspace B membership leaked into A context: %', got; END IF;
  SELECT count(*) INTO got FROM message WHERE id = '20000000-0000-7000-8000-000000000401';
  IF got <> 0 THEN RAISE EXCEPTION 'workspace B message leaked into A context: %', got; END IF;
  SELECT count(*) INTO got FROM invite_code WHERE id = '20000000-0000-7000-8000-000000000601';
  IF got <> 0 THEN RAISE EXCEPTION 'workspace B invite_code leaked into A context: %', got; END IF;

  SELECT count(*) INTO got
    FROM message m
    JOIN membership ms
      ON ms.channel_id = m.channel_id
     AND ms.member_id = '10000000-0000-7000-8000-000000000101'
     AND ms.left_at IS NULL
   WHERE m.id = '10000000-0000-7000-8000-000000000401';
  IF got <> 1 THEN RAISE EXCEPTION 'allowed membership read failed in A context: %', got; END IF;
END $$;

SAVEPOINT allowed_workspace_update;
DO $$
DECLARE got int;
BEGIN
  UPDATE workspace
     SET name = name
   WHERE id = '10000000-0000-7000-8000-000000000001';
  GET DIAGNOSTICS got = ROW_COUNT;
  IF got <> 1 THEN RAISE EXCEPTION 'exact-context workspace update denied: %', got; END IF;
  UPDATE workspace
     SET name = name
   WHERE id = '20000000-0000-7000-8000-000000000001';
  GET DIAGNOSTICS got = ROW_COUNT;
  IF got <> 0 THEN RAISE EXCEPTION 'cross-context workspace update reached rows: %', got; END IF;
END $$;
ROLLBACK TO SAVEPOINT allowed_workspace_update;

SAVEPOINT allowed_write;
INSERT INTO message
  (workspace_id, channel_id, seq, hlc_ts, hlc_count, author_member_id, type, body, client_msg_id)
SELECT
  '10000000-0000-7000-8000-000000000001',
  '10000000-0000-7000-8000-000000000201',
  COALESCE(max(seq), 0) + 1000,
  1782360000100,
  0,
  '10000000-0000-7000-8000-000000000101',
  'text',
  'allowed membership write probe',
  '10000000-0000-7000-8000-000000000599'
FROM message
WHERE channel_id = '10000000-0000-7000-8000-000000000201';
ROLLBACK TO SAVEPOINT allowed_write;
COMMIT;
RESET ROLE;

\echo [rls] workspace B context cannot read workspace A rows
SET ROLE momo_app;
BEGIN;
SELECT set_config('app.workspace_id', '20000000-0000-7000-8000-000000000001', true);
DO $$
DECLARE got int;
BEGIN
  SELECT count(*) INTO got FROM workspace
   WHERE id = '20000000-0000-7000-8000-000000000001';
  IF got <> 1 THEN RAISE EXCEPTION 'workspace B root unavailable in exact context: %', got; END IF;
  SELECT count(*) INTO got FROM workspace
   WHERE id = '10000000-0000-7000-8000-000000000001';
  IF got <> 0 THEN RAISE EXCEPTION 'workspace A root leaked into B context: %', got; END IF;
  SELECT count(*) INTO got FROM member WHERE workspace_id = '10000000-0000-7000-8000-000000000001';
  IF got <> 0 THEN RAISE EXCEPTION 'workspace A member leaked into B context: %', got; END IF;
  SELECT count(*) INTO got FROM channel WHERE id = '10000000-0000-7000-8000-000000000201';
  IF got <> 0 THEN RAISE EXCEPTION 'workspace A channel leaked into B context: %', got; END IF;
  SELECT count(*) INTO got FROM membership WHERE id = '10000000-0000-7000-8000-000000000301';
  IF got <> 0 THEN RAISE EXCEPTION 'workspace A membership leaked into B context: %', got; END IF;
  SELECT count(*) INTO got FROM message WHERE id = '10000000-0000-7000-8000-000000000401';
  IF got <> 0 THEN RAISE EXCEPTION 'workspace A message leaked into B context: %', got; END IF;
  SELECT count(*) INTO got FROM invite_code WHERE id = '10000000-0000-7000-8000-000000000601';
  IF got <> 0 THEN RAISE EXCEPTION 'workspace A invite_code leaked into B context: %', got; END IF;
END $$;
COMMIT;
RESET ROLE;

\echo [rls] platform-admin BYPASSRLS keeps cross-tenant workspace reads SELECT-only
SET ROLE momo_platform_admin;
DO $$
DECLARE got int;
BEGIN
  SELECT count(*) INTO got
    FROM workspace
   WHERE id IN (
     '10000000-0000-7000-8000-000000000001',
     '20000000-0000-7000-8000-000000000001'
   );
  IF got <> 2 THEN RAISE EXCEPTION 'platform admin did not see both workspace roots: %', got; END IF;
  IF has_table_privilege(current_user, 'workspace', 'INSERT')
     OR has_table_privilege(current_user, 'workspace', 'UPDATE')
     OR has_table_privilege(current_user, 'workspace', 'DELETE') THEN
    RAISE EXCEPTION 'platform admin workspace access is not read-only';
  END IF;
END $$;
RESET ROLE;

\echo [rls] relay/worker BYPASSRLS roles can poll all tenants without workspace context
SET ROLE momo_relay;
DO $$
DECLARE got int;
BEGIN
  SELECT count(DISTINCT workspace_id) INTO got
    FROM message
   WHERE id IN (
     '10000000-0000-7000-8000-000000000401',
     '20000000-0000-7000-8000-000000000401'
   );
  IF got <> 2 THEN RAISE EXCEPTION 'momo_relay did not see both tenants: %', got; END IF;
  SELECT count(DISTINCT workspace_id) INTO got
    FROM invite_code
   WHERE id IN (
     '10000000-0000-7000-8000-000000000601',
     '20000000-0000-7000-8000-000000000601'
   );
  IF got <> 2 THEN RAISE EXCEPTION 'momo_relay did not see both tenant invite_codes: %', got; END IF;
END $$;
RESET ROLE;

SET ROLE momo_worker;
DO $$
DECLARE got int;
BEGIN
  SELECT count(DISTINCT workspace_id) INTO got
    FROM member
   WHERE id IN (
     '10000000-0000-7000-8000-000000000101',
     '20000000-0000-7000-8000-000000000101'
   );
  IF got <> 2 THEN RAISE EXCEPTION 'momo_worker did not see both tenants: %', got; END IF;
END $$;
RESET ROLE;

\echo [rls] PASS
SQL

echo "[rls] done"

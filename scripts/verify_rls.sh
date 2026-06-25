#!/usr/bin/env sh
# =============================================================================
# scripts/verify_rls.sh — MOMO-003 runtime RLS gate
#
# Verifies tenant isolation against Docker PostgreSQL with non-superuser app
# credentials plus explicit BYPASSRLS relay/worker roles. The script is intended
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
\echo [rls] create app/relay/worker runtime roles
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
END $$;

ALTER ROLE momo_app
  WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'momo_app_dev_pw';
ALTER ROLE momo_relay
  WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS PASSWORD 'momo_relay_dev_pw';
ALTER ROLE momo_worker
  WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS PASSWORD 'momo_worker_dev_pw';

DO $$
BEGIN
  EXECUTE format(
    'GRANT CONNECT ON DATABASE %I TO momo_app, momo_relay, momo_worker',
    current_database()
  );
END $$;
GRANT USAGE ON SCHEMA public TO momo_app, momo_relay, momo_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public
  TO momo_app, momo_relay, momo_worker;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public
  TO momo_app, momo_relay, momo_worker;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public
  TO momo_app, momo_relay, momo_worker;

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
  IF EXISTS (
    SELECT 1
      FROM pg_roles
     WHERE rolname IN ('momo_app', 'momo_relay', 'momo_worker')
       AND rolsuper
  ) THEN
    RAISE EXCEPTION 'runtime roles must not be superusers';
  END IF;
END $$;

\echo [rls] assert FORCE RLS is enabled on tenant-critical tables
DO $$
DECLARE missing text;
BEGIN
  SELECT string_agg(v.relname, ', ' ORDER BY v.relname)
    INTO missing
    FROM (VALUES ('member'), ('channel'), ('membership'), ('message')) AS v(relname)
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
   'rls-a@momo.local', true, 'dev-password-stub', 'Asia/Seoul'),
  ('10000000-0000-7000-8000-000000000102', '10000000-0000-7000-8000-000000000001',
   'rls-a-nonmember@momo.local', true, 'dev-password-stub', 'Asia/Seoul'),
  ('20000000-0000-7000-8000-000000000101', '20000000-0000-7000-8000-000000000001',
   'rls-b@momo.local', true, 'dev-password-stub', 'Asia/Seoul')
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
DECLARE got int;
BEGIN
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
END $$;
RESET ROLE;

\echo [rls] workspace A context cannot read workspace B rows and can use allowed membership
SET ROLE momo_app;
BEGIN;
SELECT set_config('app.workspace_id', '10000000-0000-7000-8000-000000000001', true);
DO $$
DECLARE got int;
BEGIN
  SELECT count(*) INTO got FROM member WHERE workspace_id = '20000000-0000-7000-8000-000000000001';
  IF got <> 0 THEN RAISE EXCEPTION 'workspace B member leaked into A context: %', got; END IF;
  SELECT count(*) INTO got FROM channel WHERE id = '20000000-0000-7000-8000-000000000201';
  IF got <> 0 THEN RAISE EXCEPTION 'workspace B channel leaked into A context: %', got; END IF;
  SELECT count(*) INTO got FROM membership WHERE id = '20000000-0000-7000-8000-000000000301';
  IF got <> 0 THEN RAISE EXCEPTION 'workspace B membership leaked into A context: %', got; END IF;
  SELECT count(*) INTO got FROM message WHERE id = '20000000-0000-7000-8000-000000000401';
  IF got <> 0 THEN RAISE EXCEPTION 'workspace B message leaked into A context: %', got; END IF;

  SELECT count(*) INTO got
    FROM message m
    JOIN membership ms
      ON ms.channel_id = m.channel_id
     AND ms.member_id = '10000000-0000-7000-8000-000000000101'
     AND ms.left_at IS NULL
   WHERE m.id = '10000000-0000-7000-8000-000000000401';
  IF got <> 1 THEN RAISE EXCEPTION 'allowed membership read failed in A context: %', got; END IF;
END $$;

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
  SELECT count(*) INTO got FROM member WHERE workspace_id = '10000000-0000-7000-8000-000000000001';
  IF got <> 0 THEN RAISE EXCEPTION 'workspace A member leaked into B context: %', got; END IF;
  SELECT count(*) INTO got FROM channel WHERE id = '10000000-0000-7000-8000-000000000201';
  IF got <> 0 THEN RAISE EXCEPTION 'workspace A channel leaked into B context: %', got; END IF;
  SELECT count(*) INTO got FROM membership WHERE id = '10000000-0000-7000-8000-000000000301';
  IF got <> 0 THEN RAISE EXCEPTION 'workspace A membership leaked into B context: %', got; END IF;
  SELECT count(*) INTO got FROM message WHERE id = '10000000-0000-7000-8000-000000000401';
  IF got <> 0 THEN RAISE EXCEPTION 'workspace A message leaked into B context: %', got; END IF;
END $$;
COMMIT;
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

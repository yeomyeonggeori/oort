#!/usr/bin/env bash
# Retire only the two historical deterministic demo agent identities.
# This is intentionally opt-in and never runs from migrations or local-alpha.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: DATABASE_URL=postgres://... scripts/cleanup_dogfood_seed_agents.sh --yes

Retires the historical Kim Intern (...102) and Hermes (...103) seed identities
only when their workspace, kind, and handle exactly match the known demo seed.
Active memberships are left, credentials revoked, live work cancelled, and the
handles are released for a real pairing invite. No row is hard-deleted.
Stop Hermes/AgentWorker before confirming so no in-flight provider callback races
the retirement transaction.

Without --yes this command only prints this explanation and does not connect.
EOF
}

case "${1:-}" in
  --yes)
    shift
    ;;
  help|-h|--help|"")
    usage
    exit 0
    ;;
  *)
    echo "[seed-cleanup] expected --yes; refusing to connect" >&2
    usage >&2
    exit 2
    ;;
esac

if [ "$#" -ne 0 ]; then
  echo "[seed-cleanup] unexpected arguments; refusing to connect" >&2
  exit 2
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo "[seed-cleanup] DATABASE_URL is required; refusing to guess a database" >&2
  exit 2
fi

if command -v psql >/dev/null 2>&1; then
  PSQL_BIN="$(command -v psql)"
elif [ -x /opt/homebrew/opt/libpq/bin/psql ]; then
  PSQL_BIN=/opt/homebrew/opt/libpq/bin/psql
elif [ -x /usr/local/opt/libpq/bin/psql ]; then
  PSQL_BIN=/usr/local/opt/libpq/bin/psql
else
  echo "[seed-cleanup] psql is required" >&2
  exit 2
fi

echo "[seed-cleanup] retiring exact historical seed identities (user opt-in)"
"$PSQL_BIN" "$DATABASE_URL" -v ON_ERROR_STOP=1 --no-psqlrc <<'SQL'
BEGIN;
SET LOCAL row_security = off;
SET LOCAL app.workspace_id = '00000000-0000-7000-8000-000000000001';

DO $cleanup_guard$
DECLARE
  database_owner name;
BEGIN
  SELECT pg_get_userbyid(datdba)
    INTO database_owner
    FROM pg_database
   WHERE datname = current_database();

  IF NOT pg_has_role(current_user, database_owner, 'MEMBER') THEN
    RAISE EXCEPTION 'seed cleanup requires the database owner role';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM member
     WHERE id = '00000000-0000-7000-8000-000000000102'
       AND (workspace_id <> '00000000-0000-7000-8000-000000000001'
            OR kind <> 'agent'
            OR NOT (handle = 'kim-intern'
                    OR (handle = 'seeded-kim-intern-retired'
                        AND status = 'deleted' AND deleted_at IS NOT NULL)))
  ) OR EXISTS (
    SELECT 1
      FROM member
     WHERE id = '00000000-0000-7000-8000-000000000103'
       AND (workspace_id <> '00000000-0000-7000-8000-000000000001'
            OR kind <> 'agent'
            OR NOT (handle = 'hermes'
                    OR (handle = 'seeded-hermes-retired'
                        AND status = 'deleted' AND deleted_at IS NOT NULL)))
  ) THEN
    RAISE EXCEPTION 'seed identity collision; refusing cleanup';
  END IF;
END
$cleanup_guard$;

CREATE TEMP TABLE _momo_seed_agent_cleanup(member_id uuid PRIMARY KEY) ON COMMIT DROP;
INSERT INTO _momo_seed_agent_cleanup (member_id)
SELECT id
  FROM member
 WHERE workspace_id = '00000000-0000-7000-8000-000000000001'
   AND kind = 'agent'
   AND ((id = '00000000-0000-7000-8000-000000000102'
         AND handle = 'kim-intern')
        OR
        (id = '00000000-0000-7000-8000-000000000103'
         AND handle = 'hermes'));

UPDATE approval
   SET status = 'cancelled'
 WHERE status = 'pending'
   AND run_id IN (
     SELECT id FROM agent_run
      WHERE agent_member_id IN (SELECT member_id FROM _momo_seed_agent_cleanup)
   );

UPDATE outbox
   SET status = 'failed',
       last_error = 'historical seed agent retired by operator',
       processed_at = now(),
       lease_owner = NULL,
       lease_acquired_at = NULL,
       lease_expires_at = NULL
 WHERE kind = 'agent_job'
   AND status IN ('pending', 'processing')
   AND partition_key IN (SELECT member_id FROM _momo_seed_agent_cleanup);

UPDATE agent_run
   SET status = 'cancelled',
       error = jsonb_build_object('code', 'seed_agent_retired'),
       finished_at = COALESCE(finished_at, now()),
       updated_at = now()
 WHERE status IN ('queued', 'running', 'awaiting_approval', 'paused')
   AND agent_member_id IN (SELECT member_id FROM _momo_seed_agent_cleanup);

UPDATE token
   SET revoked_at = COALESCE(revoked_at, now())
 WHERE actor_member_id IN (SELECT member_id FROM _momo_seed_agent_cleanup)
   AND revoked_at IS NULL;

UPDATE membership
   SET left_at = COALESCE(left_at, now())
 WHERE member_id IN (SELECT member_id FROM _momo_seed_agent_cleanup)
   AND left_at IS NULL;

UPDATE member
   SET status = 'deleted',
       deleted_at = COALESCE(deleted_at, now()),
       updated_at = now(),
       handle = CASE id
         WHEN '00000000-0000-7000-8000-000000000102' THEN 'seeded-kim-intern-retired'
         WHEN '00000000-0000-7000-8000-000000000103' THEN 'seeded-hermes-retired'
       END
 WHERE id IN (SELECT member_id FROM _momo_seed_agent_cleanup);

INSERT INTO audit_log (workspace_id, action, target_type, detail)
SELECT '00000000-0000-7000-8000-000000000001',
       'dogfood.seed_agent.retire',
       'member',
       jsonb_build_object(
         'member_ids', (SELECT jsonb_agg(member_id ORDER BY member_id)
                          FROM _momo_seed_agent_cleanup),
         'mode', 'operator_opt_in'
       )
 WHERE EXISTS (SELECT 1 FROM _momo_seed_agent_cleanup);

SELECT count(*) AS remaining_active_historical_seed_agents
  FROM member
 WHERE id IN ('00000000-0000-7000-8000-000000000102',
              '00000000-0000-7000-8000-000000000103')
   AND status = 'active'
   AND deleted_at IS NULL;
COMMIT;
SQL

echo "[seed-cleanup] complete; pair Hermes in the app, issue its credential, then update ~/.momo/hermes-gateway.env"

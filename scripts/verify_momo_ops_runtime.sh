#!/usr/bin/env bash
# MOMO-560 migrate-image member/invite runtime verifier.
set -euo pipefail
umask 077

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

RUN_TAG="$(date -u +%Y%m%dT%H%M%SZ)-$$"
NETWORK="momo-ops-$RUN_TAG"
POSTGRES_CONTAINER="momo-ops-postgres-$RUN_TAG"
MEMBER_CONTAINER="momo-ops-member-$RUN_TAG"
INVITE_CONTAINER="momo-ops-invite-$RUN_TAG"
MIGRATE_IMAGE="momo-migrate:ops-$RUN_TAG"
POSTGRES_PORT=28220
POSTGRES_PASSWORD="momo_ops_db_$RUN_TAG"
DATABASE_URL="postgres://postgres:${POSTGRES_PASSWORD}@${POSTGRES_CONTAINER}:5432/postgres"
WORKSPACE_ID="00000000-0000-7000-8000-000000000001"
INVITE_CODE="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/momo-ops-runtime.XXXXXX")"
export POSTGRES_PASSWORD DATABASE_URL WORKSPACE_ID INVITE_CODE

fail() {
  printf '[momo-ops-runtime] FAIL: %s\n' "$*" >&2
  exit 1
}

for command_name in docker python3 openssl; do
  command -v "$command_name" >/dev/null 2>&1 || fail "missing required command: $command_name"
done

python3 - "$POSTGRES_PORT" <<'PY'
import socket, sys
port = int(sys.argv[1])
sock = socket.socket()
try:
    sock.bind(("127.0.0.1", port))
except OSError:
    raise SystemExit(f"reserved verifier port is already in use: {port}")
finally:
    sock.close()
PY

cleanup() {
  docker rm -f "$MEMBER_CONTAINER" "$INVITE_CONTAINER" "$POSTGRES_CONTAINER" >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
  docker image rm "$MIGRATE_IMAGE" >/dev/null 2>&1 || true
  rm -rf -- "$TMP_DIR"
}
trap cleanup EXIT INT TERM

docker network create "$NETWORK" >/dev/null
docker run --detach --rm \
  --name "$POSTGRES_CONTAINER" \
  --network "$NETWORK" \
  --env POSTGRES_PASSWORD \
  --publish "127.0.0.1:${POSTGRES_PORT}:5432" \
  pgvector/pgvector:0.8.5-pg18-trixie@sha256:9d2e61c7352b9e9f4798df5fd9a498f043f4cda1cdacc707de3d198650f4321e >/dev/null

for _ in $(seq 1 60); do
  docker exec "$POSTGRES_CONTAINER" pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$POSTGRES_CONTAINER" pg_isready -U postgres >/dev/null ||
  fail "PostgreSQL did not become ready"

docker build -f infra/prod/docker/internal-smoke-migrate.Dockerfile \
  -t "$MIGRATE_IMAGE" . >/dev/null
docker run --rm --network "$NETWORK" \
  --env DATABASE_URL \
  --env MOMO_AGENT_SEED_MODE=e2e \
  "$MIGRATE_IMAGE" >"$TMP_DIR/migrate.log" 2>&1

MOMO_OPS_WORKSPACE_ID="$WORKSPACE_ID"
export MOMO_OPS_WORKSPACE_ID
docker run --name "$MEMBER_CONTAINER" --network "$NETWORK" \
  --env DATABASE_URL \
  --env MOMO_OPS_WORKSPACE_ID \
  "$MIGRATE_IMAGE" member-list >"$TMP_DIR/member-list.log" 2>&1
[ "$(docker inspect -f '{{json .Config.Cmd}}' "$MEMBER_CONTAINER")" = '["member-list"]' ] ||
  fail "workspace selector leaked into member-list argv"
grep -Fq 'demo' "$TMP_DIR/member-list.log" ||
  fail "member-list did not return the seeded human"
grep -Fq 'kim-intern' "$TMP_DIR/member-list.log" ||
  fail "member-list did not return the seeded agent"

MOMO_OPS_CREATED_BY=""
MOMO_OPS_INVITE_ROLE="guest"
MOMO_OPS_INVITE_MAX_USES=2
MOMO_OPS_INVITE_EXPIRES_DAYS=3
MOMO_OPS_INVITE_CODE="$INVITE_CODE"
export MOMO_OPS_CREATED_BY MOMO_OPS_INVITE_ROLE MOMO_OPS_INVITE_MAX_USES
export MOMO_OPS_INVITE_EXPIRES_DAYS MOMO_OPS_INVITE_CODE
docker run --name "$INVITE_CONTAINER" --network "$NETWORK" \
  --env DATABASE_URL \
  --env MOMO_OPS_WORKSPACE_ID \
  --env MOMO_OPS_CREATED_BY \
  --env MOMO_OPS_INVITE_ROLE \
  --env MOMO_OPS_INVITE_MAX_USES \
  --env MOMO_OPS_INVITE_EXPIRES_DAYS \
  --env MOMO_OPS_INVITE_CODE \
  "$MIGRATE_IMAGE" invite-create >"$TMP_DIR/invite-create.log" 2>&1

[ "$(docker inspect -f '{{json .Config.Cmd}}' "$INVITE_CONTAINER")" = '["invite-create"]' ] ||
  fail "invite fields leaked into container argv"
if grep -Fq "$INVITE_CODE" "$TMP_DIR/invite-create.log"; then
  fail "raw invite code leaked into container stdout/stderr"
fi
grep -Fq 'operator invite created (raw code not printed)' "$TMP_DIR/invite-create.log" ||
  fail "invite-create did not report redacted completion"

invite_state="$(docker exec --interactive \
  --env WORKSPACE_ID \
  --env INVITE_CODE \
  "$POSTGRES_CONTAINER" psql -qAt -U postgres -d postgres \
  -v ON_ERROR_STOP=1 --no-psqlrc <<'SQL'
\getenv workspace_id WORKSPACE_ID
\getenv invite_code INVITE_CODE
SET app.workspace_id = :'workspace_id';
SELECT count(*) = 1
  FROM invite_code i
  JOIN audit_log a
    ON a.workspace_id = i.workspace_id
   AND a.target_id = i.id
   AND a.action = 'invite.created'
   AND a.target_type = 'invite_code'
 WHERE i.workspace_id = :'workspace_id'::uuid
   AND i.code_hash = momo_invite_code_hash(:'invite_code')
   AND i.role = 'guest'
   AND i.max_uses = 2
   AND i.metadata->>'source' = 'momo-ops'
   AND a.detail->>'source' = 'momo-ops'
   AND i.created_by = '00000000-0000-7000-8000-000000000101';
SQL
)"
[ "$invite_state" = "t" ] ||
  fail "invite hash, role, actor, metadata, or audit contract did not persist"

# MOMO-571 W-3: the invite role cap is enforced at the SQL layer, not only the
# CLI. An owner-role invite must be refused with no invite_code row written.
OWNER_INVITE_CODE="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')"
MOMO_OPS_INVITE_ROLE="owner"
MOMO_OPS_INVITE_CODE="$OWNER_INVITE_CODE"
export MOMO_OPS_INVITE_ROLE MOMO_OPS_INVITE_CODE
if docker run --rm --network "$NETWORK" \
    --env DATABASE_URL \
    --env MOMO_OPS_WORKSPACE_ID \
    --env MOMO_OPS_CREATED_BY \
    --env MOMO_OPS_INVITE_ROLE \
    --env MOMO_OPS_INVITE_MAX_USES \
    --env MOMO_OPS_INVITE_EXPIRES_DAYS \
    --env MOMO_OPS_INVITE_CODE \
    "$MIGRATE_IMAGE" invite-create >"$TMP_DIR/invite-owner.log" 2>&1; then
  fail "invite-create minted an owner-role invite"
fi
grep -Fq 'operator invite role must not be owner' "$TMP_DIR/invite-owner.log" ||
  fail "owner-role invite failure was not actionable"
owner_invite_absent="$(docker exec --interactive \
  --env WORKSPACE_ID \
  --env OWNER_INVITE_CODE="$OWNER_INVITE_CODE" \
  "$POSTGRES_CONTAINER" psql -qAt -U postgres -d postgres \
  -v ON_ERROR_STOP=1 --no-psqlrc <<'SQL'
\getenv workspace_id WORKSPACE_ID
\getenv invite_code OWNER_INVITE_CODE
SET app.workspace_id = :'workspace_id';
SELECT count(*) = 0
  FROM invite_code i
 WHERE i.workspace_id = :'workspace_id'::uuid
   AND i.code_hash = momo_invite_code_hash(:'invite_code');
SQL
)"
[ "$owner_invite_absent" = "t" ] ||
  fail "rejected owner-role invite still persisted a row"

printf '[momo-ops-runtime] PASS: member list + env-only invite hash/audit + owner-role refusal on port %s\n' \
  "$POSTGRES_PORT"

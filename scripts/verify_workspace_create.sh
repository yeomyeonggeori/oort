#!/usr/bin/env bash
# MOMO-571 migrate-image workspace-create runtime verifier (ADR-0117 §D1-A).
# Docker execution is the orchestrator's responsibility (runtime-unverified on
# handoff). Reserves port 28250.
set -euo pipefail
umask 077

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

RUN_TAG="$(date -u +%Y%m%dT%H%M%SZ)-$$"
NETWORK="momo-wsc-$RUN_TAG"
POSTGRES_CONTAINER="momo-wsc-postgres-$RUN_TAG"
CREATE_CONTAINER="momo-wsc-create-$RUN_TAG"
DUP_CONTAINER="momo-wsc-dup-$RUN_TAG"
MIGRATE_IMAGE="momo-migrate:wsc-$RUN_TAG"
POSTGRES_PORT=28250
POSTGRES_PASSWORD="momo_wsc_db_$RUN_TAG"
DATABASE_URL="postgres://postgres:${POSTGRES_PASSWORD}@${POSTGRES_CONTAINER}:5432/postgres"
WS_NAME="Acme Internal Alpha"
WS_SLUG="acme-alpha-$$"
OWNER_EMAIL="owner.$$@acme.example.test"
OWNER_PASSWORD="$(openssl rand -base64 24 | tr '+/' '-_' | tr -d '=\n')"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/momo-wsc-runtime.XXXXXX")"
export POSTGRES_PASSWORD DATABASE_URL

fail() {
  printf '[momo-wsc-runtime] FAIL: %s\n' "$*" >&2
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
  docker rm -f "$CREATE_CONTAINER" "$DUP_CONTAINER" "$POSTGRES_CONTAINER" >/dev/null 2>&1 || true
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

# Fresh schema, no demo seed — workspace-create must stand up its own tenant.
docker run --rm --network "$NETWORK" \
  --env DATABASE_URL \
  --env MOMO_AGENT_SEED_MODE=none \
  "$MIGRATE_IMAGE" >"$TMP_DIR/migrate.log" 2>&1

MOMO_OPS_WORKSPACE_NAME="$WS_NAME"
MOMO_OPS_WORKSPACE_SLUG="$WS_SLUG"
MOMO_OPS_OWNER_EMAIL="$OWNER_EMAIL"
MOMO_OPS_OWNER_PASSWORD="$OWNER_PASSWORD"
export MOMO_OPS_WORKSPACE_NAME MOMO_OPS_WORKSPACE_SLUG MOMO_OPS_OWNER_EMAIL MOMO_OPS_OWNER_PASSWORD

docker run --name "$CREATE_CONTAINER" --network "$NETWORK" \
  --env DATABASE_URL \
  --env MOMO_OPS_WORKSPACE_NAME \
  --env MOMO_OPS_WORKSPACE_SLUG \
  --env MOMO_OPS_OWNER_EMAIL \
  --env MOMO_OPS_OWNER_PASSWORD \
  "$MIGRATE_IMAGE" workspace-create >"$TMP_DIR/create.log" 2>&1

[ "$(docker inspect -f '{{json .Config.Cmd}}' "$CREATE_CONTAINER")" = '["workspace-create"]' ] ||
  fail "workspace-create inputs leaked into container argv"
if grep -Fq "$OWNER_PASSWORD" "$TMP_DIR/create.log"; then
  fail "owner password leaked into container stdout/stderr"
fi
grep -Fq 'workspace created (owner credentials not printed)' "$TMP_DIR/create.log" ||
  fail "workspace-create did not report redacted completion"

# Full-tenant assertion: workspace + owner (member/human/workspace_membership),
# #general channel + seq + owner membership, audit row, password verifies.
create_state="$(docker exec --interactive \
  --env WS_SLUG="$WS_SLUG" \
  --env OWNER_EMAIL="$OWNER_EMAIL" \
  --env OWNER_PASSWORD="$OWNER_PASSWORD" \
  "$POSTGRES_CONTAINER" psql -qAt -U postgres -d postgres \
  -v ON_ERROR_STOP=1 --no-psqlrc <<'SQL'
\getenv ws_slug WS_SLUG
\getenv owner_email OWNER_EMAIL
\getenv owner_password OWNER_PASSWORD
SELECT set_config('app.workspace_id',
                  (SELECT id::text FROM workspace WHERE slug = :'ws_slug'), false);
SELECT
  (SELECT count(*) = 1 FROM workspace w WHERE w.slug = :'ws_slug')
  AND (SELECT count(*) = 1
         FROM member m
         JOIN human h ON h.member_id = m.id
         JOIN workspace_membership wm
           ON wm.workspace_id = m.workspace_id AND wm.member_id = m.id
        WHERE m.workspace_id = current_setting('app.workspace_id')::uuid
          AND m.kind = 'human' AND m.status = 'active'
          AND h.email = lower(:'owner_email')
          AND h.email_verified
          AND momo_password_verify(:'owner_password', h.password_hash)
          AND wm.role = 'owner')
  AND (SELECT count(*) = 1
         FROM channel c
         JOIN channel_seq cs ON cs.channel_id = c.id
         JOIN membership ms
           ON ms.channel_id = c.id AND ms.member_id = c.created_by
        WHERE c.workspace_id = current_setting('app.workspace_id')::uuid
          AND c.kind = 'public' AND c.name = 'general'
          AND cs.last_seq = 0 AND ms.role = 'owner')
  AND (SELECT count(*) = 1
         FROM audit_log a
        WHERE a.workspace_id = current_setting('app.workspace_id')::uuid
          AND a.action = 'workspace.created'
          AND a.target_type = 'workspace'
          AND a.detail->>'source' = 'momo-ops'
          AND a.detail->>'slug' = :'ws_slug');
SQL
)"
[ "$(printf '%s\n' "$create_state" | tail -n 1)" = "t" ] ||
  fail "workspace/owner/channel/audit contract did not persist"

# Re-run with the same slug must be refused with no partial second workspace.
if docker run --name "$DUP_CONTAINER" --network "$NETWORK" \
    --env DATABASE_URL \
    --env MOMO_OPS_WORKSPACE_NAME \
    --env MOMO_OPS_WORKSPACE_SLUG \
    --env MOMO_OPS_OWNER_EMAIL \
    --env MOMO_OPS_OWNER_PASSWORD \
    "$MIGRATE_IMAGE" workspace-create >"$TMP_DIR/dup.log" 2>&1; then
  fail "duplicate slug workspace-create was not refused"
fi
grep -Fq 'workspace slug already exists' "$TMP_DIR/dup.log" ||
  fail "duplicate slug failure was not actionable"
dup_count="$(docker exec --interactive --env WS_SLUG="$WS_SLUG" \
  "$POSTGRES_CONTAINER" psql -qAt -U postgres -d postgres \
  -v ON_ERROR_STOP=1 --no-psqlrc <<'SQL'
\getenv ws_slug WS_SLUG
SELECT count(*) FROM workspace WHERE slug = :'ws_slug';
SQL
)"
[ "$(printf '%s\n' "$dup_count" | tail -n 1)" = "1" ] ||
  fail "duplicate slug attempt mutated workspace state"

printf '[momo-wsc-runtime] PASS: workspace-create tenant + slug-refusal on port %s\n' \
  "$POSTGRES_PORT"

#!/usr/bin/env bash
# =============================================================================
# scripts/verify_workspace_rest_create.sh — MOMO-589 / ADR-0117 §D1-A
#   In-app workspace creation REST: POST /v1/workspaces.
#
# Two layers:
#   1. Worker gate (always): isolated port reservation, schema_v0 untouched
#      invariant, POST /v1/workspaces route presence, swift build + focused unit
#      tests. No migration is introduced — the endpoint provisions existing
#      tables (workspace/member/human/workspace_membership/channel/channel_seq/
#      membership/audit_log), so this gate also asserts no new migration is
#      required for the surface.
#   2. Runtime REST smoke (WORKSPACE_CREATE_RUN_DOCKER=1): boots a real PG18 + api
#      on the docker-compose e2e stack and drives the create surface end to end:
#        * a listed instance operator (owner/admin whose verified email is in
#          PLATFORM_ADMIN_EMAILS) POSTs {slug,name} -> 201 {workspaceId}.
#        * the new tenant carries the full seed: owner member/human (email +
#          password_hash replicated per ADR-0117 §D5-A), workspace_membership
#          owner, a #general public channel with channel_seq=0 + owner channel
#          membership, and a workspace.created audit row (source=momo-rest).
#        * the operator logs into the NEW workspace with the SAME credentials and
#          gets a token (D5-A replication proof).
#        * a non-admin member (403) and a workspace OWNER who is NOT listed (403)
#          both fail — minting a tenant needs instance-operator authority, not
#          mere workspace ownership (MOMO-583 model).
#        * re-POSTing the same slug -> 409 with no second workspace row.
#        * malformed slug/name -> 400.
#
# Ports live in the reserved 28290 block. schema_v0.sql is never modified.
# =============================================================================
set -euo pipefail
umask 077

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

log() { echo "[workspace-create] $*"; }

# ---- Isolated port block (28290s). Reserve so a concurrent gate cannot race. ---
API_PORT="${WORKSPACE_CREATE_API_PORT:-28290}"
HERMES_PORT="${WORKSPACE_CREATE_HERMES_PORT:-28291}"
PG_PORT="${WORKSPACE_CREATE_POSTGRES_PORT:-28292}"
CENTRIFUGO_PORT="${WORKSPACE_CREATE_CENTRIFUGO_PORT:-28293}"

command -v python3 >/dev/null 2>&1 || {
  log "missing python3"
  exit 1
}

python3 - "$API_PORT" "$HERMES_PORT" "$PG_PORT" "$CENTRIFUGO_PORT" <<'PY'
import socket, sys
ports = [int(value) for value in sys.argv[1:]]
if len(ports) != len(set(ports)):
    raise SystemExit(f"[workspace-create] ports must be distinct: {ports}")
sockets = []
try:
    for port in ports:
        sock = socket.socket()
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 0)
        sock.bind(("127.0.0.1", port))
        sockets.append(sock)
except OSError as error:
    raise SystemExit(f"[workspace-create] reserved port preflight failed: {error}")
finally:
    for sock in sockets:
        sock.close()
PY
log "reserved isolated ports ${API_PORT}/${HERMES_PORT}/${PG_PORT}/${CENTRIFUGO_PORT}"

# ---- Route presence + schema_v0 untouched invariant ------------------------
ROUTES="server/Sources/MomoServer/Routes/WorkspaceRoutes.swift"
test -f "$ROUTES" || {
  log "missing $ROUTES"
  exit 1
}
grep -q 'group.post("/v1/workspaces", use: create)' "$ROUTES" || {
  log "WorkspaceRoutes does not register POST /v1/workspaces"
  exit 1
}
if git -C "$REPO_ROOT" diff --name-only HEAD 2>/dev/null | grep -qx "schema_v0.sql"; then
  log "schema_v0.sql must not be modified"
  exit 1
fi

# ---- swift build + focused server unit gate --------------------------------
command -v swift >/dev/null 2>&1 || {
  log "missing swift toolchain"
  exit 1
}
log "swift build (server)"
swift build --package-path server >/dev/null
log "swift test --filter WorkspaceCreateTests (server)"
swift test --package-path server --filter WorkspaceCreateTests >/dev/null

log "PASS worker gate: POST route present, schema_v0 untouched, build + create unit tests green"

# ---- Runtime REST smoke gate -----------------------------------------------
if [ "${WORKSPACE_CREATE_RUN_DOCKER:-0}" != "1" ]; then
  log "runtime-unverified: the live REST smoke (compose PG18+api, operator POST"
  log "  -> 201 + full-tenant seed + D5-A owner login into the new workspace,"
  log "  non-operator/ws-owner 403 matrix, duplicate-slug 409, 400 validation) is"
  log "  gated behind WORKSPACE_CREATE_RUN_DOCKER=1 (needs Docker). Re-run there."
  exit 0
fi

# =============================================================================
# WORKSPACE_CREATE_RUN_DOCKER=1 — real compose PG18 + api REST roundtrip.
# =============================================================================
need() { command -v "$1" >/dev/null 2>&1 || { log "missing $1"; exit 1; }; }
need docker
need curl
need jq

new_uuid() { python3 -c 'import uuid; print(uuid.uuid4())'; }

COMPOSE_FILE="$REPO_ROOT/infra/docker-compose.e2e.yml"
PROJECT="${WORKSPACE_CREATE_GATE_PROJECT:-momo589wscreate}"
BOOT_TIMEOUT="${WORKSPACE_CREATE_BOOT_TIMEOUT:-2400}"
RUN_ID="$(date -u +%s)-$$"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/momo-workspace-create.XXXXXX")"

# Home workspace = the default e2e seed workspace (002_seed.sql slug 'demo').
# Its seeded human has no password, so we seed our own operator + non-operator
# humans inside it. The operator then provisions a BRAND NEW workspace via REST.
HOME_WORKSPACE_ID="00000000-0000-7000-8000-000000000001"
OPERATOR_ID="$(new_uuid)"
MEMBER_ID="$(new_uuid)"
WSOWNER_ID="$(new_uuid)"
OPERATOR_EMAIL="wsc-operator-$RUN_ID@momo.local"
MEMBER_EMAIL="wsc-member-$RUN_ID@momo.local"
# Workspace owner role but NOT listed in PLATFORM_ADMIN_EMAILS: must 403 (proves
# tenant creation needs instance-operator authority, not workspace ownership).
WSOWNER_EMAIL="wsc-wsowner-$RUN_ID@momo.local"
OPERATOR_PASSWORD="wsc-operator-$(new_uuid)"
MEMBER_PASSWORD="wsc-member-$(new_uuid)"
WSOWNER_PASSWORD="wsc-wsowner-$(new_uuid)"

# Target tenant under test — a fresh slug per run (lowercase/digits/hyphen only).
NEW_SLUG="wsc-$RUN_ID"
NEW_NAME="Workspace Create Smoke $RUN_ID"

compose() {
  # MOMO-583/589: the create surface requires platform:read OR a listed instance
  # operator. Listing only OPERATOR_EMAIL lets the operator through and keeps the
  # same-role WSOWNER at 403.
  PORT="$API_PORT" POSTGRES_PORT="$PG_PORT" CENT_PORT="$CENTRIFUGO_PORT" \
    HERMES_PORT="$HERMES_PORT" PLATFORM_ADMIN_EMAILS="$OPERATOR_EMAIL" \
    docker compose -p "$PROJECT" -f "$COMPOSE_FILE" "$@"
}

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if [ "${WORKSPACE_CREATE_GATE_KEEP:-0}" = "1" ]; then
    log "leaving compose project '$PROJECT' up; evidence: $TMP_DIR"
  else
    compose down -v --remove-orphans >/dev/null 2>&1 || true
    case "$TMP_DIR" in
      "${TMPDIR:-/tmp}"/momo-workspace-create.*) rm -r -- "$TMP_DIR" ;;
      *) log "refusing unexpected temp path: $TMP_DIR" ;;
    esac
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

BASE_URL="http://127.0.0.1:$API_PORT"

# Linux trap (see verify_provider_link.sh): the api container copies the source
# mount with `cp -Rp`, which chokes on host-side `.build/` symlinks. Drop them.
for build_dir in \
  "$REPO_ROOT/server/.build" \
  "$REPO_ROOT/services/OutboundHTTPPolicy/.build" \
  "$REPO_ROOT/services/MomoMetrics/.build"; do
  rm -rf "$build_dir" 2>/dev/null || true
done

log "booting isolated PG18 + api stack '$PROJECT' on ${API_PORT}/${PG_PORT}/${CENTRIFUGO_PORT}/${HERMES_PORT}"
compose up -d api
deadline=$(( $(date -u +%s) + BOOT_TIMEOUT ))
until curl -fsS "$BASE_URL/health" >/dev/null 2>&1; do
  if [ "$(date -u +%s)" -ge "$deadline" ]; then
    compose logs --tail 160 api >&2 || true
    log "api health timeout"
    exit 1
  fi
  if [ -n "$(compose ps -aq --status exited api 2>/dev/null)" ]; then
    compose logs --tail 160 api >&2 || true
    log "api exited before health"
    exit 1
  fi
  sleep 3
done
log "api health green"

run_sql() {
  compose exec -T postgres psql -U "${POSTGRES_USER:-momo}" -d "${POSTGRES_DB:-momo}" \
    -v ON_ERROR_STOP=1 --no-psqlrc -q "$@"
}
sql_scalar() { run_sql -tA | tr -d '[:space:]'; }

# ---- Seed the operator + non-operator humans in the home workspace ---------
run_sql <<SQL
BEGIN;
SET LOCAL row_security = off;
INSERT INTO member (id, workspace_id, kind, status, display_name, handle)
VALUES
  ('$OPERATOR_ID', '$HOME_WORKSPACE_ID', 'human', 'active', 'WSC Operator', 'wsc-operator-$RUN_ID'),
  ('$MEMBER_ID', '$HOME_WORKSPACE_ID', 'human', 'active', 'WSC Member', 'wsc-member-$RUN_ID'),
  ('$WSOWNER_ID', '$HOME_WORKSPACE_ID', 'human', 'active', 'WSC Owner NoPlatform', 'wsc-wsowner-$RUN_ID');
INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash, tz)
VALUES
  ('$OPERATOR_ID', '$HOME_WORKSPACE_ID', '$OPERATOR_EMAIL', true, momo_password_hash('$OPERATOR_PASSWORD'), 'UTC'),
  ('$MEMBER_ID', '$HOME_WORKSPACE_ID', '$MEMBER_EMAIL', true, momo_password_hash('$MEMBER_PASSWORD'), 'UTC'),
  ('$WSOWNER_ID', '$HOME_WORKSPACE_ID', '$WSOWNER_EMAIL', true, momo_password_hash('$WSOWNER_PASSWORD'), 'UTC');
INSERT INTO workspace_membership (workspace_id, member_id, role)
VALUES ('$HOME_WORKSPACE_ID', '$OPERATOR_ID', 'owner')
ON CONFLICT (workspace_id, member_id) DO UPDATE SET role = 'owner';
INSERT INTO workspace_membership (workspace_id, member_id, role)
VALUES ('$HOME_WORKSPACE_ID', '$WSOWNER_ID', 'owner')
ON CONFLICT (workspace_id, member_id) DO UPDATE SET role = 'owner';
INSERT INTO workspace_membership (workspace_id, member_id, role)
VALUES ('$HOME_WORKSPACE_ID', '$MEMBER_ID', 'member')
ON CONFLICT (workspace_id, member_id) DO UPDATE SET role = 'member';
COMMIT;
SQL

login() {
  local workspace="${3:-$HOME_WORKSPACE_ID}"
  curl -fsS -X POST "$BASE_URL/v1/auth/login" -H 'Content-Type: application/json' \
    --data "$(jq -cn --arg e "$1" --arg p "$2" --arg w "$workspace" \
      '{email:$e,password:$p,workspace:$w}')" \
    | jq -er '.accessToken'
}
OPERATOR_TOKEN="$(login "$OPERATOR_EMAIL" "$OPERATOR_PASSWORD")"
MEMBER_TOKEN="$(login "$MEMBER_EMAIL" "$MEMBER_PASSWORD")"
WSOWNER_TOKEN="$(login "$WSOWNER_EMAIL" "$WSOWNER_PASSWORD")"
[ -n "$OPERATOR_TOKEN" ] && [ -n "$MEMBER_TOKEN" ] && [ -n "$WSOWNER_TOKEN" ] || {
  log "login did not return tokens"; exit 1; }

RESPONSE_BODY=""
RESPONSE_STATUS=""
api() {
  local method="$1" path="$2" token="$3" body="${4:-}" out="$TMP_DIR/response"
  local args=(-sS -o "$out" -w '%{http_code}' --max-time 30 -X "$method" \
    -H "Authorization: Bearer $token")
  if [ -n "$body" ]; then
    args+=(-H 'Content-Type: application/json' --data "$body")
  fi
  RESPONSE_STATUS="$(curl "${args[@]}" "$BASE_URL$path")"
  RESPONSE_BODY="$(cat "$out")"
}
expect_status() {
  [ "$RESPONSE_STATUS" = "$1" ] || {
    log "FAIL $2: expected HTTP $1, got $RESPONSE_STATUS"
    echo "$RESPONSE_BODY" >&2
    exit 1
  }
}

CREATE_PATH="/v1/workspaces"
BODY="$(jq -cn --arg s "$NEW_SLUG" --arg n "$NEW_NAME" '{slug:$s,name:$n}')"

# ---- 403 matrix: non-operator identities cannot mint a tenant --------------
api POST "$CREATE_PATH" "$MEMBER_TOKEN" "$BODY"
expect_status 403 "non-admin member create"
api POST "$CREATE_PATH" "$WSOWNER_TOKEN" "$BODY"
expect_status 403 "ws-owner(not listed) create"
log "PASS MOMO-583: non-operator (member + unlisted workspace owner) denied 403"

# ---- 400 matrix: malformed slug / name -------------------------------------
api POST "$CREATE_PATH" "$OPERATOR_TOKEN" \
  "$(jq -cn --arg n "$NEW_NAME" '{slug:"-bad-",name:$n}')"
expect_status 400 "malformed slug"
api POST "$CREATE_PATH" "$OPERATOR_TOKEN" \
  "$(jq -cn --arg s "$NEW_SLUG" '{slug:$s,name:"   "}')"
expect_status 400 "empty name"
log "PASS validation: malformed slug and blank name rejected 400"

# ---- Operator creates the tenant -> 201 {workspaceId} ----------------------
api POST "$CREATE_PATH" "$OPERATOR_TOKEN" "$BODY"
expect_status 201 "operator create"
NEW_WS_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.workspaceId')"
printf '%s' "$RESPONSE_BODY" | jq -e \
  --arg s "$NEW_SLUG" --arg n "$NEW_NAME" '
    .schema == "momo.workspace.created.v1"
    and (.workspaceId | test("^[0-9a-fA-F-]{36}$"))
    and .slug == $s
    and .name == $n
  ' >/dev/null || {
  log "FAIL create response projection"; echo "$RESPONSE_BODY" >&2; exit 1; }
log "PASS create: HTTP 201, workspaceId=$NEW_WS_ID"

# ---- Full-tenant seed assertion (workspace + owner + #general + audit) ------
SEED_OK="$(run_sql -tA \
  --set new_ws="$NEW_WS_ID" \
  --set ws_slug="$NEW_SLUG" \
  --set owner_email="$OPERATOR_EMAIL" \
  --set owner_password="$OPERATOR_PASSWORD" <<'SQL'
SET LOCAL row_security = off;
SELECT
  (SELECT count(*) = 1 FROM workspace w
     WHERE w.id = :'new_ws'::uuid AND w.slug = :'ws_slug' AND w.deleted_at IS NULL)
  AND (SELECT count(*) = 1
         FROM member m
         JOIN human h ON h.member_id = m.id
         JOIN workspace_membership wm
           ON wm.workspace_id = m.workspace_id AND wm.member_id = m.id
        WHERE m.workspace_id = :'new_ws'::uuid
          AND m.kind = 'human' AND m.status = 'active'
          AND h.email = lower(:'owner_email')
          AND h.email_verified
          AND momo_password_verify(:'owner_password', h.password_hash)
          AND wm.role = 'owner')
  AND (SELECT count(*) = 1
         FROM channel c
         JOIN channel_seq cs ON cs.channel_id = c.id
         JOIN membership ms ON ms.channel_id = c.id AND ms.member_id = c.created_by
        WHERE c.workspace_id = :'new_ws'::uuid
          AND c.kind = 'public' AND c.name = 'general'
          AND cs.last_seq = 0 AND ms.role = 'owner')
  AND (SELECT count(*) = 1
         FROM audit_log a
        WHERE a.workspace_id = :'new_ws'::uuid
          AND a.action = 'workspace.created'
          AND a.target_type = 'workspace'
          AND a.detail->>'source' = 'momo-rest'
          AND a.detail->>'slug' = :'ws_slug');
SQL
)"
[ "$(printf '%s\n' "$SEED_OK" | tr -d '[:space:]' | tail -n 1)" = "t" ] || {
  log "FAIL new tenant seed contract (workspace/owner/#general/audit)"; exit 1; }
log "PASS seed: owner member/human + workspace_membership owner + #general(seq 0) + audit"

# ---- D5-A: operator logs into the NEW workspace with the SAME credentials ---
NEW_WS_TOKEN="$(login "$OPERATOR_EMAIL" "$OPERATOR_PASSWORD" "$NEW_WS_ID")"
[ -n "$NEW_WS_TOKEN" ] || { log "FAIL D5-A: owner could not log into the new workspace"; exit 1; }
log "PASS D5-A: replicated owner credentials authenticate into the new workspace"

# ---- Duplicate slug -> 409, no second workspace row ------------------------
api POST "$CREATE_PATH" "$OPERATOR_TOKEN" "$BODY"
expect_status 409 "duplicate slug create"
SLUG_COUNT="$(run_sql -tA --set ws_slug="$NEW_SLUG" <<'SQL'
SET LOCAL row_security = off;
SELECT count(*) FROM workspace WHERE slug = :'ws_slug';
SQL
)"
[ "$(printf '%s\n' "$SLUG_COUNT" | tr -d '[:space:]' | tail -n 1)" = "1" ] || {
  log "FAIL duplicate slug mutated workspace state (count != 1)"; exit 1; }
log "PASS slug: duplicate create refused 409 with no partial second workspace"

log "PASS runtime REST smoke: POST /v1/workspaces create + seed + D5-A login + 403/409/400 on ports ${API_PORT}/${PG_PORT}"

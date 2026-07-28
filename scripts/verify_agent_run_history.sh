#!/usr/bin/env bash
# MOMO-653 isolated agent-global run-history REST verifier.
# Docker execution belongs to the orchestrator; workers run syntax/build/unit gates.
#
# Red-proof procedure (run from a clean throwaway goal worktree):
#   1. Remove `/v1/workspaces/{workspaceId}/agents/{agentId}/runs` from
#      docs/api/openapi.yaml, then run scripts/verify_openapi_contract.sh.
#      Expected named failure: the reverse gate reports the undocumented
#      `GET /v1/workspaces/{}/agents/{}/runs` server operation.
#   2. Restore the spec, remove the target-agent predicate
#      `r.agent_member_id = \(agentMemberID)` from listByAgent's page query,
#      then run this verifier. Expected named failure:
#      `target-agent filtering and insertion-stable order`.
set -euo pipefail
umask 077

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

for tool in docker curl jq uuidgen python3; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "[agent-run-history] missing $tool" >&2
    exit 1
  }
done

COMPOSE_FILE="$REPO_ROOT/infra/docker-compose.e2e.yml"
RUN_TAG="$(date -u +%s)-$$"
PROJECT="${AGENT_RUN_HISTORY_PROJECT:-momo653-run-history-$RUN_TAG}"
API_PORT="${AGENT_RUN_HISTORY_API_PORT:-28380}"
CENT_PORT="${AGENT_RUN_HISTORY_CENTRIFUGO_PORT:-28381}"
PG_PORT="${AGENT_RUN_HISTORY_POSTGRES_PORT:-28382}"
HERMES_PORT="${AGENT_RUN_HISTORY_HERMES_PORT:-28383}"
BOOT_TIMEOUT="${AGENT_RUN_HISTORY_BOOT_TIMEOUT:-2400}"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/momo-agent-run-history.XXXXXX")"

compose() {
  PORT="$API_PORT" CENT_PORT="$CENT_PORT" POSTGRES_PORT="$PG_PORT" HERMES_PORT="$HERMES_PORT" \
    docker compose -p "$PROJECT" -f "$COMPOSE_FILE" "$@"
}

python3 - "$API_PORT" "$CENT_PORT" "$PG_PORT" "$HERMES_PORT" <<'PY'
import socket
import sys

ports = [int(value) for value in sys.argv[1:]]
if len(ports) != len(set(ports)):
    raise SystemExit(f"[agent-run-history] reserved ports must be distinct: {ports}")
sockets = []
try:
    for port in ports:
        sock = socket.socket()
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 0)
        sock.bind(("127.0.0.1", port))
        sockets.append(sock)
except OSError as error:
    raise SystemExit(f"[agent-run-history] reserved port preflight failed: {error}")
finally:
    for sock in sockets:
        sock.close()
PY

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if [ "${AGENT_RUN_HISTORY_KEEP:-0}" = "1" ]; then
    echo "[agent-run-history] leaving $PROJECT up; evidence $TMP_DIR"
  else
    compose down -v --remove-orphans >/dev/null 2>&1 || true
    case "$TMP_DIR" in
      "${TMPDIR:-/tmp}"/momo-agent-run-history.*) rm -r -- "$TMP_DIR" ;;
      *) echo "[agent-run-history] refusing unexpected cleanup path: $TMP_DIR" >&2 ;;
    esac
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

run_sql() {
  compose exec -T postgres psql -U "${POSTGRES_USER:-momo}" -d "${POSTGRES_DB:-momo}" \
    -v ON_ERROR_STOP=1 --no-psqlrc -q "$@"
}
sql_value() { run_sql -tA | tr -d '[:space:]'; }
uuid() { uuidgen | tr '[:upper:]' '[:lower:]'; }
lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
fail() { echo "[agent-run-history] FAIL $*" >&2; exit 1; }
pass() { echo "[agent-run-history] PASS $*"; }

BASE_URL="http://127.0.0.1:$API_PORT"
WS_ID="00000000-0000-7000-8000-000000000001"
GENERAL_CHANNEL_ID="00000000-0000-7000-8000-000000000201"
ADMIN_PASSWORD="m653-admin-$(uuid)"
NONMEMBER_ID="$(uuid)"
NONMEMBER_EMAIL="m653-nonmember-$RUN_TAG@momo.local"
NONMEMBER_PASSWORD="m653-nonmember-$(uuid)"
VISIBLE_CHANNEL_ID="$(uuid)"
HIDDEN_CHANNEL_ID="$(uuid)"
OTHER_AGENT_ID="$(uuid)"
OTHER_WORKSPACE_ID="$(uuid)"
OTHER_WORKSPACE_AGENT_ID="$(uuid)"
OTHER_WORKSPACE_CHANNEL_ID="$(uuid)"
RUN_OLDEST="$(uuid)"
RUN_MIDDLE="$(uuid)"
RUN_MENTION="$(uuid)"
RUN_NEWEST="$(uuid)"
RUN_HIDDEN="$(uuid)"
RUN_OTHER_AGENT="$(uuid)"
RUN_OTHER_WORKSPACE="$(uuid)"
RUN_LATE="$(uuid)"
LONG_TITLE="$(python3 - <<'PY'
print("N" * 240)
PY
)"

echo "[agent-run-history] booting isolated API stack $PROJECT"
compose up -d api
deadline=$(( $(date -u +%s) + BOOT_TIMEOUT ))
until curl -fsS "$BASE_URL/health" >/dev/null 2>&1; do
  if [ "$(date -u +%s)" -ge "$deadline" ]; then
    compose logs --tail 180 api migrate db-roles >&2 || true
    fail "api health timeout"
  fi
  sleep 3
done

ADMIN_ID="$(sql_value <<SQL
SELECT lower(member_id::text)
  FROM human
 WHERE workspace_id='$WS_ID' AND email='demo@momo.local';
SQL
)"
AGENT_ID="$(sql_value <<SQL
SELECT lower(m.id::text)
  FROM member m
  JOIN agent a ON a.workspace_id=m.workspace_id AND a.member_id=m.id
  JOIN membership ms ON ms.workspace_id=m.workspace_id AND ms.member_id=m.id
 WHERE m.workspace_id='$WS_ID'
   AND ms.channel_id='$GENERAL_CHANNEL_ID'
   AND ms.left_at IS NULL
   AND m.status='active' AND m.deleted_at IS NULL
 ORDER BY m.id
 LIMIT 1;
SQL
)"
[ -n "$ADMIN_ID" ] && [ -n "$AGENT_ID" ] || fail "seed admin/agent missing"

run_sql <<SQL
BEGIN;
SET LOCAL row_security = off;
UPDATE human
   SET password_hash=momo_password_hash('$ADMIN_PASSWORD')
 WHERE workspace_id='$WS_ID' AND email='demo@momo.local';

-- Valid REST-login identity with no workspace_membership row. This is the
-- established nonmember fixture shape; the endpoint itself must produce 403.
INSERT INTO member (id,workspace_id,kind,status,display_name,handle)
VALUES ('$NONMEMBER_ID','$WS_ID','human','active','M653 Nonmember','m653-nonmember-$RUN_TAG');
INSERT INTO human (member_id,workspace_id,email,email_verified,password_hash,tz)
VALUES ('$NONMEMBER_ID','$WS_ID','$NONMEMBER_EMAIL',true,
        momo_password_hash('$NONMEMBER_PASSWORD'),'UTC');

INSERT INTO channel (id,workspace_id,kind,name,created_by) VALUES
 ('$VISIBLE_CHANNEL_ID','$WS_ID','private','m653-visible-$RUN_TAG','$ADMIN_ID'),
 ('$HIDDEN_CHANNEL_ID','$WS_ID','private','m653-hidden-$RUN_TAG','$ADMIN_ID');
INSERT INTO channel_seq (channel_id,workspace_id,last_seq) VALUES
 ('$VISIBLE_CHANNEL_ID','$WS_ID',0),('$HIDDEN_CHANNEL_ID','$WS_ID',0);
INSERT INTO membership (workspace_id,channel_id,member_id,role) VALUES
 ('$WS_ID','$VISIBLE_CHANNEL_ID','$ADMIN_ID','member'),
 ('$WS_ID','$VISIBLE_CHANNEL_ID','$AGENT_ID','member'),
 ('$WS_ID','$HIDDEN_CHANNEL_ID','$AGENT_ID','member');

INSERT INTO member (id,workspace_id,kind,status,display_name,handle)
VALUES ('$OTHER_AGENT_ID','$WS_ID','agent','active','M653 Other Agent','m653-other-agent-$RUN_TAG');
INSERT INTO agent (member_id,workspace_id,model,base_url)
VALUES ('$OTHER_AGENT_ID','$WS_ID','m653-other','https://example.invalid/v1');

INSERT INTO workspace (id,slug,name)
VALUES ('$OTHER_WORKSPACE_ID','m653-other-$RUN_TAG','M653 Other Workspace');
INSERT INTO member (id,workspace_id,kind,status,display_name,handle)
VALUES ('$OTHER_WORKSPACE_AGENT_ID','$OTHER_WORKSPACE_ID','agent','active',
        'M653 Foreign Agent','m653-foreign-agent');
INSERT INTO agent (member_id,workspace_id,model,base_url)
VALUES ('$OTHER_WORKSPACE_AGENT_ID','$OTHER_WORKSPACE_ID','m653-foreign',
        'https://example.invalid/v1');
INSERT INTO workspace_membership (workspace_id,member_id,role)
VALUES ('$OTHER_WORKSPACE_ID','$OTHER_WORKSPACE_AGENT_ID','member');
INSERT INTO channel (id,workspace_id,kind,name,created_by)
VALUES ('$OTHER_WORKSPACE_CHANNEL_ID','$OTHER_WORKSPACE_ID','private',
        'm653-foreign-channel','$OTHER_WORKSPACE_AGENT_ID');
INSERT INTO channel_seq (channel_id,workspace_id,last_seq)
VALUES ('$OTHER_WORKSPACE_CHANNEL_ID','$OTHER_WORKSPACE_ID',0);
INSERT INTO membership (workspace_id,channel_id,member_id,role)
VALUES ('$OTHER_WORKSPACE_ID','$OTHER_WORKSPACE_CHANNEL_ID',
        '$OTHER_WORKSPACE_AGENT_ID','member');

INSERT INTO agent_run
  (id,workspace_id,agent_member_id,channel_id,status,input,
   started_at,finished_at,created_at,updated_at,idempotency_key)
VALUES
 ('$RUN_OLDEST','$WS_ID','$AGENT_ID','$GENERAL_CHANNEL_ID','succeeded',
  '{"type":"work","title":"Oldest visible","brief":"internal-oldest"}',
  '2026-07-28 00:00:01+00','2026-07-28 00:00:01+00',
  '2026-07-28 00:00:01+00','2026-07-28 00:00:01+00','m653-oldest-$RUN_TAG'),
 ('$RUN_MIDDLE','$WS_ID','$AGENT_ID','$GENERAL_CHANNEL_ID','failed',
  '{"type":"work","title":"Middle visible","brief":"internal-middle"}',
  '2026-07-28 00:00:02+00','2026-07-28 00:00:02+00',
  '2026-07-28 00:00:02+00','2026-07-28 00:00:02+00','m653-middle-$RUN_TAG'),
 ('$RUN_MENTION','$WS_ID','$AGENT_ID','$VISIBLE_CHANNEL_ID','succeeded',
  '{"schema":"momo.agent_run.input.v0","surface":"mention",
    "prompt":"Mention trigger text","private_payload":"must-not-leak"}',
  '2026-07-28 00:00:03+00','2026-07-28 00:00:03+00',
  '2026-07-28 00:00:03+00','2026-07-28 00:00:03+00','m653-mention-$RUN_TAG'),
 ('$RUN_NEWEST','$WS_ID','$AGENT_ID','$VISIBLE_CHANNEL_ID','running',
  jsonb_build_object('type','work','title','$LONG_TITLE','brief','internal-newest'),
  '2026-07-28 00:00:04+00',NULL,
  '2026-07-28 00:00:04+00','2026-07-28 00:00:04+00','m653-newest-$RUN_TAG'),
 ('$RUN_HIDDEN','$WS_ID','$AGENT_ID','$HIDDEN_CHANNEL_ID','succeeded',
  '{"type":"work","title":"Hidden channel run","brief":"must-not-leak"}',
  '2026-07-28 00:00:05+00','2026-07-28 00:00:05+00',
  '2026-07-28 00:00:05+00','2026-07-28 00:00:05+00','m653-hidden-$RUN_TAG'),
 ('$RUN_OTHER_AGENT','$WS_ID','$OTHER_AGENT_ID','$GENERAL_CHANNEL_ID','succeeded',
  '{"type":"work","title":"Other agent run","brief":"must-not-cross-agent"}',
  '2026-07-28 00:00:06+00','2026-07-28 00:00:06+00',
  '2026-07-28 00:00:06+00','2026-07-28 00:00:06+00','m653-other-agent-$RUN_TAG'),
 ('$RUN_OTHER_WORKSPACE','$OTHER_WORKSPACE_ID','$OTHER_WORKSPACE_AGENT_ID',
  '$OTHER_WORKSPACE_CHANNEL_ID','succeeded',
  '{"type":"work","title":"Foreign workspace run","brief":"must-not-cross-tenant"}',
  '2026-07-28 00:00:07+00','2026-07-28 00:00:07+00',
  '2026-07-28 00:00:07+00','2026-07-28 00:00:07+00','m653-other-ws-$RUN_TAG');
COMMIT;
SQL

login() {
  local email="$1" password="$2" out="$TMP_DIR/login.json" status
  status="$(curl -sS -o "$out" -w '%{http_code}' -X POST "$BASE_URL/v1/auth/login" \
    -H 'Content-Type: application/json' \
    --data "$(jq -cn --arg e "$email" --arg p "$password" --arg w "$WS_ID" \
      '{email:$e,password:$p,workspace:$w}')")"
  [ "$status" = "200" ] || {
    cat "$out" >&2
    fail "actual REST login for $email returned $status"
  }
  jq -er '.accessToken' <"$out"
}

api() {
  local token="$1" method="$2" path="$3" out="$TMP_DIR/response.json"
  local -a args=(-sS -o "$out" -w '%{http_code}' -X "$method")
  [ -n "$token" ] && args+=(-H "Authorization: Bearer $token")
  RESPONSE_STATUS="$(curl "${args[@]}" "$BASE_URL$path")"
  RESPONSE_BODY="$(<"$out")"
}

expect() {
  local expected="$1" label="$2"
  [ "$RESPONSE_STATUS" = "$expected" ] || {
    fail "$label expected $expected, got $RESPONSE_STATUS: $RESPONSE_BODY"
  }
}

ADMIN_TOKEN="$(login demo@momo.local "$ADMIN_PASSWORD")"
NONMEMBER_TOKEN="$(login "$NONMEMBER_EMAIL" "$NONMEMBER_PASSWORD")"
HISTORY_PATH="/v1/workspaces/$WS_ID/agents/$AGENT_ID/runs"

api "$NONMEMBER_TOKEN" GET "$HISTORY_PATH"
expect 403 "actual-login nonmember workspace authorization"
pass "actual REST login without workspace membership receives 403"

api "$ADMIN_TOKEN" GET "$HISTORY_PATH?limit=2"
expect 200 "first newest-first page"
printf '%s' "$RESPONSE_BODY" >"$TMP_DIR/page-one.json"
NEXT_CURSOR="$(printf '%s' "$RESPONSE_BODY" | jq -er '.nextCursor | ascii_downcase')"
[ "$NEXT_CURSOR" = "$(lower "$RUN_MENTION")" ] \
  || fail "boundary cursor expected $(lower "$RUN_MENTION"), got $NEXT_CURSOR"
printf '%s' "$RESPONSE_BODY" | jq -e \
  --arg newest "$(lower "$RUN_NEWEST")" \
  --arg mention "$(lower "$RUN_MENTION")" '
  (.runs | map(.id | ascii_downcase)) == [$newest,$mention]
  and (.runs[0].triggerSummary | length) == 200
  and .runs[1].triggerSummary == "Mention trigger text"
  and all(.runs[];
    ((keys - [
      "id","channelId","triggerMessageId","triggerSummary","status",
      "startedAtMs","finishedAtMs","createdAtMs","updatedAtMs"
    ]) | length) == 0
    and (has("input") or has("output") or has("error") or has("payload")
         or has("transcript") or has("workspaceId") or has("agentMemberId") | not)
  )
' >/dev/null || fail "minimal credential-free summary projection"
pass "first page has bounded summary-only fields and a boundary cursor"

# Summary-only is a response boundary, not data loss: the existing channel-bound
# detail endpoint remains the explicit place to inspect a selected run.
api "$ADMIN_TOKEN" GET "/v1/workspaces/$WS_ID/agent-runs/$(lower "$RUN_MENTION")"
expect 200 "mention run detail drill-in"
printf '%s' "$RESPONSE_BODY" | jq -e '
  .triggerSummary == "Mention trigger text"
  and .input.prompt == "Mention trigger text"
  and .input.private_payload == "must-not-leak"
' >/dev/null || fail "authorized run detail drill-in"
pass "full input remains behind the existing authorized run detail"

# Insert after page one. A correct exclusive `(created_at,id)` cursor keeps this
# newer row out of the older page while preserving deterministic order.
run_sql <<SQL
BEGIN;
SET LOCAL row_security = off;
INSERT INTO agent_run
  (id,workspace_id,agent_member_id,channel_id,status,input,
   started_at,created_at,updated_at,idempotency_key)
VALUES
 ('$RUN_LATE','$WS_ID','$AGENT_ID','$GENERAL_CHANNEL_ID','queued',
  '{"type":"work","title":"Inserted after cursor","brief":"newer-than-page-one"}',
  '2026-07-28 00:00:08+00','2026-07-28 00:00:08+00',
  '2026-07-28 00:00:08+00','m653-late-$RUN_TAG');
COMMIT;
SQL

api "$ADMIN_TOKEN" GET "$HISTORY_PATH?limit=2&cursor=$NEXT_CURSOR"
expect 200 "second page at boundary cursor"
printf '%s' "$RESPONSE_BODY" >"$TMP_DIR/page-two.json"
printf '%s' "$RESPONSE_BODY" | jq -e \
  --arg middle "$(lower "$RUN_MIDDLE")" \
  --arg oldest "$(lower "$RUN_OLDEST")" '
  (.runs | map(.id | ascii_downcase)) == [$middle,$oldest]
  and (has("nextCursor") | not)
' >/dev/null || fail "target-agent filtering and insertion-stable order"
pass "cursor page excludes later inserts, other agents, hidden channels, and tenants"

api "$ADMIN_TOKEN" GET "$HISTORY_PATH?limit=2&cursor=$(lower "$RUN_OLDEST")"
expect 200 "empty page after oldest boundary"
printf '%s' "$RESPONSE_BODY" | jq -e \
  '.runs == [] and (has("nextCursor") | not)' >/dev/null \
  || fail "empty page after oldest boundary"
pass "oldest boundary returns a stable empty page"

api "$ADMIN_TOKEN" GET "$HISTORY_PATH?cursor=$(lower "$RUN_HIDDEN")"
expect 400 "inaccessible channel cursor"
api "$ADMIN_TOKEN" GET "$HISTORY_PATH?cursor=not-a-uuid"
expect 400 "malformed cursor"

api "$ADMIN_TOKEN" GET \
  "/v1/workspaces/$WS_ID/agents/$OTHER_WORKSPACE_AGENT_ID/runs"
expect 404 "foreign agent under current workspace"
api "$ADMIN_TOKEN" GET \
  "/v1/workspaces/$OTHER_WORKSPACE_ID/agents/$OTHER_WORKSPACE_AGENT_ID/runs"
expect 403 "foreign workspace path"

RLS_COUNT="$(run_sql -tA <<SQL | tr -d '[:space:]'
BEGIN;
SET LOCAL ROLE momo_app;
SET LOCAL app.workspace_id='$WS_ID';
SELECT count(*) FROM agent_run WHERE id='$RUN_OTHER_WORKSPACE';
ROLLBACK;
SQL
)"
[ "$RLS_COUNT" = "0" ] || fail "FORCE RLS cross-workspace invisibility count=$RLS_COUNT"
pass "foreign agent/workspace paths and FORCE RLS rows stay invisible"

# The channel list remains detail-shaped for existing clients, but all summary
# fields for the same Work run must equal the global projection byte-for-byte
# after UUID text normalization.
api "$ADMIN_TOKEN" GET \
  "/v1/workspaces/$WS_ID/channels/$GENERAL_CHANNEL_ID/agent-runs?type=work&limit=200"
expect 200 "channel run list comparison"
printf '%s' "$RESPONSE_BODY" >"$TMP_DIR/channel-page.json"
python3 - "$TMP_DIR/channel-page.json" "$TMP_DIR/page-two.json" "$(lower "$RUN_MIDDLE")" <<'PY'
import json
import sys

channel_page, global_page, run_id = sys.argv[1:]
with open(channel_page, encoding="utf-8") as file:
    channel_runs = json.load(file)["runs"]
with open(global_page, encoding="utf-8") as file:
    global_runs = json.load(file)["runs"]

def find(runs):
    return next(run for run in runs if run["id"].lower() == run_id)

keys = (
    "id", "channelId", "triggerMessageId", "triggerSummary", "status",
    "startedAtMs", "finishedAtMs", "createdAtMs", "updatedAtMs",
)

def summary(run):
    value = {key: run[key] for key in keys if key in run}
    for key in ("id", "channelId", "triggerMessageId"):
        if key in value:
            value[key] = value[key].lower()
    return value

if summary(find(channel_runs)) != summary(find(global_runs)):
    raise SystemExit(
        "[agent-run-history] FAIL channel/global same-run summary identity"
    )
PY
pass "channel and global lists report an identical summary for the same run"

echo "[agent-run-history] PASS pagination, membership, RLS, minimal projection, and list parity"

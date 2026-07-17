#!/usr/bin/env bash
# MOMO-468 / ADR-0122 V-1 huddle lifecycle runtime verifier.
# Docker execution belongs to momo-main; workers run bash -n only.
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

need() { command -v "$1" >/dev/null 2>&1 || { echo "[huddle] missing $1" >&2; exit 1; }; }
need docker
need curl
need jq
need uuidgen
PYTHON_BIN=""
for cand in python3.13 python3.12 python3.11 python3.10 python3; do
  if command -v "$cand" >/dev/null 2>&1 && "$cand" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then
    PYTHON_BIN="$cand"; break
  fi
done
[ -n "$PYTHON_BIN" ] || { echo "[huddle] missing python >= 3.10" >&2; exit 1; }

COMPOSE_FILE="$REPO_ROOT/infra/docker-compose.e2e.yml"
PROJECT="${HUDDLE_GATE_PROJECT:-momo468huddle}"
API_PORT="${HUDDLE_GATE_PORT:-19860}"
PG_PORT="${HUDDLE_GATE_POSTGRES_PORT:-19861}"
CENT_PORT_HOST="${HUDDLE_GATE_CENT_PORT:-19862}"
HERMES_PORT_HOST="${HUDDLE_GATE_HERMES_PORT:-19863}"
BOOT_TIMEOUT="${HUDDLE_GATE_BOOT_TIMEOUT:-2400}"
RUN_ID="$(date -u +%s)-$$"
TMP_DIR="${TMPDIR:-/tmp}/momo-huddle-$RUN_ID"
mkdir -p "$TMP_DIR"

LIVEKIT_API_KEY="huddle-gate-key"
LIVEKIT_API_SECRET="huddle-gate-secret-$RUN_ID"
LIVEKIT_URL="ws://127.0.0.1:7880"
COMPOSE_OVERRIDE="$TMP_DIR/livekit-env.yml"
cat >"$COMPOSE_OVERRIDE" <<YAML
services:
  api:
    environment:
      MOMO_LIVEKIT_API_KEY: "$LIVEKIT_API_KEY"
      MOMO_LIVEKIT_API_SECRET: "$LIVEKIT_API_SECRET"
      MOMO_LIVEKIT_URL: "$LIVEKIT_URL"
YAML

WS_A="00000000-0000-7000-8000-000000000001"
CH_A="00000000-0000-7000-8000-000000000201"
WS_B="46800000-0000-7000-8000-000000000001"
CH_B="46800000-0000-7000-8000-000000000201"
M1_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
M2_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
MB_ID="46800000-0000-7000-8000-000000000101"
M1_EMAIL="huddle-one-$RUN_ID@momo.local"
M2_EMAIL="huddle-two-$RUN_ID@momo.local"
M1_PASSWORD="huddle-$(uuidgen | tr '[:upper:]' '[:lower:]')"
M2_PASSWORD="huddle-$(uuidgen | tr '[:upper:]' '[:lower:]')"

compose() {
  PORT="$API_PORT" POSTGRES_PORT="$PG_PORT" CENT_PORT="$CENT_PORT_HOST" HERMES_PORT="$HERMES_PORT_HOST" \
    docker compose -p "$PROJECT" -f "$COMPOSE_FILE" -f "$COMPOSE_OVERRIDE" "$@"
}

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if [ "${HUDDLE_GATE_KEEP:-0}" = "1" ]; then
    echo "[huddle] leaving compose project '$PROJECT' up"
  else
    compose down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

BASE_URL="http://127.0.0.1:$API_PORT"
echo "[huddle] booting isolated api stack '$PROJECT' (LiveKit server not required)"
compose up -d api
deadline=$(( $(date -u +%s) + BOOT_TIMEOUT ))
until curl -fsS "$BASE_URL/health" >/dev/null 2>&1; do
  if [ "$(date -u +%s)" -ge "$deadline" ]; then
    compose logs --tail 120 api >&2 || true
    echo "[huddle] api health timeout" >&2
    exit 1
  fi
  if [ -n "$(compose ps -aq --status exited api 2>/dev/null)" ]; then
    compose logs --tail 120 api >&2 || true
    echo "[huddle] api exited" >&2
    exit 1
  fi
  sleep 3
done

run_sql() {
  compose exec -T postgres psql -U "${POSTGRES_USER:-momo}" -d "${POSTGRES_DB:-momo}" \
    -v ON_ERROR_STOP=1 --no-psqlrc -q "$@"
}
sql_scalar() { run_sql -tA | tr -d '[:space:]'; }

run_sql <<SQL
BEGIN;
SET LOCAL row_security = off;
INSERT INTO member (id, workspace_id, kind, status, display_name, handle)
VALUES
  ('$M1_ID', '$WS_A', 'human', 'active', 'Huddle One', 'huddle-one-$RUN_ID'),
  ('$M2_ID', '$WS_A', 'human', 'active', 'Huddle Two', 'huddle-two-$RUN_ID');
INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash, tz)
VALUES
  ('$M1_ID', '$WS_A', '$M1_EMAIL', true, momo_password_hash('$M1_PASSWORD'), 'UTC'),
  ('$M2_ID', '$WS_A', '$M2_EMAIL', true, momo_password_hash('$M2_PASSWORD'), 'UTC');
INSERT INTO membership (workspace_id, channel_id, member_id, role)
VALUES
  ('$WS_A', '$CH_A', '$M1_ID', 'member'),
  ('$WS_A', '$CH_A', '$M2_ID', 'member');

INSERT INTO workspace (id, slug, name)
VALUES ('$WS_B', 'momo-huddle-b-$RUN_ID', 'Huddle Gate B');
INSERT INTO member (id, workspace_id, kind, status, display_name, handle)
VALUES ('$MB_ID', '$WS_B', 'human', 'active', 'Huddle B', 'huddle-b-$RUN_ID');
INSERT INTO channel (id, workspace_id, kind, name, created_by)
VALUES ('$CH_B', '$WS_B', 'public', 'huddle-b-$RUN_ID', '$MB_ID');
INSERT INTO membership (workspace_id, channel_id, member_id, role)
VALUES ('$WS_B', '$CH_B', '$MB_ID', 'owner');
WITH hb AS (
  INSERT INTO huddle (workspace_id, channel_id, started_by)
  VALUES ('$WS_B', '$CH_B', '$MB_ID') RETURNING id
)
INSERT INTO huddle_participant (workspace_id, huddle_id, member_id)
SELECT '$WS_B', id, '$MB_ID' FROM hb;
COMMIT;
SQL

login() {
  curl -fsS -X POST "$BASE_URL/v1/auth/login" -H 'Content-Type: application/json' \
    --data "$(jq -cn --arg e "$1" --arg p "$2" --arg w "$WS_A" '{email:$e,password:$p,workspace:$w}')" \
    | jq -er '.accessToken'
}
M1_TOKEN="$(login "$M1_EMAIL" "$M1_PASSWORD")"
M2_TOKEN="$(login "$M2_EMAIL" "$M2_PASSWORD")"

RESPONSE_BODY=""
RESPONSE_STATUS=""
api() {
  local method="$1" path="$2" token="$3" out="$TMP_DIR/response.json"
  RESPONSE_STATUS="$(curl -sS -o "$out" -w '%{http_code}' -X "$method" \
    -H 'Content-Type: application/json' -H "Authorization: Bearer $token" "$BASE_URL$path")"
  RESPONSE_BODY="$(cat "$out")"
}
expect_status() {
  [ "$RESPONSE_STATUS" = "$1" ] || {
    echo "[huddle] FAIL $2: expected HTTP $1, got $RESPONSE_STATUS" >&2
    echo "$RESPONSE_BODY" >&2
    exit 1
  }
}

START_PATH="/v1/workspaces/$WS_A/channels/$CH_A/huddles"
ACTIVE_PATH="/v1/workspaces/$WS_A/channels/$CH_A/huddles/active"
api POST "$START_PATH" "$M1_TOKEN"
expect_status 201 "start"
HUDDLE_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.huddle.id' | tr '[:upper:]' '[:lower:]')"

api POST "$START_PATH" "$M1_TOKEN"
expect_status 200 "idempotent restart"
[ "$(printf '%s' "$RESPONSE_BODY" | jq -r '.huddle.id' | tr '[:upper:]' '[:lower:]')" = "$HUDDLE_ID" ] || {
  echo "[huddle] FAIL idempotent start returned another huddle" >&2; exit 1; }

api GET "$ACTIVE_PATH" "$M1_TOKEN"
expect_status 200 "active before join"
printf '%s' "$RESPONSE_BODY" | jq -e --arg id "$HUDDLE_ID" \
  '(.huddle.id | ascii_downcase) == $id and .huddle.participants == []' >/dev/null

JOIN_PATH="/v1/workspaces/$WS_A/huddles/$HUDDLE_ID/join"
LEAVE_PATH="/v1/workspaces/$WS_A/huddles/$HUDDLE_ID/leave"
api POST "$JOIN_PATH" "$M1_TOKEN"
expect_status 200 "first join"
printf '%s' "$RESPONSE_BODY" >"$TMP_DIR/join-one.json"
LIVEKIT_TEST_SECRET="$LIVEKIT_API_SECRET" LIVEKIT_TEST_KEY="$LIVEKIT_API_KEY" \
LIVEKIT_TEST_ROOM="$HUDDLE_ID" LIVEKIT_TEST_MEMBER="$M1_ID" \
"$PYTHON_BIN" - "$TMP_DIR/join-one.json" <<'PY'
import base64, hashlib, hmac, json, os, sys

with open(sys.argv[1], encoding="utf-8") as handle:
    response = json.load(handle)
token = response["token"]
header64, payload64, signature64 = token.split(".")
pad = lambda value: value + "=" * ((4 - len(value) % 4) % 4)
decode = lambda value: base64.urlsafe_b64decode(pad(value)).decode()
header = json.loads(decode(header64))
claims = json.loads(decode(payload64))
expected = hmac.new(
    os.environ["LIVEKIT_TEST_SECRET"].encode(),
    f"{header64}.{payload64}".encode(), hashlib.sha256,
).digest()
actual = base64.urlsafe_b64decode(pad(signature64))
assert hmac.compare_digest(actual, expected)
assert header == {"alg": "HS256", "typ": "JWT"}
assert claims["iss"] == os.environ["LIVEKIT_TEST_KEY"]
assert claims["sub"].lower() == os.environ["LIVEKIT_TEST_MEMBER"]
assert claims["name"] == "Huddle One"
assert claims["exp"] - claims["nbf"] == 600
assert claims["video"] == {
    "room": os.environ["LIVEKIT_TEST_ROOM"].upper(),
    "roomJoin": True, "canPublish": True, "canSubscribe": True,
}
assert response["ttlSeconds"] == 600
PY

api POST "$JOIN_PATH" "$M2_TOKEN"
expect_status 200 "second join"
printf '%s' "$RESPONSE_BODY" | jq -e '.huddle.participants | length == 2' >/dev/null

api POST "$LEAVE_PATH" "$M1_TOKEN"
expect_status 200 "individual leave"
printf '%s' "$RESPONSE_BODY" | jq -e '.ended == false and (.huddle.participants | length == 1)' >/dev/null
api GET "$ACTIVE_PATH" "$M2_TOKEN"
expect_status 200 "active after individual leave"
printf '%s' "$RESPONSE_BODY" | jq -e '.huddle.participants | length == 1' >/dev/null

api POST "$LEAVE_PATH" "$M2_TOKEN"
expect_status 200 "last leave"
printf '%s' "$RESPONSE_BODY" | jq -e '.ended == true and (.huddle.endedAtMs | type == "number")' >/dev/null
api GET "$ACTIVE_PATH" "$M2_TOKEN"
expect_status 200 "active after end"
printf '%s' "$RESPONSE_BODY" | jq -e '.huddle == null' >/dev/null

api POST "/v1/workspaces/$WS_B/huddles/$HUDDLE_ID/join" "$M1_TOKEN"
expect_status 403 "cross-workspace path scope"

got="$(printf "BEGIN; SET LOCAL ROLE momo_app; SET LOCAL app.workspace_id='$WS_A'; SELECT (SELECT count(*) FROM huddle WHERE workspace_id='$WS_B') || ':' || (SELECT count(*) FROM huddle_participant WHERE workspace_id='$WS_B'); COMMIT;\n" | sql_scalar)"
[ "$got" = "0:0" ] || { echo "[huddle] FAIL RLS isolation: $got" >&2; exit 1; }

got="$(printf "SELECT string_agg(event_type || ':' || event_count, ',' ORDER BY event_type) FROM (SELECT payload->'data'->>'type' event_type, count(*) event_count FROM outbox WHERE workspace_id='$WS_A' AND payload->'data'->'payload'->>'huddle_id' ILIKE '$HUDDLE_ID' GROUP BY 1) q;\n" | sql_scalar)"
[ "$got" = "huddle_ended:1,huddle_participants_changed:3,huddle_started:1" ] || {
  echo "[huddle] FAIL outbox events: $got" >&2; exit 1; }

got="$(printf "SELECT count(*) FROM audit_log WHERE workspace_id='$WS_A' AND target_id='$HUDDLE_ID' AND action IN ('huddle.started','huddle.joined','huddle.left');\n" | sql_scalar)"
[ "$got" = "5" ] || { echo "[huddle] FAIL audit rows: $got" >&2; exit 1; }

got="$(printf "SELECT count(*) FROM pg_class WHERE relname IN ('huddle','huddle_participant') AND relrowsecurity AND relforcerowsecurity;\n" | sql_scalar)"
[ "$got" = "2" ] || { echo "[huddle] FAIL FORCE RLS metadata: $got" >&2; exit 1; }

echo "MOMO-468 huddle lifecycle + LiveKit JWT + outbox/audit/RLS PASS"

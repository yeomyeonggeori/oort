#!/usr/bin/env bash
# MOMO-474 Drive archive attachment runtime verifier (stub only; no Google calls).
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

need() { command -v "$1" >/dev/null 2>&1 || { echo "[attachment] missing $1" >&2; exit 1; }; }
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
[ -n "$PYTHON_BIN" ] || { echo "[attachment] missing python >= 3.10" >&2; exit 1; }

COMPOSE_FILE="$REPO_ROOT/infra/docker-compose.e2e.yml"
PROJECT="${ATTACHMENT_GATE_PROJECT:-momo474attachment}"
API_PORT="${ATTACHMENT_GATE_PORT:-19870}"
PG_PORT="${ATTACHMENT_GATE_POSTGRES_PORT:-19871}"
CENT_PORT_HOST="${ATTACHMENT_GATE_CENT_PORT:-19872}"
HERMES_PORT_HOST="${ATTACHMENT_GATE_HERMES_PORT:-19873}"
BOOT_TIMEOUT="${ATTACHMENT_GATE_BOOT_TIMEOUT:-2400}"
RUN_ID="$(date -u +%s)-$$"
TMP_DIR="${TMPDIR:-/tmp}/momo-attachment-$RUN_ID"
mkdir -p "$TMP_DIR"

BASE_URL="http://127.0.0.1:$API_PORT"
COMPOSE_OVERRIDE="$TMP_DIR/drive-archive-stub.yml"
cat >"$COMPOSE_OVERRIDE" <<YAML
services:
  api:
    environment:
      MOMO_DRIVE_ARCHIVE_BACKEND: stub
      MOMO_DRIVE_ARCHIVE_STUB_BASE_URL: "$BASE_URL"
YAML

compose() {
  PORT="$API_PORT" POSTGRES_PORT="$PG_PORT" CENT_PORT="$CENT_PORT_HOST" HERMES_PORT="$HERMES_PORT_HOST" \
    docker compose -p "$PROJECT" -f "$COMPOSE_FILE" -f "$COMPOSE_OVERRIDE" "$@"
}

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if [ "${ATTACHMENT_GATE_KEEP:-0}" = "1" ]; then
    echo "[attachment] leaving compose project '$PROJECT' up"
  else
    compose down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

echo "[attachment] booting isolated stub-only API stack '$PROJECT'"
compose up -d api
deadline=$(( $(date -u +%s) + BOOT_TIMEOUT ))
until curl -fsS "$BASE_URL/health" >/dev/null 2>&1; do
  if [ "$(date -u +%s)" -ge "$deadline" ]; then
    compose logs --tail 120 api >&2 || true
    echo "[attachment] api health timeout" >&2
    exit 1
  fi
  if [ -n "$(compose ps -aq --status exited api 2>/dev/null)" ]; then
    compose logs --tail 120 api >&2 || true
    echo "[attachment] api exited" >&2
    exit 1
  fi
  sleep 3
done

run_sql() {
  compose exec -T postgres psql -U "${POSTGRES_USER:-momo}" -d "${POSTGRES_DB:-momo}" \
    -v ON_ERROR_STOP=1 --no-psqlrc -q "$@"
}
sql_scalar() { run_sql -tA | tr -d '[:space:]'; }

WS_A="00000000-0000-7000-8000-000000000001"
CH_A="00000000-0000-7000-8000-000000000201"
M1_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
M2_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
M1_EMAIL="attachment-one-$RUN_ID@momo.local"
M2_EMAIL="attachment-two-$RUN_ID@momo.local"
M1_PASSWORD="attachment-$(uuidgen | tr '[:upper:]' '[:lower:]')"
M2_PASSWORD="attachment-$(uuidgen | tr '[:upper:]' '[:lower:]')"

WS_B="47400000-0000-7000-8000-000000000001"
CH_B="47400000-0000-7000-8000-000000000201"
MB_ID="47400000-0000-7000-8000-000000000101"
AB_ID="47400000-0000-7000-8000-000000000301"

run_sql <<SQL
BEGIN;
SET LOCAL row_security = off;
INSERT INTO member (id, workspace_id, kind, status, display_name, handle)
VALUES
  ('$M1_ID', '$WS_A', 'human', 'active', 'Attachment One', 'attachment-one-$RUN_ID'),
  ('$M2_ID', '$WS_A', 'human', 'active', 'Attachment Two', 'attachment-two-$RUN_ID');
INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash, tz)
VALUES
  ('$M1_ID', '$WS_A', '$M1_EMAIL', true, momo_password_hash('$M1_PASSWORD'), 'UTC'),
  ('$M2_ID', '$WS_A', '$M2_EMAIL', true, momo_password_hash('$M2_PASSWORD'), 'UTC');
INSERT INTO membership (workspace_id, channel_id, member_id, role)
VALUES ('$WS_A', '$CH_A', '$M1_ID', 'member');

INSERT INTO workspace (id, slug, name)
VALUES ('$WS_B', 'momo-attachment-b-$RUN_ID', 'Attachment Gate B');
INSERT INTO member (id, workspace_id, kind, status, display_name, handle)
VALUES ('$MB_ID', '$WS_B', 'human', 'active', 'Attachment B', 'attachment-b-$RUN_ID');
INSERT INTO channel (id, workspace_id, kind, name, created_by)
VALUES ('$CH_B', '$WS_B', 'public', 'attachment-b-$RUN_ID', '$MB_ID');
INSERT INTO membership (workspace_id, channel_id, member_id, role)
VALUES ('$WS_B', '$CH_B', '$MB_ID', 'owner');
INSERT INTO attachment
  (id, workspace_id, channel_id, uploader_member_id, drive_file_id,
   name, mime, size_bytes, status)
VALUES
  ('$AB_ID', '$WS_B', '$CH_B', '$MB_ID', 'stub-cross-workspace',
   'hidden.txt', 'text/plain', 6, 'complete');
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
  local method="$1" path="$2" token="$3" body="${4:-}" out="$TMP_DIR/response"
  local args=(-sS -o "$out" -w '%{http_code}' -X "$method" -H "Authorization: Bearer $token")
  if [ -n "$body" ]; then
    args+=(-H 'Content-Type: application/json' --data "$body")
  fi
  RESPONSE_STATUS="$(curl "${args[@]}" "$BASE_URL$path")"
  RESPONSE_BODY="$(cat "$out")"
}
expect_status() {
  [ "$RESPONSE_STATUS" = "$1" ] || {
    echo "[attachment] FAIL $2: expected HTTP $1, got $RESPONSE_STATUS" >&2
    echo "$RESPONSE_BODY" >&2
    exit 1
  }
}

UPLOAD_PATH="/v1/workspaces/$WS_A/channels/$CH_A/attachments/uploads"
PAYLOAD="$TMP_DIR/payload.txt"
printf '%s' 'MOMO-474 stub payload' >"$PAYLOAD"
PAYLOAD_SIZE="$(wc -c <"$PAYLOAD" | tr -d '[:space:]')"
api POST "$UPLOAD_PATH" "$M1_TOKEN" \
  "$(jq -cn --arg n 'evidence.txt' --arg m 'text/plain' --argjson s "$PAYLOAD_SIZE" '{name:$n,mime:$m,size:$s}')"
expect_status 201 "create resumable session"
ATTACHMENT_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.id')"
UPLOAD_URL="$(printf '%s' "$RESPONSE_BODY" | jq -er '.uploadUrl')"
printf '%s' "$RESPONSE_BODY" | jq -e '.status == "pending"' >/dev/null
case "$UPLOAD_URL" in
  "$BASE_URL"/__momo_stub/drive/uploads/*) ;;
  *) echo "[attachment] FAIL unsafe/unexpected stub upload URL" >&2; exit 1 ;;
esac

status="$(curl -sS -o "$TMP_DIR/upload-response" -w '%{http_code}' -X PUT \
  -H 'Content-Type: text/plain' --data-binary "@$PAYLOAD" "$UPLOAD_URL")"
[ "$status" = "200" ] || { echo "[attachment] FAIL stub upload HTTP $status" >&2; exit 1; }

COMPLETE_PATH="/v1/workspaces/$WS_A/channels/$CH_A/attachments/$ATTACHMENT_ID/complete"
api POST "$COMPLETE_PATH" "$M1_TOKEN"
expect_status 200 "complete metadata verification"
printf '%s' "$RESPONSE_BODY" | jq -e '.status == "complete" and .mime == "text/plain"' >/dev/null

CLIENT_MSG_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
MESSAGE_PATH="/v1/workspaces/$WS_A/channels/$CH_A/messages"
api POST "$MESSAGE_PATH" "$M1_TOKEN" \
  "$(jq -cn --arg c "$CLIENT_MSG_ID" --arg a "$ATTACHMENT_ID" '{clientMsgId:$c,body:"attachment gate",attachmentIds:[$a]}')"
expect_status 201 "message attachment binding"
MESSAGE_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.id')"

CONTENT_PATH="/v1/workspaces/$WS_A/channels/$CH_A/attachments/$ATTACHMENT_ID/content"
status="$(curl -sS -o "$TMP_DIR/downloaded" -w '%{http_code}' \
  -H "Authorization: Bearer $M1_TOKEN" "$BASE_URL$CONTENT_PATH")"
[ "$status" = "200" ] || { echo "[attachment] FAIL content proxy HTTP $status" >&2; exit 1; }
cmp -s "$PAYLOAD" "$TMP_DIR/downloaded" || { echo "[attachment] FAIL content bytes" >&2; exit 1; }

api GET "$CONTENT_PATH" "$M2_TOKEN"
expect_status 403 "non-member content denial"

api POST "$UPLOAD_PATH" "$M1_TOKEN" \
  "$(jq -cn '{name:"abandoned.txt",mime:"text/plain",size:7}')"
expect_status 201 "abandoned pending session"
PENDING_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.id')"

got="$(printf "SELECT status || ':' || coalesce(message_id::text, 'null') FROM attachment WHERE id='$PENDING_ID';\n" | sql_scalar)"
[ "$got" = "pending:null" ] || { echo "[attachment] FAIL abandoned state: $got" >&2; exit 1; }
got="$(printf "SELECT message_id::text FROM attachment WHERE id='$ATTACHMENT_ID';\n" | sql_scalar | tr '[:upper:]' '[:lower:]')"
[ "$got" = "$(printf '%s' "$MESSAGE_ID" | tr '[:upper:]' '[:lower:]')" ] || {
  echo "[attachment] FAIL message binding: $got" >&2; exit 1; }

got="$(printf "SELECT count(*) FROM audit_log WHERE workspace_id='$WS_A' AND target_id IN ('$ATTACHMENT_ID','$PENDING_ID') AND action='attachment.upload_started';\n" | sql_scalar)"
[ "$got" = "2" ] || { echo "[attachment] FAIL upload audit count: $got" >&2; exit 1; }
got="$(printf "SELECT count(*) FROM audit_log WHERE workspace_id='$WS_A' AND target_id='$ATTACHMENT_ID' AND action IN ('attachment.upload_completed','attachment.message_linked');\n" | sql_scalar)"
[ "$got" = "2" ] || { echo "[attachment] FAIL complete/link audit count: $got" >&2; exit 1; }

got="$(printf "BEGIN; SET LOCAL ROLE momo_app; SET LOCAL app.workspace_id='$WS_A'; SELECT count(*) FROM attachment WHERE workspace_id='$WS_B'; COMMIT;\n" | sql_scalar)"
[ "$got" = "0" ] || { echo "[attachment] FAIL RLS isolation: $got" >&2; exit 1; }
got="$(printf "SELECT count(*) FROM pg_class WHERE relname='attachment' AND relrowsecurity AND relforcerowsecurity;\n" | sql_scalar)"
[ "$got" = "1" ] || { echo "[attachment] FAIL FORCE RLS metadata: $got" >&2; exit 1; }

api POST "$UPLOAD_PATH" "$M1_TOKEN" \
  "$(jq -cn '{name:"too-large.bin",mime:"application/octet-stream",size:104857601}')"
expect_status 413 "100 MB limit"

echo "MOMO-474 attachment resumable stub + complete + message link + content/RLS/audit PASS"

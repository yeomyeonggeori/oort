#!/usr/bin/env bash
# MOMO-474/482/521/638 attachment archive upload + receive projection verifier.
# Default is the existing Drive stub; ATTACHMENT_GATE_BACKEND=s3 adds MinIO.
set -euo pipefail
umask 077

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

need() { command -v "$1" >/dev/null 2>&1 || { echo "[attachment] missing $1" >&2; exit 1; }; }
need docker
need curl
need jq
PYTHON_BIN=""
for cand in python3.13 python3.12 python3.11 python3.10 python3; do
  if command -v "$cand" >/dev/null 2>&1 && "$cand" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then
    PYTHON_BIN="$cand"; break
  fi
done
[ -n "$PYTHON_BIN" ] || { echo "[attachment] missing python >= 3.10" >&2; exit 1; }
new_uuid() { "$PYTHON_BIN" -c 'import uuid; print(uuid.uuid4())'; }

COMPOSE_FILE="$REPO_ROOT/infra/docker-compose.e2e.yml"
PROJECT="${ATTACHMENT_GATE_PROJECT:-momo638attachment}"
BACKEND="${ATTACHMENT_GATE_BACKEND:-drive}"
API_PORT="${ATTACHMENT_GATE_PORT:-28370}"
PG_PORT="${ATTACHMENT_GATE_POSTGRES_PORT:-28371}"
CENT_PORT_HOST="${ATTACHMENT_GATE_CENT_PORT:-28372}"
HERMES_PORT_HOST="${ATTACHMENT_GATE_HERMES_PORT:-28373}"
MINIO_PORT_HOST="${ATTACHMENT_GATE_MINIO_PORT:-28374}"
LEGACY_UNIQUE_PROOF="${ATTACHMENT_GATE_LEGACY_UNIQUE_PROOF:-0}"
BOOT_TIMEOUT="${ATTACHMENT_GATE_BOOT_TIMEOUT:-2400}"
ASSERT_TIMEOUT="${ATTACHMENT_GATE_ASSERT_TIMEOUT:-240}"
RUN_ID="$(date -u +%s)-$$"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/momo-attachment.XXXXXX")"

case "$BACKEND" in
  drive|s3) ;;
  *) echo "[attachment] ATTACHMENT_GATE_BACKEND must be drive or s3" >&2; exit 1 ;;
esac

case "$LEGACY_UNIQUE_PROOF" in
  0|1) ;;
  *) echo "[attachment] ATTACHMENT_GATE_LEGACY_UNIQUE_PROOF must be 0 or 1" >&2; exit 1 ;;
esac

check_reserved_ports() {
  "$PYTHON_BIN" - "$API_PORT" "$PG_PORT" "$CENT_PORT_HOST" \
    "$HERMES_PORT_HOST" "$MINIO_PORT_HOST" <<'PY'
import socket
import sys

for raw in sys.argv[1:]:
    port = int(raw)
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.bind(("127.0.0.1", port))
    except OSError as exc:
        raise SystemExit(f"[attachment] reserved port {port} is unavailable: {exc}")
    finally:
        sock.close()
PY
}
check_reserved_ports

BASE_URL="http://127.0.0.1:$API_PORT"
CENT_API_URL="http://127.0.0.1:$CENT_PORT_HOST/api"
CENT_API_KEY="${CENT_API_KEY:-change-me-cent-api-key}"
COMPOSE_OVERRIDE="$TMP_DIR/archive-backend.yml"
COMPOSE_PROFILE_ARGS=()
S3_ACCESS_KEY="momo-minio-$RUN_ID"
S3_SECRET_KEY="$(new_uuid)$(new_uuid)"
if [ "$BACKEND" = "s3" ]; then
  COMPOSE_PROFILE_ARGS=(--profile s3)
  cat >"$COMPOSE_OVERRIDE" <<YAML
services:
  api:
    environment:
      MOMO_ARCHIVE_BACKEND: s3
      MOMO_S3_ENDPOINT: http://minio:9000
      MOMO_S3_REGION: us-east-1
      MOMO_S3_BUCKET: momo-attachments
      MOMO_S3_ACCESS_KEY: "$S3_ACCESS_KEY"
      MOMO_S3_SECRET_KEY: "$S3_SECRET_KEY"
      MOMO_S3_FORCE_PATH_STYLE: "1"
    depends_on:
      minio-init:
        condition: service_completed_successfully
YAML
else
  cat >"$COMPOSE_OVERRIDE" <<YAML
services:
  api:
    environment:
      MOMO_DRIVE_ARCHIVE_BACKEND: stub
      MOMO_DRIVE_ARCHIVE_STUB_BASE_URL: "$BASE_URL"
YAML
fi

compose() {
  PORT="$API_PORT" POSTGRES_PORT="$PG_PORT" CENT_PORT="$CENT_PORT_HOST" \
    HERMES_PORT="$HERMES_PORT_HOST" MINIO_PORT="$MINIO_PORT_HOST" \
    MOMO_S3_ACCESS_KEY="$S3_ACCESS_KEY" MOMO_S3_SECRET_KEY="$S3_SECRET_KEY" \
    docker compose -p "$PROJECT" -f "$COMPOSE_FILE" -f "$COMPOSE_OVERRIDE" \
      ${COMPOSE_PROFILE_ARGS[@]+"${COMPOSE_PROFILE_ARGS[@]}"} "$@"
}

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if [ "${ATTACHMENT_GATE_KEEP:-0}" = "1" ]; then
    echo "[attachment] leaving compose project '$PROJECT' up"
    echo "[attachment] temporary evidence: $TMP_DIR"
  else
    compose down -v --remove-orphans >/dev/null 2>&1 || true
    case "$TMP_DIR" in
      "${TMPDIR:-/tmp}"/momo-attachment.*) rm -r -- "$TMP_DIR" ;;
      *) echo "[attachment] refusing unexpected temp path: $TMP_DIR" >&2 ;;
    esac
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

echo "[attachment] booting isolated $BACKEND API/relay stack '$PROJECT' on $API_PORT-$MINIO_PORT_HOST"
compose up -d api relay
deadline=$(( $(date -u +%s) + BOOT_TIMEOUT ))
until curl -fsS "$BASE_URL/health" >/dev/null 2>&1; do
  if [ "$(date -u +%s)" -ge "$deadline" ]; then
    compose logs --tail 120 api relay >&2 || true
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

# MOMO-638: assert that migration 044 replaced the global identifier index with
# tenant-scoped uniqueness before creating a fixture that shares an identifier.
got="$(run_sql -tA <<'SQL'
SELECT i.indisunique::text || ':' || string_agg(a.attname, ',' ORDER BY index_key.ordinality)
  FROM pg_index i
  JOIN pg_class index_class ON index_class.oid = i.indexrelid
  JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS index_key(attnum, ordinality) ON true
  JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = index_key.attnum
 WHERE index_class.relname = 'attachment_workspace_drive_file_uniq'
 GROUP BY i.indisunique;
SQL
)"
[ "$got" = "true:workspace_id,drive_file_id" ] || {
  echo "[attachment] FAIL MOMO-638 workspace-scoped attachment index: $got" >&2
  exit 1
}
got="$(printf "SELECT count(*) FROM pg_class WHERE relkind = 'i' AND relname = 'attachment_drive_file_uniq';\n" | sql_scalar)"
[ "$got" = "0" ] || { echo "[attachment] FAIL legacy global attachment index remains" >&2; exit 1; }

# Red-proof mode is restricted to the disposable verifier database. It restores
# the pre-044 index shape so the cross-workspace fixture below must fail on its
# second insert. The trap removes this compose project and its volume afterward.
if [ "$LEGACY_UNIQUE_PROOF" = "1" ]; then
  echo "[attachment] MOMO-638 red proof: restoring legacy global unique index"
  run_sql <<'SQL'
DROP INDEX attachment_workspace_drive_file_uniq;
CREATE UNIQUE INDEX attachment_drive_file_uniq
  ON attachment (drive_file_id)
  WHERE drive_file_id IS NOT NULL;
SQL
fi

WS_A="00000000-0000-7000-8000-000000000001"
CH_A="00000000-0000-7000-8000-000000000201"
M1_ID="$(new_uuid)"
M2_ID="$(new_uuid)"
M1_EMAIL="attachment-one-$RUN_ID@momo.local"
M2_EMAIL="attachment-two-$RUN_ID@momo.local"
M1_PASSWORD="attachment-$(new_uuid)"
M2_PASSWORD="attachment-$(new_uuid)"

WS_B="47400000-0000-7000-8000-000000000001"
CH_B="47400000-0000-7000-8000-000000000201"
MB_ID="47400000-0000-7000-8000-000000000101"
AB_ID="47400000-0000-7000-8000-000000000301"
CROSS_WORKSPACE_ATTACHMENT_ID="$(new_uuid)"
CROSS_WORKSPACE_DRIVE_FILE_ID="stub-cross-workspace-$RUN_ID"

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
  ('$AB_ID', '$WS_B', '$CH_B', '$MB_ID', '$CROSS_WORKSPACE_DRIVE_FILE_ID',
   'hidden.txt', 'text/plain', 6, 'complete');
INSERT INTO attachment
  (id, workspace_id, channel_id, uploader_member_id, drive_file_id,
   name, mime, size_bytes, status)
VALUES
  ('$CROSS_WORKSPACE_ATTACHMENT_ID', '$WS_A', '$CH_A', '$M1_ID', '$CROSS_WORKSPACE_DRIVE_FILE_ID',
   'visible.txt', 'text/plain', 7, 'complete');
COMMIT;
SQL

got="$(printf "SELECT count(*) FROM attachment WHERE id IN ('%s', '%s');\n" "$AB_ID" "$CROSS_WORKSPACE_ATTACHMENT_ID" | sql_scalar)"
[ "$got" = "2" ] || { echo "[attachment] FAIL shared drive-file fixture rows: $got" >&2; exit 1; }

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
if [ "$BACKEND" = "s3" ]; then
  case "$UPLOAD_URL" in
    http://minio:9000/momo-attachments/*X-Amz-Signature=*) ;;
    *) echo "[attachment] FAIL unsafe/unexpected S3 upload URL" >&2; exit 1 ;;
  esac
  # api 컨테이너(swift 이미지)에는 curl이 없다 — 같은 네트워크의 mock-hermes(python)로 PUT.
  status="$(compose exec -T mock-hermes python3 -c '
import sys, urllib.request
data = sys.stdin.buffer.read()
req = urllib.request.Request(sys.argv[1], data=data, method="PUT",
                             headers={"Content-Type": "text/plain"})
try:
    with urllib.request.urlopen(req) as resp:
        print(resp.status, end="")
except urllib.error.HTTPError as e:
    print(e.code, end="")
' "$UPLOAD_URL" <"$PAYLOAD")"
else
  case "$UPLOAD_URL" in
    "$BASE_URL"/__momo_stub/drive/uploads/*) ;;
    *) echo "[attachment] FAIL unsafe/unexpected stub upload URL" >&2; exit 1 ;;
  esac
  status="$(curl -sS -o "$TMP_DIR/upload-response" -w '%{http_code}' -X PUT \
    -H 'Content-Type: text/plain' --data-binary "@$PAYLOAD" "$UPLOAD_URL")"
fi
[ "$status" = "200" ] || { echo "[attachment] FAIL stub upload HTTP $status" >&2; exit 1; }

COMPLETE_PATH="/v1/workspaces/$WS_A/channels/$CH_A/attachments/$ATTACHMENT_ID/complete"
api POST "$COMPLETE_PATH" "$M1_TOKEN"
expect_status 200 "complete metadata verification"
printf '%s' "$RESPONSE_BODY" | jq -e '.status == "complete" and .mime == "text/plain"' >/dev/null

CLIENT_MSG_ID="$(new_uuid)"
MESSAGE_PATH="/v1/workspaces/$WS_A/channels/$CH_A/messages"
api POST "$MESSAGE_PATH" "$M1_TOKEN" \
  "$(jq -cn --arg c "$CLIENT_MSG_ID" --arg a "$ATTACHMENT_ID" '{clientMsgId:$c,body:"attachment gate",attachmentIds:[$a]}')"
expect_status 201 "message attachment binding"
MESSAGE_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.id')"
MESSAGE_SEQ="$(printf '%s' "$RESPONSE_BODY" | jq -er '.seq')"
printf '%s' "$RESPONSE_BODY" | jq -e \
  --arg attachment "$(printf '%s' "$ATTACHMENT_ID" | tr '[:upper:]' '[:lower:]')" \
  --argjson size "$PAYLOAD_SIZE" '
    .attachments == [{
      id: $attachment,
      name: "evidence.txt",
      mime: "text/plain",
      sizeBytes: $size
    }]
    and (.attachments[0] | has("uploadUrl") | not)
  ' >/dev/null || {
  echo "[attachment] FAIL send response projection" >&2
  echo "$RESPONSE_BODY" >&2
  exit 1
}

CONTENT_PATH="/v1/workspaces/$WS_A/channels/$CH_A/attachments/$ATTACHMENT_ID/content"
if [ "$BACKEND" = "s3" ]; then
  status="$(curl -sS -D "$TMP_DIR/content-headers" -o /dev/null -w '%{http_code}' \
    -H "Authorization: Bearer $M1_TOKEN" "$BASE_URL$CONTENT_PATH")"
  [ "$status" = "307" ] || { echo "[attachment] FAIL content redirect HTTP $status" >&2; exit 1; }
  DOWNLOAD_URL="$(grep -i '^location:' "$TMP_DIR/content-headers" | head -1 | cut -d' ' -f2- | tr -d '\r')"
  case "$DOWNLOAD_URL" in
    http://minio:9000/momo-attachments/*X-Amz-Signature=*) ;;
    *) echo "[attachment] FAIL unsafe/unexpected S3 download URL" >&2; exit 1 ;;
  esac
  compose exec -T mock-hermes python3 -c '
import sys, urllib.request
with urllib.request.urlopen(sys.argv[1]) as resp:
    sys.stdout.buffer.write(resp.read())
' "$DOWNLOAD_URL" >"$TMP_DIR/downloaded"
else
  status="$(curl -sS -o "$TMP_DIR/downloaded" -w '%{http_code}' \
    -H "Authorization: Bearer $M1_TOKEN" "$BASE_URL$CONTENT_PATH")"
  [ "$status" = "200" ] || { echo "[attachment] FAIL content proxy HTTP $status" >&2; exit 1; }
fi
cmp -s "$PAYLOAD" "$TMP_DIR/downloaded" || { echo "[attachment] FAIL content bytes" >&2; exit 1; }

api GET "$CONTENT_PATH" "$M2_TOKEN"
expect_status 403 "non-member content denial"

api POST "$UPLOAD_PATH" "$M1_TOKEN" \
  "$(jq -cn '{name:"abandoned.txt",mime:"text/plain",size:7}')"
expect_status 201 "abandoned pending session"
PENDING_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.id')"

got="$(printf "SELECT status || ':' || coalesce(message_id::text, 'null') FROM attachment WHERE id='%s';\n" "$PENDING_ID" | sql_scalar)"
[ "$got" = "pending:null" ] || { echo "[attachment] FAIL abandoned state: $got" >&2; exit 1; }
got="$(printf "SELECT message_id::text FROM attachment WHERE id='%s';\n" "$ATTACHMENT_ID" | sql_scalar | tr '[:upper:]' '[:lower:]')"
[ "$got" = "$(printf '%s' "$MESSAGE_ID" | tr '[:upper:]' '[:lower:]')" ] || {
  echo "[attachment] FAIL message binding: $got" >&2; exit 1; }

got="$(printf "SELECT count(*) FROM audit_log WHERE workspace_id='%s' AND target_id IN ('%s','%s') AND action='attachment.upload_started';\n" "$WS_A" "$ATTACHMENT_ID" "$PENDING_ID" | sql_scalar)"
[ "$got" = "2" ] || { echo "[attachment] FAIL upload audit count: $got" >&2; exit 1; }
got="$(printf "SELECT count(*) FROM audit_log WHERE workspace_id='%s' AND target_id='%s' AND action IN ('attachment.upload_completed','attachment.message_linked');\n" "$WS_A" "$ATTACHMENT_ID" | sql_scalar)"
[ "$got" = "2" ] || { echo "[attachment] FAIL complete/link audit count: $got" >&2; exit 1; }

# Create a second upload row, then force pending/failed rows onto the message as
# database-level regression fixtures. The public write path correctly rejects
# these states; direct binding lets history prove it filters status as well as
# message_id instead of relying only on the write validation.
api POST "$UPLOAD_PATH" "$M1_TOKEN" \
  "$(jq -cn '{name:"failed.txt",mime:"text/plain",size:6}')"
expect_status 201 "failed projection fixture session"
FAILED_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.id')"
run_sql <<SQL
BEGIN;
SET LOCAL row_security = off;
UPDATE attachment SET message_id = '$MESSAGE_ID' WHERE id = '$PENDING_ID';
UPDATE attachment
   SET status = 'failed', message_id = '$MESSAGE_ID'
 WHERE id = '$FAILED_ID';
COMMIT;
SQL

assert_history_projection() {
  local path="$1" label="$2"
  api GET "$path" "$M1_TOKEN"
  expect_status 200 "$label"
  printf '%s' "$RESPONSE_BODY" | jq -e \
    --arg message "$(printf '%s' "$MESSAGE_ID" | tr '[:upper:]' '[:lower:]')" \
    --arg attachment "$(printf '%s' "$ATTACHMENT_ID" | tr '[:upper:]' '[:lower:]')" \
    --arg pending "$(printf '%s' "$PENDING_ID" | tr '[:upper:]' '[:lower:]')" \
    --arg failed "$(printf '%s' "$FAILED_ID" | tr '[:upper:]' '[:lower:]')" \
    --argjson size "$PAYLOAD_SIZE" '
      ([.messages[] | select((.id | ascii_downcase) == $message)] | first) as $message
      | ($message.attachments == [{
          id: $attachment,
          name: "evidence.txt",
          mime: "text/plain",
          sizeBytes: $size
        }])
        and (($message.attachments | map(.id | ascii_downcase) | index($pending)) == null)
        and (($message.attachments | map(.id | ascii_downcase) | index($failed)) == null)
        and ($message.attachments[0] | has("uploadUrl") | not)
    ' >/dev/null || {
    echo "[attachment] FAIL $label projection" >&2
    echo "$RESPONSE_BODY" >&2
    exit 1
  }
}

HISTORY_PATH="/v1/workspaces/$WS_A/channels/$CH_A/messages"
assert_history_projection "$HISTORY_PATH?limit=50" "head history attachment"
assert_history_projection "$HISTORY_PATH?before=$((MESSAGE_SEQ + 1))&limit=50" \
  "before history attachment"
assert_history_projection "$HISTORY_PATH?after=$((MESSAGE_SEQ - 1))&limit=50" \
  "after history attachment"

CENT_CHANNEL="ch:ws${WS_A}.${CH_A}"
MESSAGE_EVENT_OK=0
deadline=$(( $(date -u +%s) + ASSERT_TIMEOUT ))
while [ "$(date -u +%s)" -lt "$deadline" ]; do
  history="$(curl -fsS -H "X-API-Key: $CENT_API_KEY" \
    -H 'Content-Type: application/json' \
    -d "$(jq -cn --arg ch "$CENT_CHANNEL" '{channel:$ch,limit:100,reverse:true}')" \
    "$CENT_API_URL/history" 2>/dev/null || printf '{}')"
  matches="$(printf '%s' "$history" | jq -r \
    --arg message "$(printf '%s' "$MESSAGE_ID" | tr '[:upper:]' '[:lower:]')" \
    --arg attachment "$(printf '%s' "$ATTACHMENT_ID" | tr '[:upper:]' '[:lower:]')" \
    --arg pending "$(printf '%s' "$PENDING_ID" | tr '[:upper:]' '[:lower:]')" \
    --arg failed "$(printf '%s' "$FAILED_ID" | tr '[:upper:]' '[:lower:]')" \
    --argjson size "$PAYLOAD_SIZE" '
      [.result.publications[]?.data
       | select(.type == "message.new")
       | select(((.payload.id // "") | ascii_downcase) == $message)
       | select(.payload.attachments == [{
           id: $attachment,
           name: "evidence.txt",
           mime: "text/plain",
           sizeBytes: $size
         }])
       | select((.payload.attachments | map(.id | ascii_downcase) | index($pending)) == null)
       | select((.payload.attachments | map(.id | ascii_downcase) | index($failed)) == null)
       | select(.payload.attachments[0] | has("uploadUrl") | not)] | length
    ' 2>/dev/null || printf '0')"
  if [ "$matches" != "0" ]; then
    MESSAGE_EVENT_OK=1
    break
  fi
  sleep 1
done
[ "$MESSAGE_EVENT_OK" = "1" ] || {
  compose logs --tail 120 relay >&2 || true
  echo "[attachment] FAIL message.new attachment projection missing from Centrifugo history" >&2
  exit 1
}

got="$(printf "BEGIN; SET LOCAL ROLE momo_app; SET LOCAL app.workspace_id='%s'; SELECT count(*) FROM attachment WHERE workspace_id='%s'; COMMIT;\n" "$WS_A" "$WS_B" | sql_scalar)"
[ "$got" = "0" ] || { echo "[attachment] FAIL RLS isolation: $got" >&2; exit 1; }
got="$(run_sql -tA <<SQL | tr -d '[:space:]'
BEGIN;
SET LOCAL ROLE momo_app;
SET LOCAL app.workspace_id = '$WS_A';
SELECT
  (SELECT count(*) FROM attachment WHERE id = '$CROSS_WORKSPACE_ATTACHMENT_ID')::text
  || ':' ||
  (SELECT count(*) FROM attachment WHERE id = '$AB_ID')::text;
SET LOCAL app.workspace_id = '$WS_B';
SELECT
  (SELECT count(*) FROM attachment WHERE id = '$AB_ID')::text
  || ':' ||
  (SELECT count(*) FROM attachment WHERE id = '$CROSS_WORKSPACE_ATTACHMENT_ID')::text;
COMMIT;
SQL
)"
[ "$got" = "1:01:0" ] || {
  echo "[attachment] FAIL MOMO-638 cross-workspace shared drive-file isolation: $got" >&2
  exit 1
}
got="$(printf "SELECT count(*) FROM pg_class WHERE relname='attachment' AND relrowsecurity AND relforcerowsecurity;\n" | sql_scalar)"
[ "$got" = "1" ] || { echo "[attachment] FAIL FORCE RLS metadata: $got" >&2; exit 1; }

# Presigned URLs are response-only capabilities. Neither structured logs nor
# PostgreSQL ledgers may retain their query parameters or S3 credentials.
compose logs --no-color api relay >"$TMP_DIR/service.log"
run_sql -tA >"$TMP_DIR/ledger.txt" <<SQL
SELECT coalesce(string_agg(value, E'\n'), '')
  FROM (
    SELECT coalesce(drive_file_id, '') AS value FROM attachment
    UNION ALL
    SELECT coalesce(detail::text, '') FROM audit_log
    UNION ALL
    SELECT coalesce(payload::text, '') FROM outbox
  ) ledger;
SQL
for evidence in "$TMP_DIR/service.log" "$TMP_DIR/ledger.txt"; do
  if grep -F -e 'X-Amz-Signature' -e "$S3_ACCESS_KEY" -e "$S3_SECRET_KEY" "$evidence" >/dev/null; then
    echo "[attachment] FAIL capability URL or credential leaked into $(basename "$evidence")" >&2
    exit 1
  fi
done

api POST "$UPLOAD_PATH" "$M1_TOKEN" \
  "$(jq -cn '{name:"too-large.bin",mime:"application/octet-stream",size:104857601}')"
expect_status 413 "100 MB limit"

echo "MOMO-638/MOMO-521 $BACKEND attachment upload + tenant-scoped drive-file uniqueness + send/history/realtime + content/RLS/audit/redaction PASS"

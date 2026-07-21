#!/usr/bin/env bash
# MOMO-527 / ADR-0129 D3 isolated hybrid memory retrieval verifier.
# Docker execution belongs to the orchestrator; workers run static/Swift gates only.
set -euo pipefail
umask 077

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

for tool in docker curl jq uuidgen python3; do
  command -v "$tool" >/dev/null 2>&1 || { echo "[memory-search] missing $tool" >&2; exit 1; }
done

COMPOSE_FILE="$REPO_ROOT/infra/docker-compose.e2e.yml"
RUN_TAG="$(date -u +%s)-$$"
PROJECT="${MEMORY_SEARCH_PROJECT:-momo527search-$RUN_TAG}"
API_PORT="${MEMORY_SEARCH_API_PORT:-28090}"
CENT_PORT="${MEMORY_SEARCH_CENTRIFUGO_PORT:-28091}"
PG_PORT="${MEMORY_SEARCH_POSTGRES_PORT:-28092}"
HERMES_PORT="${MEMORY_SEARCH_HERMES_PORT:-28093}"
BOOT_TIMEOUT="${MEMORY_SEARCH_BOOT_TIMEOUT:-2400}"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/momo-memory-search.XXXXXX")"

compose() {
  PORT="$API_PORT" CENT_PORT="$CENT_PORT" POSTGRES_PORT="$PG_PORT" HERMES_PORT="$HERMES_PORT" \
    AGENT_PROVIDER_MODE=local-mock MEMORY_EXTRACTION_ENABLED=0 \
    MEMORY_EMBEDDING_ENABLED=1 MEMORY_EMBEDDING_POLL_INTERVAL_MS=100 \
    MEMORY_EMBEDDING_BATCH_SIZE=20 \
    docker compose -p "$PROJECT" -f "$COMPOSE_FILE" "$@"
}

if [ -n "$(compose ps -aq 2>/dev/null)" ]; then
  echo "[memory-search] compose project already exists: $PROJECT" >&2
  exit 1
fi
python3 - "$API_PORT" "$CENT_PORT" "$PG_PORT" "$HERMES_PORT" <<'PY'
import socket, sys
ports = [int(value) for value in sys.argv[1:]]
if len(ports) != len(set(ports)):
    raise SystemExit(f"[memory-search] reserved ports must be distinct: {ports}")
sockets = []
try:
    for port in ports:
        sock = socket.socket()
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 0)
        sock.bind(("127.0.0.1", port))
        sockets.append(sock)
except OSError as error:
    raise SystemExit(f"[memory-search] reserved port preflight failed: {error}")
finally:
    for sock in sockets:
        sock.close()
PY

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if [ "${MEMORY_SEARCH_KEEP:-0}" = "1" ]; then
    echo "[memory-search] leaving $PROJECT up; evidence $TMP_DIR"
  else
    compose down -v --remove-orphans >/dev/null 2>&1 || true
    case "$TMP_DIR" in
      "${TMPDIR:-/tmp}"/momo-memory-search.*) rm -r -- "$TMP_DIR" ;;
      *) echo "[memory-search] refusing unexpected cleanup path: $TMP_DIR" >&2 ;;
    esac
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

BASE_URL="http://127.0.0.1:$API_PORT"
WS_ID="00000000-0000-7000-8000-000000000001"
OTHER_WS_ID="00000000-0000-7000-8000-000000005270"
PASSWORD="memory-search-$(uuidgen | tr '[:upper:]' '[:lower:]')"

run_sql() {
  compose exec -T postgres psql -U "${POSTGRES_USER:-momo}" -d "${POSTGRES_DB:-momo}" \
    -v ON_ERROR_STOP=1 --no-psqlrc -q "$@"
}
sql_value() { run_sql -tA | tr -d '[:space:]'; }
run_app_sql() {
  compose exec -T -e PGPASSWORD=momo_app_dev_pw postgres \
    psql -U momo_app -d "${POSTGRES_DB:-momo}" -v ON_ERROR_STOP=1 --no-psqlrc -q "$@"
}
fail() { echo "[memory-search] FAIL $*" >&2; exit 1; }
pass() { echo "[memory-search] PASS $*"; }

echo "[memory-search] booting isolated API stack $PROJECT"
compose up -d api
deadline=$(( $(date -u +%s) + BOOT_TIMEOUT ))
until curl -fsS "$BASE_URL/health" >/dev/null 2>&1; do
  if [ "$(date -u +%s)" -ge "$deadline" ]; then
    compose logs --tail 180 api migrate db-roles >&2 || true
    fail "api health timeout"
  fi
  sleep 3
done

run_sql <<SQL
BEGIN;
SET LOCAL row_security = off;
UPDATE human SET password_hash=momo_password_hash('$PASSWORD')
 WHERE workspace_id='$WS_ID' AND email='demo@momo.local';
INSERT INTO workspace (id,slug,name)
VALUES ('$OTHER_WS_ID','m527-other-$RUN_TAG','MOMO-527 other tenant');
INSERT INTO memory_item (workspace_id,scope,kind,body,confidence,created_by_kind)
VALUES ('$OTHER_WS_ID','workspace','fact','foreign vector sentinel',1.0,'worker');
COMMIT;
SQL

# 시드에는 채널(…202)만 있고 메시지가 없다 — 소스 메시지는 API로 만든다
# (verify_memory_plane.sh와 동일 패턴).
SOURCE_CHANNEL_ID="00000000-0000-7000-8000-000000000202"
LOGIN_JSON="$(curl -fsS -X POST "$BASE_URL/v1/auth/login" \
  -H 'Content-Type: application/json' \
  --data "$(jq -cn --arg e 'demo@momo.local' --arg p "$PASSWORD" --arg w "$WS_ID" \
    '{email:$e,password:$p,workspace:$w}')")"
TOKEN="$(printf '%s' "$LOGIN_JSON" | jq -er '.accessToken')"
SOURCE_MESSAGE_ID="$(curl -fsS -X POST \
  "$BASE_URL/v1/workspaces/$WS_ID/channels/$SOURCE_CHANNEL_ID/messages" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  --data "$(jq -cn --arg c "$(uuidgen | tr '[:upper:]' '[:lower:]')" \
    '{clientMsgId:$c,type:"text",body:"memory search source marker"}')" \
  | jq -er '.id | ascii_downcase')"
[ -n "$SOURCE_MESSAGE_ID" ] || fail "demo source message is unavailable"
AGENT_ID="$(sql_value <<SQL
SELECT lower(id::text) FROM member
 WHERE workspace_id='$WS_ID' AND kind='agent' AND status='active'
 ORDER BY created_at, id LIMIT 1;
SQL
)"
[ -n "$AGENT_ID" ] || fail "demo agent is unavailable"

run_sql <<SQL
WITH inserted AS (
  INSERT INTO memory_item
    (workspace_id,scope,agent_member_id,kind,body,confidence,created_by_kind)
  VALUES
    ('$WS_ID','workspace',NULL,'fact','quarterly launch lighthouse',0.9,'worker'),
    ('$WS_ID','agent','$AGENT_ID','procedure','semantic only constellation',0.8,'worker')
  RETURNING id, workspace_id
)
INSERT INTO memory_source_ref (workspace_id,memory_id,message_id,channel_id)
SELECT workspace_id,id,'$SOURCE_MESSAGE_ID','$SOURCE_CHANNEL_ID' FROM inserted;
SQL

search() {
  curl -fsS "$BASE_URL/v1/workspaces/$WS_ID/memories/search?$1" \
    -H "Authorization: Bearer $TOKEN"
}

FTS_JSON="$(search 'q=quarterly%20launch&limit=10')"
printf '%s' "$FTS_JSON" | jq -e '
  .hits | length == 1 and .[0].ftsRank == 1
  and (.[0].vectorRank == null) and .[0].memory.body == "quarterly launch lighthouse"
' >/dev/null || fail "FTS-only hit contract failed"
pass "FTS-only retrieval includes rows with no embedding"

compose up -d worker
deadline=$(( $(date -u +%s) + 90 ))
while [ "$(sql_value <<SQL
SELECT count(*) FROM memory_item WHERE workspace_id='$WS_ID' AND embedding IS NOT NULL;
SQL
)" != "2" ]; do
  if [ "$(date -u +%s)" -ge "$deadline" ]; then
    compose logs --tail 160 worker >&2 || true
    fail "async mock embedding backfill timeout"
  fi
  sleep 1
done
pass "asynchronous deterministic mock embedder backfilled 384 dimensions"

VECTOR_JSON="$(search 'q=unmatched%20quasar&limit=10')"
printf '%s' "$VECTOR_JSON" | jq -e '
  .hits | length == 2 and all(.[]; .ftsRank == null and .vectorRank != null)
' >/dev/null || fail "vector-only retrieval contract failed"
pass "vector-only retrieval"

RRF_JSON="$(search 'q=quarterly%20launch&limit=10')"
printf '%s' "$RRF_JSON" | jq -e '
  .hits[0].memory.body == "quarterly launch lighthouse"
  and .hits[0].ftsRank != null and .hits[0].vectorRank != null
  and .hits[0].score > 0
' >/dev/null || fail "RRF fused ranking contract failed"
pass "RRF fuses lexical and semantic ranks"

SCOPE_JSON="$(search 'q=unmatched%20quasar&scope=agent&agent='"$AGENT_ID"'&limit=10')"
printf '%s' "$SCOPE_JSON" | jq -e '
  .hits | length == 1 and .[0].memory.scope == "agent"
' >/dev/null || fail "scope/agent filter failed"
pass "scope and agent filters"

visible_foreign="$(run_app_sql -tA <<SQL | tr -d '[:space:]'
BEGIN;
SET LOCAL app.workspace_id='$WS_ID';
SELECT count(*) FROM memory_item WHERE workspace_id='$OTHER_WS_ID';
ROLLBACK;
SQL
)"
[ "$visible_foreign" = "0" ] || fail "FORCE RLS leaked foreign memory rows"
pass "normal app role cannot retrieve cross-workspace memory"

rate_limited=0
attempt=1
while [ "$attempt" -le 31 ]; do
  status="$(curl -sS -o "$TMP_DIR/rate-$attempt.json" -w '%{http_code}' \
    "$BASE_URL/v1/workspaces/$WS_ID/memories/search?q=rate%20probe&limit=1" \
    -H "Authorization: Bearer $TOKEN")"
  if [ "$status" = "429" ]; then
    rate_limited=1
    break
  fi
  [ "$status" = "200" ] || fail "unexpected rate probe HTTP $status"
  attempt=$((attempt + 1))
done
[ "$rate_limited" = "1" ] || fail "search rate limit did not reject within 31 probes"
pass "dedicated per-member search rate limit"

echo "[memory-search] PASS MOMO-527 hybrid memory search runtime verifier"

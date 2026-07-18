#!/usr/bin/env bash
# MOMO-475 workspace message search runtime verifier.
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

need() { command -v "$1" >/dev/null 2>&1 || { echo "[workspace-search] missing $1" >&2; exit 1; }; }
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
[ -n "$PYTHON_BIN" ] || { echo "[workspace-search] missing python >= 3.10" >&2; exit 1; }

COMPOSE_FILE="$REPO_ROOT/infra/docker-compose.e2e.yml"
PROJECT="${WORKSPACE_SEARCH_PROJECT:-momo475search}"
API_PORT="${WORKSPACE_SEARCH_PORT:-19910}"
PG_PORT="${WORKSPACE_SEARCH_POSTGRES_PORT:-19911}"
CENT_PORT_HOST="${WORKSPACE_SEARCH_CENT_PORT:-19912}"
HERMES_PORT_HOST="${WORKSPACE_SEARCH_HERMES_PORT:-19913}"
BOOT_TIMEOUT="${WORKSPACE_SEARCH_BOOT_TIMEOUT:-2400}"
RUN_ID="$(date -u +%s)-$$"
TMP_DIR="${TMPDIR:-/tmp}/momo-workspace-search-$RUN_ID"
mkdir -p "$TMP_DIR"

WS_A="00000000-0000-7000-8000-000000000001"
WS_B="50000000-0000-7000-8000-000000000001"
CH_MEMBER="50000000-0000-7000-8000-000000000201"
CH_PRIVATE="50000000-0000-7000-8000-000000000202"
CH_DM="50000000-0000-7000-8000-000000000203"
CH_B="50000000-0000-7000-8000-000000000204"
SEARCH_MEMBER="$(uuidgen | tr '[:upper:]' '[:lower:]')"
RATE_MEMBER="$(uuidgen | tr '[:upper:]' '[:lower:]')"
AUTHOR_MEMBER="$(uuidgen | tr '[:upper:]' '[:lower:]')"
MEMBER_B="50000000-0000-7000-8000-000000000101"
SEARCH_EMAIL="search-$RUN_ID@momo.local"
RATE_EMAIL="search-rate-$RUN_ID@momo.local"
SEARCH_PASSWORD="search-$(uuidgen | tr '[:upper:]' '[:lower:]')"
RATE_PASSWORD="search-rate-$(uuidgen | tr '[:upper:]' '[:lower:]')"

compose() {
  PORT="$API_PORT" POSTGRES_PORT="$PG_PORT" CENT_PORT="$CENT_PORT_HOST" HERMES_PORT="$HERMES_PORT_HOST" \
    docker compose -p "$PROJECT" -f "$COMPOSE_FILE" "$@"
}

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if [ "${WORKSPACE_SEARCH_KEEP:-0}" = "1" ]; then
    echo "[workspace-search] leaving compose project '$PROJECT' up"
  else
    compose down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

BASE_URL="http://127.0.0.1:$API_PORT"
echo "[workspace-search] booting isolated api stack '$PROJECT'"
compose up -d api
deadline=$(( $(date -u +%s) + BOOT_TIMEOUT ))
until curl -fsS "$BASE_URL/health" >/dev/null 2>&1; do
  if [ "$(date -u +%s)" -ge "$deadline" ]; then
    compose logs --tail 120 api >&2 || true
    echo "[workspace-search] api health timeout" >&2
    exit 1
  fi
  if [ -n "$(compose ps -aq --status exited api 2>/dev/null)" ]; then
    compose logs --tail 120 api >&2 || true
    echo "[workspace-search] api exited" >&2
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
INSERT INTO workspace (id, slug, name)
VALUES ('$WS_B', 'momo-search-b-$RUN_ID', 'Search Gate B');

INSERT INTO member (id, workspace_id, kind, status, display_name, handle)
VALUES
  ('$SEARCH_MEMBER', '$WS_A', 'human', 'active', 'Search Member', 'search-$RUN_ID'),
  ('$RATE_MEMBER', '$WS_A', 'human', 'active', 'Rate Member', 'search-rate-$RUN_ID'),
  ('$AUTHOR_MEMBER', '$WS_A', 'human', 'active', 'Search Author', 'search-author-$RUN_ID'),
  ('$MEMBER_B', '$WS_B', 'human', 'active', 'Search B', 'search-b-$RUN_ID');
INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash, tz)
VALUES
  ('$SEARCH_MEMBER', '$WS_A', '$SEARCH_EMAIL', true, momo_password_hash('$SEARCH_PASSWORD'), 'UTC'),
  ('$RATE_MEMBER', '$WS_A', '$RATE_EMAIL', true, momo_password_hash('$RATE_PASSWORD'), 'UTC'),
  ('$AUTHOR_MEMBER', '$WS_A', 'search-author-$RUN_ID@momo.local', true, NULL, 'UTC'),
  ('$MEMBER_B', '$WS_B', 'search-b-$RUN_ID@momo.local', true, NULL, 'UTC');

INSERT INTO channel (id, workspace_id, kind, name, dm_key, created_by)
VALUES
  ('$CH_MEMBER', '$WS_A', 'public', 'search-member-$RUN_ID', NULL, '$SEARCH_MEMBER'),
  ('$CH_PRIVATE', '$WS_A', 'private', 'search-private-$RUN_ID', NULL, '$AUTHOR_MEMBER'),
  ('$CH_DM', '$WS_A', 'dm', NULL, 'search-dm-$RUN_ID', '$SEARCH_MEMBER'),
  ('$CH_B', '$WS_B', 'public', 'search-b-$RUN_ID', NULL, '$MEMBER_B');
INSERT INTO channel_seq (channel_id, workspace_id, last_seq)
VALUES
  ('$CH_MEMBER', '$WS_A', 20), ('$CH_PRIVATE', '$WS_A', 1),
  ('$CH_DM', '$WS_A', 1), ('$CH_B', '$WS_B', 1);
INSERT INTO membership (workspace_id, channel_id, member_id, role)
VALUES
  ('$WS_A', '$CH_MEMBER', '$SEARCH_MEMBER', 'member'),
  ('$WS_A', '$CH_MEMBER', '$RATE_MEMBER', 'member'),
  ('$WS_A', '$CH_MEMBER', '$AUTHOR_MEMBER', 'member'),
  ('$WS_A', '$CH_PRIVATE', '$AUTHOR_MEMBER', 'member'),
  ('$WS_A', '$CH_DM', '$SEARCH_MEMBER', 'member'),
  ('$WS_A', '$CH_DM', '$AUTHOR_MEMBER', 'member'),
  ('$WS_B', '$CH_B', '$MEMBER_B', 'owner');

INSERT INTO message
  (id, workspace_id, channel_id, seq, hlc_ts, hlc_count, author_member_id, type, body, deleted_at, created_at)
VALUES
  ('50000000-0000-7000-8000-000000000301', '$WS_A', '$CH_MEMBER', 1, 1, 0, '$AUTHOR_MEMBER', 'text',
   repeat('앞', 100) || ' Needle English searchable payload ' || repeat('뒤', 100), NULL, '2026-07-18 01:00:01+00'),
  ('50000000-0000-7000-8000-000000000302', '$WS_A', '$CH_MEMBER', 2, 2, 0, '$AUTHOR_MEMBER', 'text',
   '한글 English 혼합 검색 결과', NULL, '2026-07-18 01:00:02+00'),
  ('50000000-0000-7000-8000-000000000303', '$WS_A', '$CH_PRIVATE', 1, 3, 0, '$AUTHOR_MEMBER', 'text',
   'Needle private channel must never leak', NULL, '2026-07-18 01:00:03+00'),
  ('50000000-0000-7000-8000-000000000304', '$WS_A', '$CH_DM', 1, 4, 0, '$AUTHOR_MEMBER', 'text',
   'Needle direct message included', NULL, '2026-07-18 01:00:04+00'),
  ('50000000-0000-7000-8000-000000000305', '$WS_A', '$CH_MEMBER', 3, 5, 0, '$AUTHOR_MEMBER', 'text',
   'Needle deleted message excluded', now(), '2026-07-18 01:00:05+00'),
  ('50000000-0000-7000-8000-000000000306', '$WS_A', '$CH_MEMBER', 10, 10, 0, '$AUTHOR_MEMBER', 'text',
   'cursor-stable oldest', NULL, '2026-07-18 02:00:01+00'),
  ('50000000-0000-7000-8000-000000000307', '$WS_A', '$CH_MEMBER', 11, 11, 0, '$AUTHOR_MEMBER', 'text',
   'cursor-stable middle', NULL, '2026-07-18 02:00:02+00'),
  ('50000000-0000-7000-8000-000000000308', '$WS_A', '$CH_MEMBER', 12, 12, 0, '$AUTHOR_MEMBER', 'text',
   'cursor-stable newest', NULL, '2026-07-18 02:00:03+00'),
  ('50000000-0000-7000-8000-000000000309', '$WS_B', '$CH_B', 1, 13, 0, '$MEMBER_B', 'text',
   'Needle other workspace RLS secret', NULL, '2026-07-18 03:00:01+00');
COMMIT;
ANALYZE message;
SQL

login() {
  curl -fsS -X POST "$BASE_URL/v1/auth/login" -H 'Content-Type: application/json' \
    --data "$(jq -cn --arg e "$1" --arg p "$2" --arg w "$WS_A" '{email:$e,password:$p,workspace:$w}')" \
    | jq -er '.accessToken'
}
SEARCH_TOKEN="$(login "$SEARCH_EMAIL" "$SEARCH_PASSWORD")"
RATE_TOKEN="$(login "$RATE_EMAIL" "$RATE_PASSWORD")"

RESPONSE_STATUS=""
RESPONSE_BODY=""
search_api() {
  local token="$1" query="$2" limit="${3:-20}" cursor="${4:-}" out="$TMP_DIR/response.json"
  local -a args=(-sS -G -o "$out" -w '%{http_code}' -H "Authorization: Bearer $token"
    --data-urlencode "q=$query" --data-urlencode "limit=$limit")
  [ -n "$cursor" ] && args+=(--data-urlencode "cursor=$cursor")
  RESPONSE_STATUS="$(curl "${args[@]}" "$BASE_URL/v1/workspaces/$WS_A/search/messages")"
  RESPONSE_BODY="$(<"$out")"
}
expect_status() {
  [ "$RESPONSE_STATUS" = "$1" ] || {
    echo "[workspace-search] FAIL $2: expected HTTP $1, got $RESPONSE_STATUS" >&2
    echo "$RESPONSE_BODY" >&2
    exit 1
  }
}

search_api "$SEARCH_TOKEN" "N" 20
expect_status 400 "q minimum"

search_api "$SEARCH_TOKEN" "Needle" 20
expect_status 200 "membership-filtered search"
printf '%s' "$RESPONSE_BODY" >"$TMP_DIR/needle.json"
jq -e --arg member "$CH_MEMBER" --arg dm "$CH_DM" --arg private "$CH_PRIVATE" '
  (.hits | length) == 2
  and (.hits | map(.channelId) | sort) == ([$member, $dm] | sort)
  and (.hits | map(select(.channelId == $private)) | length) == 0
  and all(.hits[]; (.snippet | length) <= 166 and .matchOffset >= 0)
  and all(.hits[]; (keys | sort) == (["authorMemberId","channelId","createdAtMs","matchOffset","messageId","seq","snippet"] | sort))
' "$TMP_DIR/needle.json" >/dev/null

search_api "$SEARCH_TOKEN" "한글 English" 20
expect_status 200 "Korean/English mixed search"
printf '%s' "$RESPONSE_BODY" | jq -e '.hits | length == 1 and .[0].matchOffset == 0' >/dev/null

search_api "$SEARCH_TOKEN" "cursor-stable" 2
expect_status 200 "cursor first page"
printf '%s' "$RESPONSE_BODY" >"$TMP_DIR/page-one.json"
CURSOR="$(jq -er '.nextCursor' "$TMP_DIR/page-one.json")"
run_sql <<SQL
BEGIN;
SET LOCAL row_security = off;
INSERT INTO message
  (id, workspace_id, channel_id, seq, hlc_ts, hlc_count, author_member_id, type, body, created_at)
VALUES
  ('50000000-0000-7000-8000-000000000310', '$WS_A', '$CH_MEMBER', 20, 20, 0,
   '$AUTHOR_MEMBER', 'text', 'cursor-stable inserted later', '2026-07-18 02:00:04+00');
COMMIT;
SQL
search_api "$SEARCH_TOKEN" "cursor-stable" 2 "$CURSOR"
expect_status 200 "cursor second page after insert"
printf '%s' "$RESPONSE_BODY" >"$TMP_DIR/page-two.json"
"$PYTHON_BIN" - "$TMP_DIR/page-one.json" "$TMP_DIR/page-two.json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    first = json.load(handle)
with open(sys.argv[2], encoding="utf-8") as handle:
    second = json.load(handle)
ids = [hit["messageId"].lower() for page in (first, second) for hit in page["hits"]]
assert len(ids) == 3, ids
assert len(set(ids)) == 3, ids
assert "50000000-0000-7000-8000-000000000310" not in ids, ids
assert second.get("nextCursor") is None, second
PY

for _ in $(seq 1 30); do
  search_api "$RATE_TOKEN" "Needle" 1
  expect_status 200 "rate-limit allowed request"
done
search_api "$RATE_TOKEN" "Needle" 1
expect_status 429 "rate-limit rejection"

got="$(printf "BEGIN; SET LOCAL ROLE momo_app; SET LOCAL app.workspace_id='$WS_A'; SELECT count(*) FROM message WHERE workspace_id='$WS_B'; COMMIT;\n" | sql_scalar)"
[ "$got" = "0" ] || { echo "[workspace-search] FAIL RLS isolation: $got" >&2; exit 1; }

plan="$(run_sql -tA <<SQL
SET enable_seqscan = off;
EXPLAIN SELECT id FROM message
 WHERE deleted_at IS NULL AND body IS NOT NULL AND body ILIKE '%Needle%';
SQL
)"
printf '%s\n' "$plan" | grep -F 'message_body_trgm_idx' >/dev/null || {
  echo "[workspace-search] FAIL EXPLAIN did not use message_body_trgm_idx" >&2
  printf '%s\n' "$plan" >&2
  exit 1
}

echo "MOMO-475 workspace message search membership/DM/deletion/mixed-language/cursor/rate-limit/RLS/trgm PASS"

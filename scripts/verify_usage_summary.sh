#!/usr/bin/env bash
# =============================================================================
# scripts/verify_usage_summary.sh — MOMO-615 / AX-7 layer 1 runtime gate
#
# GET /v1/workspaces/{ws}/usage/summary against a real Postgres 18 + MomoServer
# stack (infra/docker-compose.e2e.yml). The gate seeds a deterministic
# usage_ledger fixture and asserts the response against hand-computed numbers:
#
#   1. workspace membership is required            (403 for a non-member human)
#   2. path workspace must equal the JWT workspace (403 cross-workspace)
#   3. range validation                            (400: bucket, from>to, >93d, junk)
#   4. empty period                                (200 + zero totals + budget null)
#   5. totals/byModel/byAgent aggregate exactly    (hand calculation)
#   6. bucket boundaries for day / week / month    (UTC, ISO week = Monday)
#   7. rows outside [from,to] are excluded
#   8. budget block: workspace grain + MIN(limit) adoption + soft_limit state
#   9. defaults: bucket=day, from=to-30d
#
# Ports default to the worktree compose env (.env.worktree -> .conductor/local.env)
# so parallel worktrees never collide. The stack is torn down with `down -v`.
#
# Environment:
#   USAGE_SUMMARY_PROJECT        compose project name (default: momo615usage)
#   USAGE_SUMMARY_API_PORT       API host port       (default: $PORT or 24650)
#   USAGE_SUMMARY_POSTGRES_PORT  Postgres host port  (default: $POSTGRES_PORT or 24652)
#   USAGE_SUMMARY_CENT_PORT      Centrifugo port     (default: $CENT_PORT or 24651)
#   USAGE_SUMMARY_HERMES_PORT    mock-hermes port    (default: $HERMES_PORT or 24653)
#   USAGE_SUMMARY_BOOT_TIMEOUT   seconds to wait for /health (default: 2400 —
#                                the api container cold-builds Swift)
#   USAGE_SUMMARY_KEEP=1         keep the stack up after the run
#   USAGE_SUMMARY_REUSE=1        reuse an already-running stack (skip `up`)
# =============================================================================
set -euo pipefail
umask 077

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

for tool in docker curl jq python3; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "[usage-summary] missing required command: $tool" >&2
    exit 1
  }
done

# Worktree compose env: ports + credentials live in .conductor/local.env.
for candidate in "$REPO_ROOT/.env.worktree" "$REPO_ROOT/.conductor/local.env" "$REPO_ROOT/.env"; do
  if [ -f "$candidate" ]; then
    set -a
    # shellcheck disable=SC1090
    . "$candidate"
    set +a
    echo "[usage-summary] compose env: $candidate"
    break
  fi
done

COMPOSE_FILE="$REPO_ROOT/infra/docker-compose.e2e.yml"
PROJECT="${USAGE_SUMMARY_PROJECT:-momo615usage}"
API_PORT="${USAGE_SUMMARY_API_PORT:-${PORT:-24650}}"
CENT_PORT_HOST="${USAGE_SUMMARY_CENT_PORT:-${CENT_PORT:-24651}}"
PG_PORT="${USAGE_SUMMARY_POSTGRES_PORT:-${POSTGRES_PORT:-24652}}"
HERMES_PORT_HOST="${USAGE_SUMMARY_HERMES_PORT:-${HERMES_PORT:-24653}}"
BOOT_TIMEOUT="${USAGE_SUMMARY_BOOT_TIMEOUT:-2400}"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/momo-usage-summary.XXXXXX")"
BASE_URL="http://127.0.0.1:$API_PORT"

compose() {
  PORT="$API_PORT" CENT_PORT="$CENT_PORT_HOST" POSTGRES_PORT="$PG_PORT" \
    HERMES_PORT="$HERMES_PORT_HOST" \
    docker compose -p "$PROJECT" -f "$COMPOSE_FILE" "$@"
}

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if [ "${USAGE_SUMMARY_KEEP:-0}" = "1" ]; then
    echo "[usage-summary] leaving compose project '$PROJECT' up; evidence $TMP_DIR"
  else
    compose down -v --remove-orphans >/dev/null 2>&1 || true
    case "$TMP_DIR" in
      "${TMPDIR:-/tmp}"/momo-usage-summary.*) rm -r -- "$TMP_DIR" ;;
      *) echo "[usage-summary] refusing unexpected cleanup path: $TMP_DIR" >&2 ;;
    esac
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

fail() { echo "[usage-summary] FAIL $*" >&2; exit 1; }
pass() { echo "[usage-summary] PASS $*"; }

run_sql() {
  compose exec -T postgres psql -U "${POSTGRES_USER:-momo}" -d "${POSTGRES_DB:-momo}" \
    -v ON_ERROR_STOP=1 --no-psqlrc -q "$@"
}
sql_value() { run_sql -tA | tr -d '[:space:]'; }

# ---- fixture identities -----------------------------------------------------
WS_ID="00000000-0000-7000-8000-000000000001"           # seeded demo workspace
WS2_ID="61500000-0000-7000-8000-000000000002"          # empty-period workspace
AGENT_A="61500000-0000-7000-8000-000000000901"
AGENT_B="61500000-0000-7000-8000-000000000902"
READER_ID="61500000-0000-7000-8000-000000000801"
OUTSIDER_ID="61500000-0000-7000-8000-000000000802"
WS2_HUMAN_ID="61500000-0000-7000-8000-000000000803"
RUN_TAG="$(date -u +%s)-$$"
READER_EMAIL="usage-reader-$RUN_TAG@momo.local"
OUTSIDER_EMAIL="usage-outsider-$RUN_TAG@momo.local"
WS2_EMAIL="usage-ws2-$RUN_TAG@momo.local"
FIXTURE_PASSWORD="usage-615-$RUN_TAG"

# ---- window + hand-computed expectations -----------------------------------
# 2026-07-01 is a Wednesday, so the ISO week containing 2026-07-05 (Sunday)
# starts 2026-06-29 while 2026-07-06 (Monday) opens its own week. The
# 23:59:59Z / 00:00:00Z pair therefore splits both the day and the week bucket.
FROM="2026-07-01T00:00:00Z"
TO="2026-07-31T00:00:00Z"
EXPECT_COST=186000        # 40000 + 80000 + 45000 + 21000
EXPECT_ESTIMATED=66000    # 45000 + 21000 (was_estimated rows)
EXPECT_PROMPT=6100        # 1000 + 3000 + 1500 + 600
EXPECT_COMPLETION=1210    #  200 +  600 +  300 + 110

if [ "${USAGE_SUMMARY_REUSE:-0}" = "1" ]; then
  echo "[usage-summary] reusing running stack $PROJECT on $BASE_URL"
else
  python3 - "$API_PORT" "$CENT_PORT_HOST" "$PG_PORT" "$HERMES_PORT_HOST" <<'PY'
import socket, sys
ports = [int(value) for value in sys.argv[1:]]
if len(ports) != len(set(ports)):
    raise SystemExit(f"[usage-summary] reserved ports must be distinct: {ports}")
PY
  echo "[usage-summary] booting isolated API stack $PROJECT (api cold build can take minutes)"
  compose up -d api
  # Recreate the api container so it always re-copies and rebuilds the current
  # worktree source (a warm container from a previous run would serve stale code).
  compose up -d --force-recreate --no-deps api
fi

deadline=$(( $(date -u +%s) + BOOT_TIMEOUT ))
until curl -fsS "$BASE_URL/health" >/dev/null 2>&1; do
  if [ "$(date -u +%s)" -ge "$deadline" ]; then
    compose logs --tail 200 api migrate db-roles >&2 || true
    fail "api health timeout on $BASE_URL"
  fi
  sleep 3
done
echo "[usage-summary] api health green on $BASE_URL"

# ---- seed -------------------------------------------------------------------
echo "[usage-summary] seeding usage_ledger fixture"
run_sql >/dev/null <<SQL
INSERT INTO workspace (id, slug, name)
VALUES ('$WS2_ID', 'usage-615-empty', 'MOMO-615 Empty Workspace')
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;

INSERT INTO member (id, workspace_id, kind, status, display_name, handle)
VALUES
  ('$AGENT_A', '$WS_ID', 'agent', 'active', 'Usage Agent A', 'usage-agent-a-$RUN_TAG'),
  ('$AGENT_B', '$WS_ID', 'agent', 'active', 'Usage Agent B', 'usage-agent-b-$RUN_TAG'),
  ('$READER_ID', '$WS_ID', 'human', 'active', 'Usage Reader', 'usage-reader-$RUN_TAG'),
  ('$OUTSIDER_ID', '$WS_ID', 'human', 'active', 'Usage Outsider', 'usage-outsider-$RUN_TAG'),
  ('$WS2_HUMAN_ID', '$WS2_ID', 'human', 'active', 'Usage WS2 Human', 'usage-ws2-$RUN_TAG')
ON CONFLICT (id) DO UPDATE
SET display_name = EXCLUDED.display_name, status = EXCLUDED.status;

INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash, tz)
VALUES
  ('$READER_ID', '$WS_ID', '$READER_EMAIL', true,
   momo_password_hash('$FIXTURE_PASSWORD'), 'UTC'),
  ('$OUTSIDER_ID', '$WS_ID', '$OUTSIDER_EMAIL', true,
   momo_password_hash('$FIXTURE_PASSWORD'), 'UTC'),
  ('$WS2_HUMAN_ID', '$WS2_ID', '$WS2_EMAIL', true,
   momo_password_hash('$FIXTURE_PASSWORD'), 'UTC')
ON CONFLICT (member_id) DO UPDATE
SET email = EXCLUDED.email, password_hash = EXCLUDED.password_hash;

-- The outsider deliberately has NO workspace_membership row (403 case).
INSERT INTO workspace_membership (workspace_id, member_id, role)
VALUES ('$WS_ID', '$READER_ID', 'member'),
       ('$WS2_ID', '$WS2_HUMAN_ID', 'owner')
ON CONFLICT (workspace_id, member_id) DO UPDATE SET role = EXCLUDED.role;

DELETE FROM usage_ledger WHERE agent_member_id IN ('$AGENT_A', '$AGENT_B');
INSERT INTO usage_ledger
  (workspace_id, agent_member_id, model, prompt_tokens, completion_tokens,
   cost_micro_usd, was_estimated, created_at)
VALUES
  -- in-window rows (hand calculation above)
  ('$WS_ID', '$AGENT_A', 'hermes-default', 1000, 200, 40000, false,
   '2026-07-05T23:59:59Z'),
  ('$WS_ID', '$AGENT_A', 'hermes-default', 3000, 600, 80000, false,
   '2026-07-06T00:00:00Z'),
  ('$WS_ID', '$AGENT_B', 'hermes-lite',    1500, 300, 45000, true,
   '2026-07-06T12:00:00Z'),
  ('$WS_ID', '$AGENT_B', 'hermes-lite',     600, 110, 21000, true,
   '2026-07-13T00:00:00Z'),
  -- out-of-window rows: must never appear in any aggregate
  ('$WS_ID', '$AGENT_A', 'hermes-default', 9999, 9999, 999999, false,
   '2026-06-30T23:59:59Z'),
  ('$WS_ID', '$AGENT_A', 'hermes-default', 9999, 9999, 999999, false,
   '2026-07-31T00:00:01Z');

DELETE FROM budget_window WHERE budget_id IN (
  SELECT id FROM budget WHERE workspace_id IN ('$WS_ID', '$WS2_ID')
);
DELETE FROM budget WHERE workspace_id IN ('$WS_ID', '$WS2_ID');
INSERT INTO budget (id, workspace_id, grain, agent_member_id, limit_micro_usd,
                    period_seconds, soft_limit_micro_usd)
VALUES
  -- tightest workspace-grain budget: MIN(limit) must adopt this one
  ('61500000-0000-7000-8000-000000000701', '$WS_ID', 'workspace', NULL, 200000, 86400, 150000),
  -- looser workspace-grain budget: must lose the MIN(limit) race
  ('61500000-0000-7000-8000-000000000702', '$WS_ID', 'workspace', NULL, 500000, 86400, 400000),
  -- agent-grain budget: must never be adopted by the workspace summary
  ('61500000-0000-7000-8000-000000000703', '$WS_ID', 'agent', '$AGENT_A', 1000, 86400, 500);

INSERT INTO budget_window (budget_id, workspace_id, period_start,
                           reserved_micro_usd, spent_micro_usd)
VALUES ('61500000-0000-7000-8000-000000000701', '$WS_ID',
        to_timestamp(floor(extract(epoch from now()) / 86400) * 86400),
        0, $EXPECT_COST);
SQL

LEDGER_ROWS="$(sql_value <<SQL
SELECT count(*) FROM usage_ledger
 WHERE workspace_id='$WS_ID' AND agent_member_id IN ('$AGENT_A','$AGENT_B');
SQL
)"
[ "$LEDGER_ROWS" = "6" ] || fail "expected 6 seeded ledger rows, got $LEDGER_ROWS"
pass "seeded 6 usage_ledger rows (4 in window, 2 outside)"

# ---- HTTP helpers -----------------------------------------------------------
login() {
  curl -fsS -X POST "$BASE_URL/v1/auth/login" -H 'Content-Type: application/json' \
    --data "$(jq -cn --arg e "$1" --arg p "$FIXTURE_PASSWORD" --arg w "$2" \
      '{email:$e,password:$p,workspace:$w}')" | jq -er '.accessToken'
}

summary_status() { # <token> <ws> <query>
  curl -sS -o "$TMP_DIR/body.json" -w '%{http_code}' \
    -H "Authorization: Bearer $1" \
    "$BASE_URL/v1/workspaces/$2/usage/summary$3"
}

expect_status() { # <expected> <token> <ws> <query> <label>
  local got
  got="$(summary_status "$2" "$3" "$4")"
  if [ "$got" != "$1" ]; then
    echo "[usage-summary] response: $(cat "$TMP_DIR/body.json")" >&2
    fail "$5: expected HTTP $1, got $got"
  fi
  pass "$5 ($1)"
}

expect_jq() { # <filter> <label>
  jq -e "$1" "$TMP_DIR/body.json" >/dev/null 2>&1 || {
    echo "[usage-summary] response: $(cat "$TMP_DIR/body.json")" >&2
    fail "$2"
  }
  pass "$2"
}

READER_TOKEN="$(login "$READER_EMAIL" "$WS_ID")"
OUTSIDER_TOKEN="$(login "$OUTSIDER_EMAIL" "$WS_ID")"
WS2_TOKEN="$(login "$WS2_EMAIL" "$WS2_ID")"

# ---- 1/2. authorization -----------------------------------------------------
expect_status 403 "$OUTSIDER_TOKEN" "$WS_ID" "" \
  "human without workspace_membership is refused"
expect_status 403 "$WS2_TOKEN" "$WS_ID" "" \
  "cross-workspace token cannot read another workspace path"
ANON_STATUS="$(curl -sS -o /dev/null -w '%{http_code}' \
  "$BASE_URL/v1/workspaces/$WS_ID/usage/summary")"
[ "$ANON_STATUS" = "401" ] || fail "unauthenticated read expected 401, got $ANON_STATUS"
pass "unauthenticated read is refused (401)"

# ---- 3. range validation ----------------------------------------------------
expect_status 400 "$READER_TOKEN" "$WS_ID" "?bucket=hour" "bucket=hour rejected"
expect_status 400 "$READER_TOKEN" "$WS_ID" \
  "?from=2026-07-02T00:00:00Z&to=2026-07-01T00:00:00Z" "from later than to rejected"
expect_status 400 "$READER_TOKEN" "$WS_ID" \
  "?from=2026-01-01T00:00:00Z&to=2026-07-01T00:00:01Z" "range over 93 days rejected"
expect_status 400 "$READER_TOKEN" "$WS_ID" "?from=yesterday" \
  "non-ISO8601 from rejected"

# ---- 4. empty period --------------------------------------------------------
expect_status 200 "$WS2_TOKEN" "$WS2_ID" "?from=$FROM&to=$TO&bucket=day" \
  "empty period is 200, not 404"
expect_jq '.totals.costMicroUsd == 0 and .totals.estimatedMicroUsd == 0
           and .totals.promptTokens == 0 and .totals.completionTokens == 0
           and (.buckets | length) == 0 and (.byModel | length) == 0
           and (.byAgent | length) == 0 and (has("budget")) and .budget == null' \
  "empty period returns zero totals, empty arrays, and budget null"

# ---- 5. totals / byModel / byAgent ------------------------------------------
expect_status 200 "$READER_TOKEN" "$WS_ID" "?from=$FROM&to=$TO&bucket=day" \
  "member reads the workspace summary"
expect_jq ".range.from == \"$FROM\" and .range.to == \"$TO\" and .range.bucket == \"day\"" \
  "range echoes the requested window"
expect_jq ".totals.costMicroUsd == $EXPECT_COST
           and .totals.estimatedMicroUsd == $EXPECT_ESTIMATED
           and .totals.promptTokens == $EXPECT_PROMPT
           and .totals.completionTokens == $EXPECT_COMPLETION" \
  "totals match the hand calculation (cost=$EXPECT_COST est=$EXPECT_ESTIMATED)"
expect_jq '[.byModel[] | {model, costMicroUsd, promptTokens, completionTokens}]
           == [{model:"hermes-default",costMicroUsd:120000,promptTokens:4000,completionTokens:800},
               {model:"hermes-lite",costMicroUsd:66000,promptTokens:2100,completionTokens:410}]' \
  "byModel aggregates exactly and sorts by cost descending"
expect_jq "[.byAgent[] | {agentMemberId, displayName, costMicroUsd, promptTokens, completionTokens}]
           == [{agentMemberId:\"$AGENT_A\",displayName:\"Usage Agent A\",
                costMicroUsd:120000,promptTokens:4000,completionTokens:800},
               {agentMemberId:\"$AGENT_B\",displayName:\"Usage Agent B\",
                costMicroUsd:66000,promptTokens:2100,completionTokens:410}]" \
  "byAgent aggregates exactly with lowercase uuids and display names"
expect_jq '([.buckets[].costMicroUsd] | add) == .totals.costMicroUsd
           and ([.byModel[].costMicroUsd] | add) == .totals.costMicroUsd
           and ([.byAgent[].costMicroUsd] | add) == .totals.costMicroUsd' \
  "every breakdown sums back to totals"

# ---- 6/7. bucket boundaries + range filter ----------------------------------
expect_jq '[.buckets[] | {start, costMicroUsd, promptTokens, completionTokens}]
           == [{start:"2026-07-05T00:00:00Z",costMicroUsd:40000,promptTokens:1000,completionTokens:200},
               {start:"2026-07-06T00:00:00Z",costMicroUsd:125000,promptTokens:4500,completionTokens:900},
               {start:"2026-07-13T00:00:00Z",costMicroUsd:21000,promptTokens:600,completionTokens:110}]' \
  "day buckets split the 23:59:59Z / 00:00:00Z pair in UTC"
expect_jq '[.buckets[].costMicroUsd] | add == 186000' \
  "rows at 2026-06-30T23:59:59Z and 2026-07-31T00:00:01Z are outside the window"

expect_status 200 "$READER_TOKEN" "$WS_ID" "?from=$FROM&to=$TO&bucket=week" \
  "week bucket read"
expect_jq '[.buckets[] | {start, costMicroUsd}]
           == [{start:"2026-06-29T00:00:00Z",costMicroUsd:40000},
               {start:"2026-07-06T00:00:00Z",costMicroUsd:125000},
               {start:"2026-07-13T00:00:00Z",costMicroUsd:21000}]' \
  "week buckets start on ISO Monday (2026-07-05 rolls back to 2026-06-29)"

expect_status 200 "$READER_TOKEN" "$WS_ID" "?from=$FROM&to=$TO&bucket=month" \
  "month bucket read"
expect_jq '[.buckets[] | {start, costMicroUsd, promptTokens, completionTokens}]
           == [{start:"2026-07-01T00:00:00Z",costMicroUsd:186000,
                promptTokens:6100,completionTokens:1210}]' \
  "month bucket collapses the whole window into one row"

# ---- 8. budget --------------------------------------------------------------
TODAY_PERIOD="$(sql_value <<SQL
SELECT to_char(to_timestamp(floor(extract(epoch from now()) / 86400) * 86400)
                 AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
SQL
)"
expect_status 200 "$READER_TOKEN" "$WS_ID" "?from=$FROM&to=$TO" "budget read"
expect_jq ".budget.grain == \"workspace\" and .budget.limitMicroUsd == 200000
           and .budget.spentMicroUsd == $EXPECT_COST and .budget.reservedMicroUsd == 0
           and .budget.state == \"soft_limit\"
           and .budget.periodStart == \"$TODAY_PERIOD\"" \
  "budget adopts MIN(limit) workspace grain (200000, not 500000/1000) with soft_limit state"

# hard_limit transition on the same adopted budget row.
run_sql >/dev/null <<SQL
UPDATE budget_window SET spent_micro_usd = 200000
 WHERE budget_id = '61500000-0000-7000-8000-000000000701';
SQL
expect_status 200 "$READER_TOKEN" "$WS_ID" "?from=$FROM&to=$TO" "budget re-read"
expect_jq '.budget.state == "hard_limit" and .budget.spentMicroUsd == 200000' \
  "spent at the adopted limit flips state to hard_limit"
run_sql >/dev/null <<SQL
UPDATE budget_window SET spent_micro_usd = $EXPECT_COST
 WHERE budget_id = '61500000-0000-7000-8000-000000000701';
SQL

# ---- 9. defaults ------------------------------------------------------------
expect_status 200 "$READER_TOKEN" "$WS_ID" "" "default window read"
expect_jq '.range.bucket == "day"' "bucket defaults to day"
python3 - "$TMP_DIR/body.json" <<'PY'
import datetime, json, sys
payload = json.load(open(sys.argv[1], encoding="utf-8"))
parse = lambda v: datetime.datetime.strptime(v, "%Y-%m-%dT%H:%M:%SZ")
span = parse(payload["range"]["to"]) - parse(payload["range"]["from"])
if span != datetime.timedelta(days=30):
    raise SystemExit(f"[usage-summary] FAIL default lookback is {span}, expected 30 days")
PY
pass "from defaults to to-30d"

echo "[usage-summary] PASS workspace usage summary REST runtime gate (MOMO-615)"

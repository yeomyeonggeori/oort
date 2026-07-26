#!/usr/bin/env bash
# =============================================================================
# scripts/verify_quota_snapshot.sh — MOMO-623 / ADR-0135 D2 runtime gate
#
# POST + GET /v1/provider/quota-snapshots against a real Postgres 18 +
# MomoServer stack (infra/docker-compose.e2e.yml), plus the worker-side static
# gate (migration presence, schema_v0 untouched, swift build, focused units).
#
# Runtime assertions:
#   1. adapter credential convention — an agent bearer carrying
#      `provider:quota:write` ingests; the same route rejects an agent bearer
#      without the scope (403), a human JWT (403), and no credential (401).
#   2. ADR-0004 schema policing — credential-shaped FIELDS (authorization /
#      bearer / apiKey / accessToken) and credential-shaped VALUES (sk-… ,
#      "Bearer …", a momo agent bearer, a JWT) are 400 and never reach the table.
#   3. numbers/timestamps only — ratio outside 0..1, a quoted ratio, an unknown
#      window, and a junk timestamp are all 400.
#   4. latest-only upsert — one row per (provider_ref, window); a NEWER probe
#      replaces the gauge (applied:true), an OLDER/replayed probe is retained
#      (applied:false) and does not regress the stored ratio.
#   5. GET is a workspace-member read (usage/summary convention) — a member gets
#      the gauges, a non-member gets 403, an agent bearer cannot read at all.
#   6. RLS FORCE — quota_snapshot default-denies an unscoped session, opens for
#      SELECT under app.workspace_id, and only accepts writes under
#      app.provider_quota_admin.
#
# Ports default to the worktree compose env (.env.worktree -> .conductor/local.env)
# so parallel worktrees never collide. The stack is torn down with `down -v`.
#
# Environment:
#   QUOTA_SNAPSHOT_PROJECT        compose project name (default: momo623quota)
#   QUOTA_SNAPSHOT_API_PORT       API host port       (default: $PORT or 24660)
#   QUOTA_SNAPSHOT_POSTGRES_PORT  Postgres host port  (default: $POSTGRES_PORT or 24662)
#   QUOTA_SNAPSHOT_CENT_PORT      Centrifugo port     (default: $CENT_PORT or 24661)
#   QUOTA_SNAPSHOT_HERMES_PORT    mock-hermes port    (default: $HERMES_PORT or 24663)
#   QUOTA_SNAPSHOT_BOOT_TIMEOUT   seconds to wait for /health (default: 2400 —
#                                 the api container cold-builds Swift)
#   QUOTA_SNAPSHOT_KEEP=1         keep the stack up after the run
#   QUOTA_SNAPSHOT_REUSE=1        reuse an already-running stack (skip `up`)
#   QUOTA_SNAPSHOT_RUN_DOCKER=0   run only the static worker gate
# =============================================================================
set -euo pipefail
umask 077

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

log() { echo "[quota-snapshot] $*"; }
fail() { echo "[quota-snapshot] FAIL $*" >&2; exit 1; }
pass() { echo "[quota-snapshot] PASS $*"; }

# =============================================================================
# Worker gate — migration presence, schema_v0 invariant, build + focused units.
# =============================================================================
MIGRATION="server/Migrations/043_quota_snapshot.sql"
test -f "$MIGRATION" || fail "missing migration $MIGRATION"
grep -q "CREATE TABLE quota_snapshot" "$MIGRATION" || fail "043 does not create quota_snapshot"
grep -q "FORCE ROW LEVEL SECURITY" "$MIGRATION" || fail "043 must FORCE row level security"
grep -q "PRIMARY KEY (provider_ref, quota_window)" "$MIGRATION" \
  || fail "043 must key the gauge on (provider_ref, quota_window)"
if git -C "$REPO_ROOT" diff --name-only HEAD 2>/dev/null | grep -qx "schema_v0.sql"; then
  fail "schema_v0.sql must not be modified"
fi
"$REPO_ROOT/scripts/check_migration_numbers.sh" "$REPO_ROOT/server/Migrations" >/dev/null \
  || fail "duplicate migration number prefix"

command -v swift >/dev/null 2>&1 || fail "missing swift toolchain"
log "swift build (server)"
swift build --package-path server >/dev/null
log "swift test --filter ProviderQuotaSnapshotTests (server)"
swift test --package-path server --filter ProviderQuotaSnapshotTests >/dev/null
pass "worker gate: 043 present, schema_v0 untouched, build + ingest unit tests green"

if [ "${QUOTA_SNAPSHOT_RUN_DOCKER:-1}" != "1" ]; then
  log "runtime-unverified: live REST/RLS smoke skipped (QUOTA_SNAPSHOT_RUN_DOCKER=0)"
  exit 0
fi

# =============================================================================
# Runtime gate — real compose PG18 + api.
# =============================================================================
for tool in docker curl jq python3; do
  command -v "$tool" >/dev/null 2>&1 || fail "missing required command: $tool"
done

for candidate in "$REPO_ROOT/.env.worktree" "$REPO_ROOT/.conductor/local.env" "$REPO_ROOT/.env"; do
  if [ -f "$candidate" ]; then
    set -a
    # shellcheck disable=SC1090
    . "$candidate"
    set +a
    log "compose env: $candidate"
    break
  fi
done

COMPOSE_FILE="$REPO_ROOT/infra/docker-compose.e2e.yml"
PROJECT="${QUOTA_SNAPSHOT_PROJECT:-momo623quota}"
API_PORT="${QUOTA_SNAPSHOT_API_PORT:-${PORT:-24660}}"
CENT_PORT_HOST="${QUOTA_SNAPSHOT_CENT_PORT:-${CENT_PORT:-24661}}"
PG_PORT="${QUOTA_SNAPSHOT_POSTGRES_PORT:-${POSTGRES_PORT:-24662}}"
HERMES_PORT_HOST="${QUOTA_SNAPSHOT_HERMES_PORT:-${HERMES_PORT:-24663}}"
BOOT_TIMEOUT="${QUOTA_SNAPSHOT_BOOT_TIMEOUT:-2400}"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/momo-quota-snapshot.XXXXXX")"
BASE_URL="http://127.0.0.1:$API_PORT"

compose() {
  PORT="$API_PORT" CENT_PORT="$CENT_PORT_HOST" POSTGRES_PORT="$PG_PORT" \
    HERMES_PORT="$HERMES_PORT_HOST" \
    docker compose -p "$PROJECT" -f "$COMPOSE_FILE" "$@"
}

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if [ "${QUOTA_SNAPSHOT_KEEP:-0}" = "1" ]; then
    log "leaving compose project '$PROJECT' up; evidence $TMP_DIR"
  else
    compose down -v --remove-orphans >/dev/null 2>&1 || true
    case "$TMP_DIR" in
      "${TMPDIR:-/tmp}"/momo-quota-snapshot.*) rm -r -- "$TMP_DIR" ;;
      *) echo "[quota-snapshot] refusing unexpected cleanup path: $TMP_DIR" >&2 ;;
    esac
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# ---- fixture identities -----------------------------------------------------
WS_ID="00000000-0000-7000-8000-000000000001"          # seeded demo workspace
PROBE_AGENT="62300000-0000-7000-8000-000000000901"    # holds provider:quota:write
PLAIN_AGENT="62300000-0000-7000-8000-000000000902"    # no ingest scope
READER_ID="62300000-0000-7000-8000-000000000801"      # workspace member
OUTSIDER_ID="62300000-0000-7000-8000-000000000802"    # no workspace_membership row
RUN_TAG="$(date -u +%s)-$$"
READER_EMAIL="quota-reader-$RUN_TAG@momo.local"
OUTSIDER_EMAIL="quota-outsider-$RUN_TAG@momo.local"
FIXTURE_PASSWORD="quota-623-$RUN_TAG"

new_secret() { python3 -c 'import base64,os;print(base64.urlsafe_b64encode(os.urandom(32)).decode().rstrip("="))'; }
PROBE_TOKEN="momo_agent_v1.$WS_ID.$(new_secret)"
PLAIN_TOKEN="momo_agent_v1.$WS_ID.$(new_secret)"

# The credential-shaped value the ingest must refuse — distinctive so any leak
# into the table or the api log is unambiguous.
TOKEN_SHAPED="sk-momo623-verifier-MUST-NOT-PERSIST-7Q2Z"

if [ "${QUOTA_SNAPSHOT_REUSE:-0}" = "1" ]; then
  log "reusing running stack $PROJECT on $BASE_URL"
else
  python3 - "$API_PORT" "$CENT_PORT_HOST" "$PG_PORT" "$HERMES_PORT_HOST" <<'PY'
import socket, sys
ports = [int(value) for value in sys.argv[1:]]
if len(ports) != len(set(ports)):
    raise SystemExit(f"[quota-snapshot] reserved ports must be distinct: {ports}")
PY
  # The api container copies the read-only source mount with `cp -Rp`. A
  # host-side `.build/` (the worker gate above just ran a local swift build)
  # holds symlinks Linux `cp` cannot read, which aborts api boot before /health.
  # The container builds fresh in its own scratch volume, so drop them.
  for build_dir in \
    "$REPO_ROOT/server/.build" \
    "$REPO_ROOT/services/OutboundHTTPPolicy/.build" \
    "$REPO_ROOT/services/MomoMetrics/.build"; do
    rm -rf "$build_dir" 2>/dev/null || true
  done

  log "booting isolated API stack $PROJECT on ${API_PORT}/${PG_PORT}/${CENT_PORT_HOST}/${HERMES_PORT_HOST} (api cold build can take minutes)"
  compose up -d api
  # Force-recreate so the api always rebuilds the CURRENT worktree source; a warm
  # container from a previous run would serve stale code.
  compose up -d --force-recreate --no-deps api
fi

deadline=$(( $(date -u +%s) + BOOT_TIMEOUT ))
until curl -fsS "$BASE_URL/health" >/dev/null 2>&1; do
  if [ "$(date -u +%s)" -ge "$deadline" ]; then
    compose logs --tail 200 api migrate db-roles >&2 || true
    fail "api health timeout on $BASE_URL"
  fi
  if [ -n "$(compose ps -aq --status exited api 2>/dev/null)" ]; then
    compose logs --tail 200 api migrate >&2 || true
    fail "api exited before health"
  fi
  sleep 3
done
log "api health green on $BASE_URL"

run_sql() {
  compose exec -T postgres psql -U "${POSTGRES_USER:-momo}" -d "${POSTGRES_DB:-momo}" \
    -v ON_ERROR_STOP=1 --no-psqlrc -q "$@"
}
sql_value() { run_sql -tA | tr -d '[:space:]'; }

# ---- migration 043 actually applied ----------------------------------------
APPLIED="$(sql_value <<'SQL'
SELECT count(*) FROM schema_migrations WHERE version LIKE '043_%';
SQL
)"
[ "$APPLIED" = "1" ] || fail "migration 043 not recorded in schema_migrations (got $APPLIED)"
FORCE_RLS="$(sql_value <<'SQL'
SELECT count(*) FROM pg_class
 WHERE relname='quota_snapshot' AND relrowsecurity AND relforcerowsecurity;
SQL
)"
[ "$FORCE_RLS" = "1" ] || fail "quota_snapshot must be ENABLE+FORCE row level security"
pass "migration 043 applied; quota_snapshot has FORCE RLS"

# ---- seed the adapter credential + the reader/outsider humans ---------------
log "seeding agent bearers and workspace humans"
run_sql >/dev/null <<SQL
INSERT INTO member (id, workspace_id, kind, status, display_name, handle)
VALUES
  ('$PROBE_AGENT', '$WS_ID', 'agent', 'active', 'Quota Probe Agent', 'quota-probe-$RUN_TAG'),
  ('$PLAIN_AGENT', '$WS_ID', 'agent', 'active', 'Plain Agent', 'quota-plain-$RUN_TAG'),
  ('$READER_ID', '$WS_ID', 'human', 'active', 'Quota Reader', 'quota-reader-$RUN_TAG'),
  ('$OUTSIDER_ID', '$WS_ID', 'human', 'active', 'Quota Outsider', 'quota-outsider-$RUN_TAG')
ON CONFLICT (id) DO UPDATE
SET display_name = EXCLUDED.display_name, status = EXCLUDED.status;

INSERT INTO agent (member_id, workspace_id, model, base_url)
VALUES
  ('$PROBE_AGENT', '$WS_ID', 'hermes-agent', 'https://provider.example.test/v1'),
  ('$PLAIN_AGENT', '$WS_ID', 'hermes-agent', 'https://provider.example.test/v1')
ON CONFLICT (member_id) DO UPDATE SET model = EXCLUDED.model;

INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash, tz)
VALUES
  ('$READER_ID', '$WS_ID', '$READER_EMAIL', true,
   momo_password_hash('$FIXTURE_PASSWORD'), 'UTC'),
  ('$OUTSIDER_ID', '$WS_ID', '$OUTSIDER_EMAIL', true,
   momo_password_hash('$FIXTURE_PASSWORD'), 'UTC')
ON CONFLICT (member_id) DO UPDATE
SET email = EXCLUDED.email, password_hash = EXCLUDED.password_hash;

-- The outsider deliberately has NO workspace_membership row (403 read case).
INSERT INTO workspace_membership (workspace_id, member_id, role)
VALUES ('$WS_ID', '$READER_ID', 'member')
ON CONFLICT (workspace_id, member_id) DO UPDATE SET role = EXCLUDED.role;

-- Adapter credential: the ONLY one carrying provider:quota:write.
DELETE FROM token WHERE actor_member_id IN ('$PROBE_AGENT', '$PLAIN_AGENT');
INSERT INTO token (workspace_id, kind, actor_member_id, token_hash, scopes, label)
VALUES
  ('$WS_ID', 'agent_bearer', '$PROBE_AGENT',
   digest('$PROBE_TOKEN', 'sha256'),
   ARRAY['provider:quota:write']::text[], 'quota probe adapter'),
  ('$WS_ID', 'agent_bearer', '$PLAIN_AGENT',
   digest('$PLAIN_TOKEN', 'sha256'),
   ARRAY['messages:write','agent:runs:callback']::text[], 'plain agent');

DELETE FROM quota_snapshot;
SQL

# ---- HTTP helpers -----------------------------------------------------------
RESPONSE_BODY=""
RESPONSE_STATUS=""
api() {
  local method="$1" path="$2" token="$3" body="${4:-}" out="$TMP_DIR/response"
  local args=(-sS -o "$out" -w '%{http_code}' --max-time 30 -X "$method")
  if [ -n "$token" ]; then args+=(-H "Authorization: Bearer $token"); fi
  if [ -n "$body" ]; then
    args+=(-H 'Content-Type: application/json' --data "$body")
  fi
  RESPONSE_STATUS="$(curl "${args[@]}" "$BASE_URL$path")"
  RESPONSE_BODY="$(cat "$out")"
}
expect_status() {
  [ "$RESPONSE_STATUS" = "$1" ] || {
    echo "$RESPONSE_BODY" >&2
    fail "$2: expected HTTP $1, got $RESPONSE_STATUS"
  }
}

login() {
  curl -fsS -X POST "$BASE_URL/v1/auth/login" -H 'Content-Type: application/json' \
    --data "$(jq -cn --arg e "$1" --arg p "$FIXTURE_PASSWORD" --arg w "$WS_ID" \
      '{email:$e,password:$p,workspace:$w}')" | jq -er '.accessToken'
}
READER_TOKEN="$(login "$READER_EMAIL")"
OUTSIDER_TOKEN="$(login "$OUTSIDER_EMAIL")"
[ -n "$READER_TOKEN" ] && [ -n "$OUTSIDER_TOKEN" ] || fail "login did not return tokens"

INGEST_PATH="/v1/provider/quota-snapshots"
NOW_ISO="$(python3 -c 'import datetime;print(datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))')"
OLDER_ISO="$(python3 -c 'import datetime;print((datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(hours=2)).strftime("%Y-%m-%dT%H:%M:%SZ"))')"
NEWER_ISO="$(python3 -c 'import datetime;print((datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(minutes=1)).strftime("%Y-%m-%dT%H:%M:%SZ"))')"
RESET_ISO="$(python3 -c 'import datetime;print((datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(hours=5)).strftime("%Y-%m-%dT%H:%M:%SZ"))')"

snapshot_body() {
  jq -cn --arg ref "$1" --arg win "$2" --argjson ratio "$3" \
    --arg probed "$4" --arg reset "$RESET_ISO" \
    '{providerRef:$ref,window:$win,remainingRatio:$ratio,resetsAt:$reset,probedAt:$probed}'
}

# ---- 1. authentication: only an agent bearer with the ingest scope ----------
api POST "$INGEST_PATH" "" "$(snapshot_body codex short 0.6 "$OLDER_ISO")"
expect_status 401 "anonymous ingest"
api POST "$INGEST_PATH" "$PLAIN_TOKEN" "$(snapshot_body codex short 0.6 "$OLDER_ISO")"
expect_status 403 "agent bearer without provider:quota:write"
api POST "$INGEST_PATH" "$READER_TOKEN" "$(snapshot_body codex short 0.6 "$OLDER_ISO")"
expect_status 403 "human JWT ingest"
pass "ingest requires an agent bearer carrying provider:quota:write (401/403/403)"

# ---- 2. ADR-0004: credential-shaped fields and values are refused -----------
reject() {
  api POST "$INGEST_PATH" "$PROBE_TOKEN" "$2"
  expect_status 400 "$1"
}
reject "authorization field" \
  "$(jq -c --arg t "$TOKEN_SHAPED" '. + {authorization:$t}' <<<"$(snapshot_body codex short 0.6 "$OLDER_ISO")")"
reject "bearer field" \
  "$(jq -c --arg t "$TOKEN_SHAPED" '. + {bearer:$t}' <<<"$(snapshot_body codex short 0.6 "$OLDER_ISO")")"
reject "apiKey field" \
  "$(jq -c --arg t "$TOKEN_SHAPED" '. + {apiKey:$t}' <<<"$(snapshot_body codex short 0.6 "$OLDER_ISO")")"
reject "accessToken field" \
  "$(jq -c --arg t "$TOKEN_SHAPED" '. + {accessToken:$t}' <<<"$(snapshot_body codex short 0.6 "$OLDER_ISO")")"
reject "token-shaped providerRef (sk-)" "$(snapshot_body "$TOKEN_SHAPED" short 0.6 "$OLDER_ISO")"
reject "token-shaped providerRef (bearer prefix)" \
  "$(jq -cn --arg probed "$OLDER_ISO" \
     '{providerRef:"Bearer abc123",window:"short",remainingRatio:0.6,probedAt:$probed}')"
reject "token-shaped providerRef (momo agent bearer)" \
  "$(jq -cn --arg ref "$PROBE_TOKEN" --arg probed "$OLDER_ISO" \
     '{providerRef:$ref,window:"short",remainingRatio:0.6,probedAt:$probed}')"
reject "token-shaped providerRef (jwt)" \
  "$(jq -cn --arg probed "$OLDER_ISO" \
     '{providerRef:"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",window:"short",remainingRatio:0.6,probedAt:$probed}')"
pass "credential-shaped fields and values rejected with 400 (ADR-0004 비유입)"

# ---- 3. numbers/timestamps only ---------------------------------------------
reject "ratio above 1" "$(snapshot_body codex short 1.5 "$OLDER_ISO")"
reject "ratio below 0" "$(snapshot_body codex short -0.1 "$OLDER_ISO")"
reject "quoted ratio" \
  "$(jq -cn --arg probed "$OLDER_ISO" \
     '{providerRef:"codex",window:"short",remainingRatio:"0.6",probedAt:$probed}')"
reject "unknown window" "$(snapshot_body codex daily 0.6 "$OLDER_ISO")"
reject "junk probedAt" "$(snapshot_body codex short 0.6 "yesterday")"
reject "unknown field" \
  "$(jq -c '. + {providerHint:"codex"}' <<<"$(snapshot_body codex short 0.6 "$OLDER_ISO")")"
pass "schema policing: out-of-range ratio, quoted ratio, unknown window/field, junk timestamp all 400"

ROWS="$(sql_value <<'SQL'
SELECT count(*) FROM quota_snapshot;
SQL
)"
[ "$ROWS" = "0" ] || fail "a rejected ingest wrote $ROWS rows"
pass "no rejected payload reached quota_snapshot (0 rows)"

# ---- 4. latest-only upsert --------------------------------------------------
api POST "$INGEST_PATH" "$PROBE_TOKEN" "$(snapshot_body codex short 0.6 "$OLDER_ISO")"
expect_status 200 "first ingest"
jq -e '.schema == "momo.provider_quota_snapshot.v0" and .applied == true
       and .snapshot.providerRef == "codex" and .snapshot.window == "short"
       and .snapshot.remainingRatio == 0.6 and (.snapshot.ageSeconds >= 0)' \
  <<<"$RESPONSE_BODY" >/dev/null || {
  echo "$RESPONSE_BODY" >&2; fail "first ingest projection"; }

api POST "$INGEST_PATH" "$PROBE_TOKEN" "$(snapshot_body codex short 0.2 "$NEWER_ISO")"
expect_status 200 "newer ingest"
jq -e '.applied == true and .snapshot.remainingRatio == 0.2' <<<"$RESPONSE_BODY" >/dev/null || {
  echo "$RESPONSE_BODY" >&2; fail "newer probe must replace the gauge"; }

# Replay of the OLDER probe: must not regress the stored ratio.
api POST "$INGEST_PATH" "$PROBE_TOKEN" "$(snapshot_body codex short 0.99 "$OLDER_ISO")"
expect_status 200 "older replay"
jq -e '.applied == false and .snapshot.remainingRatio == 0.2' <<<"$RESPONSE_BODY" >/dev/null || {
  echo "$RESPONSE_BODY" >&2; fail "older probe must be retained, not applied"; }

# A different window is its own gauge, not an overwrite.
api POST "$INGEST_PATH" "$PROBE_TOKEN" "$(snapshot_body codex weekly 0.85 "$NOW_ISO")"
expect_status 200 "weekly ingest"
api POST "$INGEST_PATH" "$PROBE_TOKEN" "$(snapshot_body claude short 0.4 "$NOW_ISO")"
expect_status 200 "second provider ingest"

STORED="$(sql_value <<'SQL'
SELECT count(*) FROM quota_snapshot;
SQL
)"
[ "$STORED" = "3" ] || fail "expected 3 gauges (codex/short, codex/weekly, claude/short), got $STORED"
KEPT="$(sql_value <<'SQL'
SELECT remaining_ratio FROM quota_snapshot
 WHERE provider_ref='codex' AND quota_window='short';
SQL
)"
[ "$KEPT" = "0.2" ] || fail "codex/short must retain 0.2 after the older replay, got $KEPT"
pass "latest-only upsert: one row per (provider_ref, window), monotone in probed_at"

LEAKED="$(sql_value <<SQL
SELECT count(*) FROM quota_snapshot WHERE provider_ref LIKE '%$TOKEN_SHAPED%';
SQL
)"
[ "$LEAKED" = "0" ] || fail "a credential-shaped value reached the table"
pass "ADR-0004: no credential-shaped value at rest in quota_snapshot"

# ---- 5. GET is a workspace-member read --------------------------------------
api GET "$INGEST_PATH" "$READER_TOKEN"
expect_status 200 "member read"
jq -e '.schema == "momo.provider_quota_snapshots.v0"
       and (.snapshots | length) == 3
       and (.snapshots[0].providerRef == "claude")
       and (.snapshots | map(select(.providerRef=="codex" and .window=="short"))[0].remainingRatio) == 0.2
       and (.snapshots | map(select(.providerRef=="codex" and .window=="weekly"))[0].resetsAt) != null
       and (.snapshots | all(has("ageSeconds")))' \
  <<<"$RESPONSE_BODY" >/dev/null || { echo "$RESPONSE_BODY" >&2; fail "member read projection"; }

api GET "$INGEST_PATH" "$OUTSIDER_TOKEN"
expect_status 403 "non-member read"
api GET "$INGEST_PATH" "$PROBE_TOKEN"
expect_status 403 "agent bearer read"
api GET "$INGEST_PATH" ""
expect_status 401 "anonymous read"
pass "GET: workspace member 200, non-member 403, adapter credential 403, anonymous 401"

# ---- 6. RLS FORCE posture ---------------------------------------------------
DENY="$(sql_value <<'SQL'
BEGIN; SET LOCAL ROLE momo_app; SELECT count(*) FROM quota_snapshot; COMMIT;
SQL
)"
[ "$DENY" = "0" ] || fail "unscoped momo_app session saw $DENY quota_snapshot rows"
READ_OPEN="$(sql_value <<SQL
BEGIN; SET LOCAL ROLE momo_app; SET LOCAL app.workspace_id='$WS_ID';
SELECT count(*) FROM quota_snapshot; COMMIT;
SQL
)"
[ "$READ_OPEN" = "3" ] || fail "workspace-scoped session expected 3 rows, got $READ_OPEN"
WRITE_DENIED="$(run_sql -tA <<SQL 2>&1 || true
BEGIN; SET LOCAL ROLE momo_app; SET LOCAL app.workspace_id='$WS_ID';
INSERT INTO quota_snapshot (provider_ref, quota_window, remaining_ratio, probed_at)
VALUES ('rls-probe', 'short', 0.5, now());
COMMIT;
SQL
)"
case "$WRITE_DENIED" in
  *"row-level security"*) : ;;
  *) fail "tenant session must NOT be able to write quota_snapshot (got: $WRITE_DENIED)" ;;
esac
WRITE_OK="$(sql_value <<SQL
BEGIN; SET LOCAL ROLE momo_app; SET LOCAL app.provider_quota_admin='on';
INSERT INTO quota_snapshot (provider_ref, quota_window, remaining_ratio, probed_at)
VALUES ('rls-probe', 'short', 0.5, now());
SELECT count(*) FROM quota_snapshot WHERE provider_ref='rls-probe';
COMMIT;
SQL
)"
[ "$WRITE_OK" = "1" ] || fail "provider_quota_admin GUC must unlock the ingest write (got $WRITE_OK)"
pass "RLS FORCE: default-deny unscoped, SELECT under app.workspace_id, INSERT only under app.provider_quota_admin"

# ---- 7. api log must not carry the credential-shaped payload ---------------
compose logs --no-color api >"$TMP_DIR/api.log" 2>&1 || true
if grep -Fq -- "$TOKEN_SHAPED" "$TMP_DIR/api.log"; then
  fail "ADR-0004: the rejected credential-shaped value leaked into the api log"
fi
if grep -Fq -- "$PROBE_TOKEN" "$TMP_DIR/api.log"; then
  fail "ADR-0004: the agent bearer leaked into the api log"
fi
pass "ADR-0004: neither the adapter bearer nor the rejected credential value is in the api log"

log "PASS runtime gate: ingest auth, credential-shape rejection, schema policing, latest-only upsert, member read, RLS FORCE"
exit 0

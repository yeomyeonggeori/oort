#!/usr/bin/env bash
# MOMO-519 / ADR-0125 D11 host-loss tier fallback runtime gate.
set -euo pipefail
umask 077

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

for command_name in docker curl jq python3; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "[tier-fallback] missing $command_name" >&2
    exit 1
  }
done

COMPOSE_FILE="$REPO_ROOT/infra/docker-compose.e2e.yml"
PROJECT="${TIER_FALLBACK_GATE_PROJECT:-momo519tierfallback}"
API_PORT="${TIER_FALLBACK_GATE_API_PORT:-28020}"
PG_PORT="${TIER_FALLBACK_GATE_POSTGRES_PORT:-28021}"
CENT_PORT="${TIER_FALLBACK_GATE_CENTRIFUGO_PORT:-28022}"
PUSH_PORT="${TIER_FALLBACK_GATE_PUSH_PORT:-28023}"
HERMES_PORT_HOST="${TIER_FALLBACK_GATE_HERMES_PORT:-28024}"
BOOT_TIMEOUT="${TIER_FALLBACK_GATE_BOOT_TIMEOUT:-2400}"
ASSERT_TIMEOUT="${TIER_FALLBACK_GATE_ASSERT_TIMEOUT:-120}"
GRACE_SECONDS="${MOMO_HOST_OFFLINE_GRACE_S:-2}"
RUN_ID="$(date -u +%s)-$$"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/momo-tier-fallback.XXXXXX")"

WS_ID="00000000-0000-7000-8000-000000000001"
CHANNEL_ID="00000000-0000-7000-8000-000000000201"
CROSS_WS_ID="51900000-0000-7000-8000-000000000099"
OWNER_ID="$(python3 -c 'import uuid; print(uuid.uuid4())')"
OTHER_ID="$(python3 -c 'import uuid; print(uuid.uuid4())')"
TARGET_HOST_ID="$(python3 -c 'import uuid; print(uuid.uuid4())')"
CLOUD_HOST_ID="$(python3 -c 'import uuid; print(uuid.uuid4())')"
REVOKED_HOST_ID="$(python3 -c 'import uuid; print(uuid.uuid4())')"
ASK_HOST_ID="$(python3 -c 'import uuid; print(uuid.uuid4())')"
T1_HOST_ID="$(python3 -c 'import uuid; print(uuid.uuid4())')"
AUTO_HOST_ID="$(python3 -c 'import uuid; print(uuid.uuid4())')"
ASK_SESSION_ID="$(python3 -c 'import uuid; print(uuid.uuid4())')"
T1_SESSION_ID="$(python3 -c 'import uuid; print(uuid.uuid4())')"
AUTO_SESSION_ID="$(python3 -c 'import uuid; print(uuid.uuid4())')"
ASK_ROOT_ID="$(python3 -c 'import uuid; print(uuid.uuid4())')"
T1_ROOT_ID="$(python3 -c 'import uuid; print(uuid.uuid4())')"
AUTO_ROOT_ID="$(python3 -c 'import uuid; print(uuid.uuid4())')"
DEVICE_ID="$(python3 -c 'import uuid; print(uuid.uuid4())')"
OWNER_EMAIL="tier-owner-$RUN_ID@momo.local"
OTHER_EMAIL="tier-other-$RUN_ID@momo.local"
OWNER_PASSWORD="owner-$RUN_ID"
OTHER_PASSWORD="other-$RUN_ID"
PUBLIC_KEY="11qYAYLef0dU8/7tqW5Wc4MJio5SdxwIe3nHLzG2N9c="

compose() {
  PORT="$API_PORT" POSTGRES_PORT="$PG_PORT" CENT_PORT="$CENT_PORT" \
    HERMES_PORT="$HERMES_PORT_HOST" PUSH_RELAY_PORT="$PUSH_PORT" \
    MOMO_HOST_OFFLINE_GRACE_S="$GRACE_SECONDS" NOTIFIER_POLL_INTERVAL_MS=100 \
    docker compose -p "$PROJECT" -f "$COMPOSE_FILE" --profile push "$@"
}

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if [ "${TIER_FALLBACK_GATE_KEEP:-0}" = "1" ]; then
    echo "[tier-fallback] leaving '$PROJECT' up; evidence: $TMP_DIR"
  else
    compose down -v --remove-orphans >/dev/null 2>&1 || true
    case "$TMP_DIR" in
      "${TMPDIR:-/tmp}"/momo-tier-fallback.*) rm -r -- "$TMP_DIR" ;;
      *) echo "[tier-fallback] refusing unexpected temp path: $TMP_DIR" >&2 ;;
    esac
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

run_sql() {
  compose exec -T postgres psql -U "${POSTGRES_USER:-momo}" \
    -d "${POSTGRES_DB:-momo}" -v ON_ERROR_STOP=1 --no-psqlrc -q "$@"
}
sql_value() { run_sql -tA | tr -d '[:space:]'; }

BASE_URL="http://127.0.0.1:$API_PORT"
echo "[tier-fallback] booting isolated API stack on 28020-28023"
compose up -d api relay mock-push-relay
deadline=$(( $(date -u +%s) + BOOT_TIMEOUT ))
until curl -fsS "$BASE_URL/health" >/dev/null 2>&1; do
  if [ "$(date -u +%s)" -ge "$deadline" ]; then
    compose logs --tail 160 api relay >&2 || true
    echo "[tier-fallback] api health timeout" >&2
    exit 1
  fi
  sleep 2
done

run_sql <<SQL
BEGIN;
SET LOCAL row_security = off;
INSERT INTO member (id, workspace_id, kind, status, display_name, handle)
VALUES
  ('$OWNER_ID', '$WS_ID', 'human', 'active', 'Tier Owner', 'tier-owner-$RUN_ID'),
  ('$OTHER_ID', '$WS_ID', 'human', 'active', 'Tier Other', 'tier-other-$RUN_ID');
INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash, tz)
VALUES
  ('$OWNER_ID', '$WS_ID', '$OWNER_EMAIL', true, momo_password_hash('$OWNER_PASSWORD'), 'UTC'),
  ('$OTHER_ID', '$WS_ID', '$OTHER_EMAIL', true, momo_password_hash('$OTHER_PASSWORD'), 'UTC');
INSERT INTO membership (workspace_id, channel_id, member_id, role)
VALUES
  ('$WS_ID', '$CHANNEL_ID', '$OWNER_ID', 'owner'),
  ('$WS_ID', '$CHANNEL_ID', '$OTHER_ID', 'member');
INSERT INTO work_host
  (id, workspace_id, scope, owner_member_id, type, display_name, public_key,
   capabilities, last_seen_at, revoked_at)
VALUES
  ('$ASK_HOST_ID', '$WS_ID', 'member', '$OWNER_ID', 'app', 'Ask source', '$PUBLIC_KEY', '{}', clock_timestamp(), NULL),
  ('$T1_HOST_ID', '$WS_ID', 'member', '$OWNER_ID', 'app', 'T1 source', '$PUBLIC_KEY', '{}', clock_timestamp(), NULL),
  ('$AUTO_HOST_ID', '$WS_ID', 'member', '$OWNER_ID', 'app', 'Auto source', '$PUBLIC_KEY', '{}', clock_timestamp(), NULL),
  ('$TARGET_HOST_ID', '$WS_ID', 'member', '$OWNER_ID', 'workd', 'Resume target', '$PUBLIC_KEY', '{"tool.codex":true}', clock_timestamp(), NULL),
  ('$CLOUD_HOST_ID', '$WS_ID', 'workspace', '$OWNER_ID', 'cloud', 'Cloud target', '$PUBLIC_KEY', '{"tool.codex":true}', clock_timestamp(), NULL),
  ('$REVOKED_HOST_ID', '$WS_ID', 'member', '$OWNER_ID', 'workd', 'Revoked target', '$PUBLIC_KEY', '{}', clock_timestamp(), clock_timestamp());
WITH bumped AS (
  UPDATE channel_seq SET last_seq=last_seq+3
   WHERE channel_id='$CHANNEL_ID' RETURNING last_seq
)
INSERT INTO message
  (id, workspace_id, channel_id, seq, hlc_ts, hlc_count,
   author_member_id, type, props)
SELECT '$ASK_ROOT_ID'::uuid, '$WS_ID'::uuid, '$CHANNEL_ID'::uuid, last_seq-1,
       1, 0, '$OWNER_ID'::uuid, 'system'::message_type, '{"kind":"work_session","status":"running"}'::jsonb
  FROM bumped
UNION ALL
SELECT '$T1_ROOT_ID'::uuid, '$WS_ID'::uuid, '$CHANNEL_ID'::uuid, last_seq,
       2, 0, '$OWNER_ID'::uuid, 'system'::message_type, '{"kind":"work_session","status":"running"}'::jsonb
  FROM bumped
UNION ALL
SELECT '$AUTO_ROOT_ID'::uuid, '$WS_ID'::uuid, '$CHANNEL_ID'::uuid, last_seq-2,
       3, 0, '$OWNER_ID'::uuid, 'system'::message_type, '{"kind":"work_session","status":"running"}'::jsonb
  FROM bumped;
INSERT INTO work_session
  (id, workspace_id, channel_id, member_id, host_id, root_message_id, tool, label, status)
VALUES
  ('$ASK_SESSION_ID', '$WS_ID', '$CHANNEL_ID', '$OWNER_ID', '$ASK_HOST_ID', '$ASK_ROOT_ID', 'codex', 'Ask fallback', 'running'),
  ('$T1_SESSION_ID', '$WS_ID', '$CHANNEL_ID', '$OWNER_ID', '$T1_HOST_ID', '$T1_ROOT_ID', 'codex', 'T1 fallback', 'running'),
  ('$AUTO_SESSION_ID', '$WS_ID', '$CHANNEL_ID', '$OWNER_ID', '$AUTO_HOST_ID', '$AUTO_ROOT_ID', 'codex', 'Auto fallback', 'running');
COMMIT;
SQL

login() {
  curl -fsS -X POST "$BASE_URL/v1/auth/login" -H 'Content-Type: application/json' \
    --data "$(jq -cn --arg e "$1" --arg p "$2" --arg w "$WS_ID" \
      '{email:$e,password:$p,workspace:$w}')" | jq -er '.accessToken'
}
OWNER_TOKEN="$(login "$OWNER_EMAIL" "$OWNER_PASSWORD")"
OTHER_TOKEN="$(login "$OTHER_EMAIL" "$OTHER_PASSWORD")"

RESPONSE_STATUS=""
RESPONSE_BODY=""
api() {
  local token="$1" method="$2" path="$3" body="${4:-}"
  local -a args=(-sS -o "$TMP_DIR/response.json" -w '%{http_code}' -X "$method"
    -H 'Content-Type: application/json' -H "Authorization: Bearer $token")
  [ -n "$body" ] && args+=(--data "$body")
  RESPONSE_STATUS="$(curl "${args[@]}" "$BASE_URL$path")"
  RESPONSE_BODY="$(<"$TMP_DIR/response.json")"
}
expect_status() {
  [ "$RESPONSE_STATUS" = "$1" ] || {
    echo "[tier-fallback] FAIL $2: expected $1, got $RESPONSE_STATUS" >&2
    echo "$RESPONSE_BODY" >&2
    exit 1
  }
}

POLICY_PATH="/v1/workspaces/$WS_ID/work-tier-policy"
api "$OWNER_TOKEN" PUT "$POLICY_PATH" '{"mode":"ask"}'
expect_status 200 "workspace ask policy"
printf '%s' "$RESPONSE_BODY" | jq -e '.workTierPolicy.mode == "ask"' >/dev/null
api "$OTHER_TOKEN" PUT "$POLICY_PATH" '{"mode":"auto","autoTarget":"cloud"}'
expect_status 403 "non-admin workspace policy"
api "$OWNER_TOKEN" PUT "$POLICY_PATH/me" '{"mode":"ask"}'
expect_status 200 "owner ask override"

api "$OWNER_TOKEN" POST "/v1/workspaces/$WS_ID/devices" \
  "$(jq -cn --arg id "$DEVICE_ID" \
    '{deviceId:$id,platform:"macos",appBuild:"519",apnsToken:("ab"*32),env:"sandbox",topic:"kim.dawn.momo.e2e"}')"
expect_status 201 "push device registration"

# The heartbeat was current when sessions were created. Moving last_seen_at
# behind the 2-second verifier grace deterministically models heartbeat stop.
run_sql <<SQL
UPDATE work_host SET last_seen_at=clock_timestamp()-interval '10 seconds'
 WHERE id='$ASK_HOST_ID';
UPDATE work_host SET last_seen_at=clock_timestamp()+interval '1 hour'
 WHERE id IN ('$T1_HOST_ID', '$AUTO_HOST_ID');
INSERT INTO work_tier_policy (workspace_id, member_id, mode)
VALUES ('$WS_ID', '$OWNER_ID', 'ask')
ON CONFLICT (workspace_id, member_id) WHERE member_id IS NOT NULL
DO UPDATE SET mode='ask', auto_target=NULL, updated_at=clock_timestamp();
SQL

compose up -d notifier
deadline=$(( $(date -u +%s) + ASSERT_TIMEOUT ))
while [ "$(date -u +%s)" -lt "$deadline" ]; do
  got="$(sql_value <<SQL
SELECT count(*) FROM work_session WHERE id='$ASK_SESSION_ID' AND status='orphaned';
SQL
)"
  [ "$got" = "1" ] && break
  sleep 1
done
[ "${got:-0}" = "1" ] || { compose logs --tail 160 notifier >&2; exit 1; }

got="$(sql_value <<SQL
SELECT count(*) FROM message
 WHERE root_id='$ASK_ROOT_ID' AND type='approval_request'
   AND props->>'kind'='resume_offer'
   AND props->>'session_id'='$ASK_SESSION_ID';
SQL
)"
[ "$got" = "1" ] || { echo "[tier-fallback] missing resume_offer card" >&2; exit 1; }
got="$(sql_value <<SQL
SELECT count(*) FROM message
 WHERE id='$ASK_ROOT_ID' AND props->>'status'='orphaned'
   AND props->>'session_id'='$ASK_SESSION_ID';
SQL
)"
[ "$got" = "1" ] || { echo "[tier-fallback] ask root card did not become orphaned" >&2; exit 1; }
RESUME_MESSAGE_ID="$(sql_value <<SQL
SELECT id FROM message
 WHERE root_id='$ASK_ROOT_ID' AND props->>'kind'='resume_offer';
SQL
)"
deadline=$(( $(date -u +%s) + ASSERT_TIMEOUT ))
while [ "$(date -u +%s)" -lt "$deadline" ]; do
  got="$(sql_value <<SQL
SELECT count(*) FROM push_dispatch_log
 WHERE member_id='$OWNER_ID' AND message_id='$RESUME_MESSAGE_ID' AND apns_status=200;
SQL
)"
  [ "$got" = "1" ] && break
  sleep 1
done
[ "${got:-0}" = "1" ] || { echo "[tier-fallback] missing momo.work push dispatch" >&2; exit 1; }
curl -fsS "http://127.0.0.1:$PUSH_PORT/received" | jq -e \
  --arg message "$RESUME_MESSAGE_ID" '
  [.received[] | select((.message_id | ascii_downcase) == $message)
    | select(.reason == "resume_offer" and .category == "momo.work")]
  | length == 1' >/dev/null || {
    echo "[tier-fallback] relay did not receive resume_offer as momo.work" >&2
    exit 1
  }

api "$OTHER_TOKEN" POST "/v1/workspaces/$WS_ID/work-sessions/$ASK_SESSION_ID/resume" \
  "$(jq -cn --arg host "$TARGET_HOST_ID" '{targetHostId:$host}')"
expect_status 403 "non-owner resume"
api "$OWNER_TOKEN" POST "/v1/workspaces/$WS_ID/work-sessions/$ASK_SESSION_ID/resume" \
  "$(jq -cn --arg host "$REVOKED_HOST_ID" '{targetHostId:$host}')"
expect_status 409 "revoked target resume"
api "$OWNER_TOKEN" POST "/v1/workspaces/$WS_ID/work-sessions/$ASK_SESSION_ID/resume" \
  "$(jq -cn --arg host "$TARGET_HOST_ID" '{targetHostId:$host}')"
expect_status 201 "owner resume"
RESUMED_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.workSession.id | ascii_downcase')"
printf '%s' "$RESPONSE_BODY" | jq -e --arg source "$ASK_SESSION_ID" --arg host "$TARGET_HOST_ID" '
  .workSession.status == "running"
  and (.workSession.resumedFromSessionId | ascii_downcase) == $source
  and (.workSession.hostId | ascii_downcase) == $host' >/dev/null
got="$(sql_value <<SQL
SELECT count(*) FROM work_session source
JOIN work_session resumed ON resumed.resumed_from_session_id=source.id
JOIN work_control control ON control.session_id=resumed.id AND control.kind='spawn' AND control.status='dispatched'
WHERE source.id='$ASK_SESSION_ID' AND source.status='ended' AND source.end_reason='resumed'
  AND resumed.id='$RESUMED_ID' AND resumed.root_message_id=source.root_message_id;
SQL
)"
[ "$got" = "1" ] || { echo "[tier-fallback] resume lineage/dispatch mismatch" >&2; exit 1; }

run_sql <<SQL
UPDATE work_host SET last_seen_at=clock_timestamp()+interval '1 hour' WHERE id='$TARGET_HOST_ID';
SQL
api "$OWNER_TOKEN" PUT "$POLICY_PATH/me" '{"mode":"t1_only"}'
expect_status 200 "t1_only policy"
run_sql <<SQL
UPDATE work_host SET last_seen_at=clock_timestamp()-interval '10 seconds' WHERE id='$T1_HOST_ID';
SQL
deadline=$(( $(date -u +%s) + ASSERT_TIMEOUT ))
while [ "$(date -u +%s)" -lt "$deadline" ]; do
  got="$(sql_value <<SQL
SELECT count(*) FROM work_session WHERE id='$T1_SESSION_ID' AND status='ended' AND end_reason='orphaned';
SQL
)"
  [ "$got" = "1" ] && break
  sleep 1
done
[ "${got:-0}" = "1" ] || { echo "[tier-fallback] t1_only did not terminate" >&2; exit 1; }
got="$(sql_value <<SQL
SELECT count(*) FROM message
 WHERE id='$T1_ROOT_ID' AND props->>'status'='ended'
   AND props->>'end_reason'='orphaned';
SQL
)"
[ "$got" = "1" ] || { echo "[tier-fallback] t1_only root card did not end" >&2; exit 1; }
got="$(sql_value <<SQL
SELECT count(*) FROM message WHERE root_id='$T1_ROOT_ID' AND props->>'kind'='resume_offer';
SQL
)"
[ "$got" = "0" ] || { echo "[tier-fallback] t1_only emitted a card" >&2; exit 1; }

api "$OWNER_TOKEN" PUT "$POLICY_PATH/me" '{"mode":"auto","autoTarget":"cloud"}'
expect_status 200 "auto cloud policy"
run_sql <<SQL
UPDATE work_host SET last_seen_at=clock_timestamp()+interval '1 hour' WHERE id='$CLOUD_HOST_ID';
UPDATE work_host SET last_seen_at=clock_timestamp()-interval '10 seconds' WHERE id='$AUTO_HOST_ID';
SQL
deadline=$(( $(date -u +%s) + ASSERT_TIMEOUT ))
while [ "$(date -u +%s)" -lt "$deadline" ]; do
  got="$(sql_value <<SQL
SELECT count(*) FROM work_session source
JOIN work_session resumed ON resumed.resumed_from_session_id=source.id
WHERE source.id='$AUTO_SESSION_ID' AND source.status='ended' AND source.end_reason='resumed'
  AND resumed.status='running' AND resumed.host_id='$CLOUD_HOST_ID';
SQL
)"
  [ "$got" = "1" ] && break
  sleep 1
done
[ "${got:-0}" = "1" ] || { echo "[tier-fallback] automatic cloud resume failed" >&2; exit 1; }
got="$(sql_value <<SQL
SELECT count(*) FROM message WHERE root_id='$AUTO_ROOT_ID' AND props->>'kind'='resume_offer';
SQL
)"
[ "$got" = "0" ] || { echo "[tier-fallback] auto mode emitted a card" >&2; exit 1; }
got="$(sql_value <<SQL
SELECT count(*) FROM audit_log
 WHERE action='work.session.resumed' AND detail->>'source_session_id'='$AUTO_SESSION_ID'
   AND detail->>'automatic'='true';
SQL
)"
[ "$got" = "1" ] || { echo "[tier-fallback] automatic audit missing" >&2; exit 1; }

# Both new policy rows and session lineage remain tenant-isolated under momo_app.
got="$(compose exec -T postgres env PGPASSWORD=momo_app_dev_pw psql -U momo_app \
  -d "${POSTGRES_DB:-momo}" -tA --no-psqlrc -v ON_ERROR_STOP=1 <<SQL | tr -d '[:space:]'
BEGIN;
SET LOCAL app.workspace_id='$CROSS_WS_ID';
SELECT (SELECT count(*) FROM work_tier_policy WHERE workspace_id='$WS_ID')
     + (SELECT count(*) FROM work_session WHERE id IN ('$ASK_SESSION_ID','$RESUMED_ID'));
ROLLBACK;
SQL
)"
[ "$got" = "0" ] || { echo "[tier-fallback] FORCE RLS isolation failed" >&2; exit 1; }

echo "[tier-fallback] PASS ask/t1_only/auto/orphan/resume/push/RLS"

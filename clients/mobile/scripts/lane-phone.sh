#!/usr/bin/env bash
# =============================================================================
# clients/mobile/scripts/lane-phone.sh — MAESTRO-1 폰 자동 검수 레인
#
# `npm run lane:phone`, once, does all of this:
#
#   isolated local stack (mock provider, no ChatGPT)
#     -> disposable fixture member + agent profile
#     -> simulator build + install
#     -> five Maestro flows against the real app
#     -> PASS/FAIL table with a screenshot path for every failure
#     -> stack torn down, volumes included
#
# It exists because of one instruction: "maestro나 뭔가 써서 알아서 확인좀 하고,
# 최종검수 같은거에만 날 부르면 안돼?" So the bar is not "a test suite runs" — it is
# that a batch's phone surface can be checked WITHOUT a person driving it, and
# that what still needs a person is named explicitly rather than left implied.
# The 실기기 파이널 체크 block at the end is that naming; a green table here does
# not mean the push/lock-screen paths were covered, because a simulator has no
# APNs at all.
#
# ## Isolation and reclaim (성재's Docker heat, [[momo-docker-resource-accumulation]])
#
# One dedicated compose project on loopback ports nothing else uses. Teardown is
# `down -v --remove-orphans` in a trap, so it runs on failure and on Ctrl-C, not
# only on the happy path — and the SAME teardown runs at startup, because the
# way stacks accumulate is a run that died before its own trap.
#
# ## Usage
#
#   npm run lane:phone
#   npm run lane:phone -- --no-build          reuse build/sim (much faster)
#   npm run lane:phone -- --keep              leave the stack up to debug
#   npm run lane:phone -- --flow 20-stop      one flow only
#   npm run lane:phone -- --device "iPhone 17"
#
# Environment overrides (all optional):
#   LANE_PHONE_PROJECT     compose project     (default: momo_maestro1)
#   LANE_PHONE_API_PORT    api                 (default: 24330)
#   LANE_PHONE_CENT_PORT   centrifugo          (default: 24331)
#   LANE_PHONE_PG_PORT     postgres            (default: 24332)
#   LANE_PHONE_HERMES_PORT mock hermes         (default: 24333)
#   LANE_PHONE_SLOW_SECONDS mock event delay under `MAESTRO SLOW` (default: 5.0)
#   LANE_PHONE_BOOT_TIMEOUT seconds for api /health (default: 2400 — the api
#                          container cold-builds Swift on a fresh volume)
#   LANE_PHONE_FLOW_TIMEOUT seconds one flow may take before it is killed and
#                          reported FAIL (default: 1800 — Maestro 2.8 sometimes
#                          hangs in its own teardown after every step passed)
#   LANE_PHONE_OUT_DIR     artifact dir (default: under $TMPDIR)
# =============================================================================
set -euo pipefail

APP_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
REPO_ROOT="$(CDPATH= cd -- "$APP_ROOT/../.." && pwd)"
cd "$REPO_ROOT"

PROJECT="${LANE_PHONE_PROJECT:-momo_maestro1}"
API_PORT="${LANE_PHONE_API_PORT:-24330}"
CENT_PORT="${LANE_PHONE_CENT_PORT:-24331}"
PG_PORT="${LANE_PHONE_PG_PORT:-24332}"
HERMES_PORT="${LANE_PHONE_HERMES_PORT:-24333}"
SLOW_SECONDS="${LANE_PHONE_SLOW_SECONDS:-5.0}"
BOOT_TIMEOUT="${LANE_PHONE_BOOT_TIMEOUT:-2400}"
FLOW_TIMEOUT="${LANE_PHONE_FLOW_TIMEOUT:-1800}"
COMPOSE_FILE="$REPO_ROOT/infra/docker-compose.e2e.yml"

DEVICE_NAME="iPhone 17 Pro"
BUNDLE_ID="app.momo.ios"
APP_PATH="$APP_ROOT/build/sim/Build/Products/Debug-iphonesimulator/MomoMobile.app"
# The app's OWN default. Metro must answer here because Maestro does not
# interpolate `${...}` into `launchApp.arguments`, so `-RCT_jsLocation` could
# only be passed as a hard-coded literal — see the header of maestro/00-login.yaml.
METRO_PORT=8081

DO_BUILD=1
KEEP=0
ONLY_FLOW=""
FLOWS=(00-login 10-mention-working 20-stop 30-approval 40-agents-tab)

while [ "$#" -gt 0 ]; do
  case "$1" in
    --no-build) DO_BUILD=0; shift ;;
    --keep)     KEEP=1; shift ;;
    --flow)     ONLY_FLOW="${2:-}"; shift 2 ;;
    --device)   DEVICE_NAME="${2:-}"; shift 2 ;;
    -h|--help)  sed -n '2,45p' "$0"; exit 0 ;;
    *) echo "[lane] unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ -n "$ONLY_FLOW" ]; then
  FLOWS=("$ONLY_FLOW")
fi

RUN_ID="$(date -u +%s)-$$"
OUT_DIR="${LANE_PHONE_OUT_DIR:-${TMPDIR:-/tmp}/momo-lane-phone-$RUN_ID}"
mkdir -p "$OUT_DIR"

# Maestro is installed under ~/.maestro and its installer does not touch the
# shell profile of a non-interactive run, so the PATH is set here rather than
# assumed. scripts/install_maestro.sh is the installer.
export PATH="$HOME/.maestro/bin:$PATH"

say() { printf '[lane] %s\n' "$*"; }

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "[lane] missing required command: $1" >&2
    [ "$1" = "maestro" ] && echo "[lane] install it with: bash clients/mobile/scripts/install_maestro.sh" >&2
    exit 1
  }
}
need docker
need xcrun
need node
need python3
need uuidgen
need curl
need maestro

# ---------------------------------------------------------------------------
# compose
# ---------------------------------------------------------------------------
compose() {
  COMPOSE_PROJECT_NAME="$PROJECT" \
  PORT="$API_PORT" \
  CENT_PORT="$CENT_PORT" \
  POSTGRES_PORT="$PG_PORT" \
  HERMES_PORT="$HERMES_PORT" \
  MOCK_HERMES_MAESTRO_SLOW_SECONDS="$SLOW_SECONDS" \
  CENTRIFUGO_CLIENT_ALLOWED_ORIGINS="$CENT_ALLOWED_ORIGINS" \
  docker compose -p "$PROJECT" -f "$COMPOSE_FILE" "$@"
}

# React Native's WebSocket SENDS an Origin header — clients/mobile/README.md
# documents this as a measured, load-bearing surprise — valued as the websocket
# URL's own origin. infra/centrifugo.json cannot contain it, because the port is
# allocated per lane run, so the allow-list is widened for THIS stack only
# through a pass-through env var that is absent everywhere else. Without it the
# handshake is refused, the realtime rail never opens, and every flow that waits
# on a live turn fails with the app working correctly.
CENT_ALLOWED_ORIGINS="http://127.0.0.1:$CENT_PORT http://127.0.0.1:$API_PORT http://localhost:$CENT_PORT"

METRO_PID=""
LOCK_HELD=0
LOCK_DIR=""
# The currently-running flow and its watchdog, so a Ctrl-C or a kill takes them
# with it. Both are backgrounded jobs, so without this they are re-parented to
# init and outlive the run: the Maestro CLI keeps an XCTest driver and an
# `xcodebuild test-without-building` alive on the simulator (the next run then
# fights it for the device), and the watchdog sits in its `sleep` until the
# timeout and fires `kill -TERM` at a PID number that by then belongs to
# somebody else. Both were observed as leftovers from the interrupted run.
FLOW_PID=""
WATCHDOG_PID=""

# One run at a time — TAKEN BEFORE THE TEARDOWN TRAP IS INSTALLED, and that
# order is the whole point.
#
# Two lanes against the same compose project do not collide loudly: the second
# one's startup reclaim below deletes the FIRST one's stack out from under it,
# and the first then sits in a wait loop polling a database that no longer
# exists until its timeout. `mkdir` is the lock because it is atomic on every
# filesystem this runs on; the PID inside is what makes a stale lock diagnosable
# rather than just an obstacle.
#
# The lock alone did not fix it, though, and the way it failed is worth keeping
# written down. With `trap cleanup EXIT` installed FIRST, a second run that
# refused the lock correctly — printed "another lane run already owns this" and
# exited 1 — still ran cleanup on the way out, and cleanup's `compose down -v`
# is not scoped to runs that own anything. So the polite refusal destroyed the
# stack it had just declined to touch, and the holder was left polling a dead
# database with no error anywhere: the exact hang this lock exists to prevent,
# now triggered BY the lock. Measured here on 2026-08-04.
#
# Hence: acquire first, then arm the trap. `LOCK_HELD` is also checked inside
# cleanup, so the invariant survives someone moving these blocks back.
LOCK_DIR="${TMPDIR:-/tmp}/momo-lane-phone-$PROJECT.lock"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  holder="$(cat "$LOCK_DIR/pid" 2>/dev/null || echo unknown)"
  if [ "$holder" != "unknown" ] && kill -0 "$holder" 2>/dev/null; then
    echo "[lane] another lane run (pid $holder) already owns compose project '$PROJECT'." >&2
    echo "[lane] Wait for it, or run this one with LANE_PHONE_PROJECT set to something else." >&2
    exit 1
  fi
  echo "[lane] clearing a stale lock from pid $holder (no such process)" >&2
  rm -rf "$LOCK_DIR"
  mkdir "$LOCK_DIR" || { echo "[lane] could not take $LOCK_DIR" >&2; exit 1; }
fi
printf '%s' "$$" >"$LOCK_DIR/pid"
LOCK_HELD=1

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if [ "$LOCK_HELD" != "1" ]; then
    # Not this run's stack to reclaim — see the lock note above.
    exit "$rc"
  fi
  [ -n "$LOCK_DIR" ] && rm -rf "$LOCK_DIR"
  [ -n "$WATCHDOG_PID" ] && kill -KILL "$WATCHDOG_PID" 2>/dev/null || true
  if [ -n "$FLOW_PID" ] && kill -0 "$FLOW_PID" 2>/dev/null; then
    kill -TERM "$FLOW_PID" 2>/dev/null || true
    # Maestro's JVM leaves its iOS driver behind if it is only asked politely,
    # and that driver holds the simulator against the next run. Matched on THIS
    # lane's device id, which is in the runner's own path — an unscoped pattern
    # would also kill a lane running on a different simulator, and this file's
    # whole isolation story is that two lanes can coexist.
    [ -n "${UDID:-}" ] && pkill -f "Devices/$UDID/.*maestro-driver-iosUITests-Runner" 2>/dev/null || true
  fi
  if [ -n "$METRO_PID" ]; then
    kill -TERM "-$METRO_PID" 2>/dev/null || kill -TERM "$METRO_PID" 2>/dev/null || true
  fi
  if [ "$KEEP" = "1" ]; then
    say "--keep: leaving compose project '$PROJECT' up (tear down with:"
    say "        docker compose -p $PROJECT -f infra/docker-compose.e2e.yml down -v --remove-orphans)"
  else
    say "tearing down compose project '$PROJECT' (containers, network, volumes)"
    compose down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Re-entry reclaim. A previous run that was killed before its trap fired leaves
# its containers AND its volumes behind; the next run would then boot against a
# database carrying the last run's messages, which is the difference between
# "the reply arrived" and "a reply from twenty minutes ago is still on screen".
say "reclaiming any stack left behind by an earlier run"
compose down -v --remove-orphans >/dev/null 2>&1 || true

port_in_use() {
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null && { exec 3>&- 3<&-; return 0; }
  return 1
}
for p in "$API_PORT" "$CENT_PORT" "$PG_PORT" "$HERMES_PORT"; do
  if port_in_use "$p"; then
    echo "[lane] host port $p is busy and is not this lane's." >&2
    echo "[lane] Override with LANE_PHONE_API_PORT / _CENT_PORT / _PG_PORT / _HERMES_PORT." >&2
    exit 1
  fi
done

# STAGGERED, not `up -d api relay worker`. The three Swift services each
# cold-build inside their container, and the compose file gives them mem_limits
# of 4g + 3g + 4g — eleven gigabytes of ceiling on a Docker VM that is 7.7 GiB
# here. Running them together does not fail cleanly: the builds thrash, one gets
# killed mid-compile, the container comes back and starts its build from the
# top, and the lane sits on "waiting for health" for an hour with no error
# anywhere. Measured on this machine.
#
# scripts/verify_web_login_smoke.sh hit the same wall and documents the same
# fix — boot the api alone, let its build finish, then start the others.
say "booting stack (api :$API_PORT, centrifugo :$CENT_PORT, mock hermes :$HERMES_PORT)"
compose up -d api >/dev/null

BASE_URL="http://127.0.0.1:$API_PORT"
say "waiting for $BASE_URL/health (timeout ${BOOT_TIMEOUT}s; a cold Swift build takes many minutes)"
deadline=$(( $(date -u +%s) + BOOT_TIMEOUT ))
until curl -fsS "$BASE_URL/health" >/dev/null 2>&1; do
  if [ "$(date -u +%s)" -ge "$deadline" ]; then
    echo "[lane] timed out waiting for api health" >&2
    compose logs --tail 80 api >&2 || true
    exit 1
  fi
  if [ -n "$(compose ps -aq --status exited api 2>/dev/null)" ]; then
    echo "[lane] api container exited before health became green" >&2
    compose logs --tail 120 api >&2 || true
    exit 1
  fi
  sleep 3
done

# The provider must be the MOCK one. Asserted rather than assumed: a stack that
# quietly resolved a real gateway would bill someone real money for a UI check,
# and ADR-0004 keeps provider credentials out of this repo entirely.
runtime_availability="$(curl -fsS "$BASE_URL/health" | python3 -c 'import json,sys; print(json.load(sys.stdin)["agentRuntime"]["availability"])')"
if [ "$runtime_availability" != "mock" ]; then
  echo "[lane] refusing to run: agent runtime availability is '$runtime_availability', expected 'mock'." >&2
  exit 1
fi
say "api healthy · agent runtime = mock (no external provider)"

say "starting relay and worker (staggered after the api build — see above)"
compose up -d relay worker >/dev/null

# ---------------------------------------------------------------------------
# fixture — disposable, seed rows untouched
# ---------------------------------------------------------------------------
# Same pattern as scripts/verify_web_login_smoke.sh: the seeded demo user has no
# password hash, so the lane installs its own member rather than mutating a seed
# row that other verifiers assert on.
DEMO_WORKSPACE_ID="00000000-0000-7000-8000-000000000001"
GENERAL_CHANNEL_ID="00000000-0000-7000-8000-000000000201"
AGENT_LAB_CHANNEL_ID="00000000-0000-7000-8000-000000000202"
AGENT_MEMBER_ID="00000000-0000-7000-8000-000000000102"
AGENT_HANDLE="kim-intern"

LANE_MEMBER_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
LANE_EMAIL="lane-$RUN_ID@momo.local"
# Alphanumeric on purpose. It is typed into a `secureTextEntry` field by an
# automation, and that field is already delicate enough (see the `eraseText`
# note in maestro/00-login.yaml) without adding punctuation the software
# keyboard has to switch planes to reach.
LANE_PASSWORD="lane$(uuidgen | tr -d '-' | tr '[:upper:]' '[:lower:]' | cut -c1-16)"

say "installing disposable fixture member ($LANE_EMAIL)"
compose exec -T postgres psql -U "${POSTGRES_USER:-momo}" -d "${POSTGRES_DB:-momo}" \
  -v ON_ERROR_STOP=1 --no-psqlrc -q <<SQL
BEGIN;
SET LOCAL app.workspace_id = '$DEMO_WORKSPACE_ID';
SET LOCAL row_security = off;

DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM agent WHERE member_id = '$AGENT_MEMBER_ID') THEN
    RAISE EXCEPTION
      'agent seed missing — the e2e stack must run with MOMO_AGENT_SEED_MODE=e2e (002_seed.sql)';
  END IF;
END \$\$;

INSERT INTO member (id, workspace_id, kind, status, display_name, handle)
VALUES ('$LANE_MEMBER_ID', '$DEMO_WORKSPACE_ID', 'human', 'active',
        'Lane Tester', 'lane-tester-$RUN_ID');

INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash, tz)
VALUES ('$LANE_MEMBER_ID', '$DEMO_WORKSPACE_ID', '$LANE_EMAIL', true,
        momo_password_hash('$LANE_PASSWORD'), 'UTC');

-- Workspace membership is a SEPARATE table from channel membership, and it is
-- the one every workspace-scoped route authorises against
-- (WorkspaceAuthorization.activeRole). Without this row the app signs in
-- successfully and then shows "채널을 불러오지 못했습니다." — a 403 that reads as a
-- broken channel list.
--
-- 'admin', not 'member': 40-agents-tab toggles 재우기, which is restricted to a
-- workspace owner/admin or the agent's operator. A plain member gets
-- 'agent-state-forbidden', which is a correct screen and a useless test.
INSERT INTO workspace_membership (workspace_id, member_id, role)
VALUES ('$DEMO_WORKSPACE_ID', '$LANE_MEMBER_ID', 'admin');

INSERT INTO membership (workspace_id, channel_id, member_id, role)
VALUES ('$DEMO_WORKSPACE_ID', '$GENERAL_CHANNEL_ID', '$LANE_MEMBER_ID', 'member'),
       ('$DEMO_WORKSPACE_ID', '$AGENT_LAB_CHANNEL_ID', '$LANE_MEMBER_ID', 'member');

INSERT INTO agent_profile (agent_member_id, workspace_id, instructions,
                           enabled_tools, updated_by)
VALUES ('$AGENT_MEMBER_ID', '$DEMO_WORKSPACE_ID',
        'MAESTRO-1 phone lane fixture', '["work.session.end"]', '$LANE_MEMBER_ID')
ON CONFLICT (agent_member_id) DO UPDATE
   SET enabled_tools = EXCLUDED.enabled_tools,
       instructions  = EXCLUDED.instructions;
COMMIT;
SQL

# Two-sided check before the phone is involved at all: if the fixture is wrong,
# say so HERE, where the message is "the fixture is wrong", instead of three
# minutes later as a red screenshot of a login form.
login_response="$(curl -sS -X POST "$BASE_URL/v1/auth/login" \
  -H 'content-type: application/json' \
  -d "{\"email\":\"$LANE_EMAIL\",\"password\":\"$LANE_PASSWORD\"}")"
LANE_TOKEN="$(printf '%s' "$login_response" | python3 -c 'import json,sys
try: print(json.load(sys.stdin)["accessToken"])
except Exception: pass')"
[ -n "$LANE_TOKEN" ] || { echo "[lane] fixture login failed: $login_response" >&2; exit 1; }
say "fixture verified over REST (login 200)"

# ---------------------------------------------------------------------------
# readiness — one real agent round trip before the phone is involved
# ---------------------------------------------------------------------------
# "The containers are up" is not the same as "the worker finished cold-building
# and is claiming jobs", and the difference is invisible until a flow sends a
# mention and waits two minutes for a reply that was never going to come. So the
# lane provokes one full REST -> PG -> outbox -> relay -> worker -> mock -> PG
# round trip itself, and only then starts Maestro.
#
# It happens in #agent-lab, deliberately NOT #general: the mock's reply text is
# fixed, and 10-mention-working waits for exactly that string in #general. A
# warm-up reply sitting there would satisfy that wait instantly and the flow
# would assert nothing.
say "warming up the agent path in #agent-lab (proves relay + worker + mock are live)"
curl -sS -o /dev/null -X POST \
  "$BASE_URL/v1/workspaces/$DEMO_WORKSPACE_ID/channels/$AGENT_LAB_CHANNEL_ID/messages" \
  -H "authorization: Bearer $LANE_TOKEN" -H 'content-type: application/json' \
  -d "{\"body\":\"@$AGENT_HANDLE MAESTRO TEXT lane warm-up\",\"clientMsgId\":\"$(uuidgen)\"}"

warm_deadline=$(( $(date -u +%s) + BOOT_TIMEOUT ))
until [ "$(compose exec -T postgres psql -U "${POSTGRES_USER:-momo}" -d "${POSTGRES_DB:-momo}" \
            -tAq --no-psqlrc -c "SET row_security=off; SELECT count(*) FROM message
              WHERE channel_id = '$AGENT_LAB_CHANNEL_ID'
                AND author_member_id = '$AGENT_MEMBER_ID'
                AND type = 'text';" 2>/dev/null | tr -d '[:space:]')" = "1" ]; do
  if [ "$(date -u +%s)" -ge "$warm_deadline" ]; then
    echo "[lane] the agent never answered the warm-up mention." >&2
    echo "[lane] relay/worker last lines:" >&2
    compose logs --tail 40 worker >&2 || true
    compose logs --tail 20 relay >&2 || true
    exit 1
  fi
  sleep 3
done
say "agent path live"

# ---------------------------------------------------------------------------
# simulator
# ---------------------------------------------------------------------------
if [ "$DO_BUILD" = "1" ]; then
  say "building the simulator app (log: $OUT_DIR/build-sim.log)"
  if ! ( cd "$APP_ROOT" && bash scripts/build-sim.sh "platform=iOS Simulator,name=$DEVICE_NAME" ) \
        >"$OUT_DIR/build-sim.log" 2>&1; then
    grep -E 'error:|BUILD FAILED' "$OUT_DIR/build-sim.log" | tail -10 >&2 || tail -20 "$OUT_DIR/build-sim.log" >&2
    echo "[lane] build-sim.sh failed — full log: $OUT_DIR/build-sim.log" >&2
    exit 1
  fi
fi
[ -d "$APP_PATH" ] || { echo "[lane] $APP_PATH is missing — run without --no-build" >&2; exit 1; }

UDID="$(xcrun simctl list devices available --json \
  | python3 -c "
import json,sys
name=sys.argv[1]
d=json.load(sys.stdin)['devices']
for runtime in sorted(d, reverse=True):
    for dev in d[runtime]:
        if dev['name']==name:
            print(dev['udid']); raise SystemExit
raise SystemExit('no available simulator named '+name)
" "$DEVICE_NAME")"
say "simulator: $DEVICE_NAME ($UDID)"
xcrun simctl boot "$UDID" 2>/dev/null || true
xcrun simctl bootstatus "$UDID" -b >/dev/null
xcrun simctl install "$UDID" "$APP_PATH"

# ---------------------------------------------------------------------------
# metro
# ---------------------------------------------------------------------------
# `build:sim` is a Debug build, so the app fetches its JavaScript from Metro at
# launch. The trap gate/run.mjs documents applies here in full: a Metro from
# ANOTHER worktree answers on this port identically and serves that worktree's
# code, so the lane could go green against JavaScript that is not under test.
# @react-native-community/cli answers the ownership question exactly, in a
# response header, so this asks rather than infers — and REFUSES rather than
# guessing, because a wrong-tree PASS is worse than a lane that says why it
# stopped.
metro_owner() {
  curl -fsS -D- -o /dev/null "http://127.0.0.1:$METRO_PORT/status" 2>/dev/null \
    | awk 'tolower($1)=="x-react-native-project-root:"{print $2}' | tr -d '\r'
}
owner="$(metro_owner || true)"
if [ -z "$owner" ]; then
  say "starting Metro on :$METRO_PORT"
  ( cd "$APP_ROOT" && exec node node_modules/react-native/cli.js start --port "$METRO_PORT" ) \
    >"$OUT_DIR/metro.log" 2>&1 &
  METRO_PID=$!
  deadline=$(( $(date -u +%s) + 120 ))
  until [ "$(metro_owner || true)" = "$APP_ROOT" ]; do
    if [ "$(date -u +%s)" -ge "$deadline" ]; then
      echo "[lane] Metro did not come up on :$METRO_PORT within 120s — see $OUT_DIR/metro.log" >&2
      exit 1
    fi
    sleep 2
  done
elif [ "$owner" = "$APP_ROOT" ]; then
  say "reusing the Metro already serving this checkout on :$METRO_PORT"
else
  echo "[lane] :$METRO_PORT is served by a DIFFERENT checkout:" >&2
  echo "[lane]   $owner" >&2
  echo "[lane] It would hand the app that tree's JavaScript and this lane would" >&2
  echo "[lane] report on code it never built. Stop that Metro and re-run." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# flows
# ---------------------------------------------------------------------------
RESULTS=()
FAILED=0

for flow in "${FLOWS[@]}"; do
  flow_file="$APP_ROOT/maestro/$flow.yaml"
  [ -f "$flow_file" ] || { echo "[lane] no such flow: $flow_file" >&2; exit 2; }
  flow_out="$OUT_DIR/$flow"
  say "running $flow"
  started=$(date -u +%s)
  # Every flow runs under a watchdog, because Maestro 2.8 does not always exit.
  # Observed repeatedly on this machine: the flow's own steps all report
  # COMPLETED, and then the CLI sits on its XCTest driver — sometimes for twenty
  # minutes, once for over an hour — with no output and no timeout of its own.
  # An unattended checker that can hang forever is not one anybody will leave
  # unattended, so the run is bounded here and a flow that blows the bound is
  # reported as a FAIL like any other rather than silently owning the machine.
  #
  # The default is deliberately generous (30 min): the hang is in Maestro's
  # teardown, so a bound tight enough to catch it quickly would also cut off
  # slow-but-healthy runs and report them as failures, which is the worse error.
  # macOS ships no coreutils `timeout`, hence the explicit watchdog.
  maestro --udid "$UDID" test --test-output-dir "$flow_out" "$flow_file" \
      -e SERVER_URL="$BASE_URL" \
      -e EMAIL="$LANE_EMAIL" \
      -e PASSWORD="$LANE_PASSWORD" \
      -e GENERAL_CHANNEL_ID="$GENERAL_CHANNEL_ID" \
      -e AGENT_MEMBER_ID="$AGENT_MEMBER_ID" \
      -e AGENT_HANDLE="$AGENT_HANDLE" \
      >"$OUT_DIR/$flow.log" 2>&1 &
  FLOW_PID=$!
  ( sleep "$FLOW_TIMEOUT"; kill -TERM "$FLOW_PID" 2>/dev/null ) &
  WATCHDOG_PID=$!
  flow_rc=0
  wait "$FLOW_PID" || flow_rc=$?
  kill "$WATCHDOG_PID" 2>/dev/null || true
  wait "$WATCHDOG_PID" 2>/dev/null || true
  FLOW_PID=""
  WATCHDOG_PID=""

  if [ "$flow_rc" = "0" ]; then
    RESULTS+=("$flow|PASS|$(( $(date -u +%s) - started ))|")
  else
    FAILED=1
    if [ "$(( $(date -u +%s) - started ))" -ge "$FLOW_TIMEOUT" ]; then
      say "  $flow exceeded LANE_PHONE_FLOW_TIMEOUT=${FLOW_TIMEOUT}s and was killed"
    fi
    shot="$(find "$flow_out" -name '*.png' -type f 2>/dev/null | tail -1)"
    RESULTS+=("$flow|FAIL|$(( $(date -u +%s) - started ))|${shot:-<no screenshot>}")
    # The failing assertion, inline. Without it the table says a flow failed and
    # every reader's next move is the same `grep` of the same log.
    grep -E 'FAILED|Assertion is false' "$OUT_DIR/$flow.log" | head -3 | sed 's/^/[lane]   /' || true
  fi
done

# ---------------------------------------------------------------------------
# report
# ---------------------------------------------------------------------------
printf '\n'
printf '  %-22s %-6s %6s  %s\n' "FLOW" "RESULT" "TIME" "SCREENSHOT (failures only)"
printf '  %-22s %-6s %6s  %s\n' "----------------------" "------" "------" "--------------------------"
for row in "${RESULTS[@]}"; do
  IFS='|' read -r name verdict secs shot <<<"$row"
  printf '  %-22s %-6s %5ss  %s\n' "$name" "$verdict" "$secs" "$shot"
done

cat <<'NOTE'

  실기기 파이널 체크 — 이 레인이 덮지 못하는 것 (시뮬레이터에 APNs가 없음):
    · 잠금화면 푸시로 도착하는 승인 요청, 그리고 거기서 바로 결정하기
    · 알림 권한 프롬프트 이후의 실제 배달 (이 레인은 항상 "허용 안 함"을 누른다)
    · 공유 키체인 access group — 기기 서명에서만 검증됨
      (clients/mobile/scripts/build-sim.sh 헤더 · docs/cicd/20-ios-push-device-check.md)
NOTE

printf '\n  artifacts: %s\n\n' "$OUT_DIR"

if [ "$FAILED" = "1" ]; then
  say "FAIL"
  exit 1
fi
say "PASS — all flows green"

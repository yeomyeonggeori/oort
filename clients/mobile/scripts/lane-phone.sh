#!/usr/bin/env bash
# =============================================================================
# clients/mobile/scripts/lane-phone.sh — MAESTRO-1 폰 자동 검수 레인
#
# `npm run lane:phone`, once, does all of this:
#
#   isolated local stack (RUST server image, mock provider, no ChatGPT)
#     -> disposable fixture member + agent profile + work session
#     -> a realtime assertion with the phone's own Origin
#     -> simulator build + install
#     -> six Maestro flows against the real app
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
# ## The server is Rust now (#1022), and that is the point of this file
#
# Until 2026-08-06 this lane booted `infra/docker-compose.e2e.yml` — three
# `swift:6.2` containers cold-building the ORIGINAL server from source. The old
# version of this header said so and named the consequence: a green table proved
# the app's UI mechanics against a server that is not the one anybody deploys.
# ADR-0145's transplant made the Rust server the 정본, so this lane now boots the
# **same image `server-rust/Dockerfile` produces for deployment**, from
# `infra/rust/docker-compose.rust.yml` — the deploy compose itself, plus one
# overlay for the mock provider.
#
# What that changed, concretely, and what it bought:
#
#   * **Boot is minutes faster and no longer staggered.** The Swift services
#     cold-compiled inside their containers under 11g of mem_limit on a 7.7 GiB
#     VM, so they had to be started one at a time and the health wait was 2400s.
#     The Rust image is built once, before the stack, and every container starts
#     in seconds. `LANE_PHONE_BOOT_TIMEOUT` drops from 2400 to 300.
#   * **The lane builds the deploy image on every run.** That is how #1119's
#     omission (a new crate missing from `server-rust/Dockerfile`'s manifest
#     pre-copy, which broke the image for every deploy path while `cargo build`
#     on the host stayed green) becomes a lane failure instead of a deploy-day
#     surprise.
#   * **The mock provider is unchanged and still `scripts/mock_hermes.py`.** The
#     Rust worker has no built-in mock — `MockChatProvider` is a library seam its
#     `main.rs` deliberately never constructs — so "no external provider" is
#     achieved the same way it always was: `HERMES_BASE_URL` points at a mock
#     HTTP server on the private network. See `infra/rust/docker-compose.lane-phone.yml`.
#   * **`agentRuntime.availability` is gone.** The Swift `/health` self-reported
#     its provider posture and this lane refused to run unless it said `mock`.
#     The Rust `/health` carries `{status, service, database}` and nothing else,
#     so that guard is replaced by three facts that are harder to fake: no
#     `provider_link` row exists (nothing in the database can redirect a turn),
#     the mock container actually logged the warm-up request, and the warm-up
#     reply is the mock's own fixed string. See `assert_provider_is_the_mock`.
#
# ## Isolation and reclaim (성재's Docker heat, [[momo-docker-resource-accumulation]])
#
# One dedicated compose project on loopback ports nothing else uses. Teardown is
# `down -v --remove-orphans` in a trap, so it runs on failure and on Ctrl-C, not
# only on the happy path — and the SAME teardown runs at startup, because the
# way stacks accumulate is a run that died before its own trap.
#
# `infra/rust`'s pgdata volume used to carry a FIXED name (`momo-rust-pgdata`)
# rather than a project-scoped one, so a lane run would attach to the real smoke
# stack's database and delete it on the way out (#1058 measured exactly this in
# the openapi gate). #1238 made the base default project-scoped. This lane still
# overrides `DB_VOLUME_NAME` and reclaims the volume by name — that override is
# now redundancy rather than the only thing standing between a lane run and
# someone else's database.
#
# ## Usage
#
#   npm run lane:phone
#   npm run lane:phone -- --no-build          reuse build/sim (much faster)
#   npm run lane:phone -- --keep              leave the stack up to debug
#   npm run lane:phone -- --flow 20-stop      one flow only
#   npm run lane:phone -- --device "iPhone 17"
#   npm run lane:phone -- --skip-flows        stack + realtime proof only
#
# Environment overrides (all optional):
#   LANE_PHONE_PROJECT     compose project     (default: momo_maestro1)
#   LANE_PHONE_API_PORT    api                 (default: 24330)
#   LANE_PHONE_CENT_PORT   centrifugo          (default: 24331)
#   LANE_PHONE_HERMES_PORT mock hermes         (default: 24333)
#   LANE_PHONE_SLOW_SECONDS mock turn-open window under `MAESTRO SLOW` (default 25)
#   LANE_PHONE_BOOT_TIMEOUT seconds for api /health (default: 300)
#   LANE_PHONE_FLOW_TIMEOUT seconds one flow may take before it is killed and
#                          reported FAIL (default: 1800 — Maestro 2.8 sometimes
#                          hangs in its own teardown after every step passed)
#   LANE_PHONE_RUST_IMAGE  reuse a prebuilt image instead of building one
#   LANE_PHONE_OUT_DIR     artifact dir (default: under $TMPDIR)
# =============================================================================
set -euo pipefail

APP_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
REPO_ROOT="$(CDPATH= cd -- "$APP_ROOT/../.." && pwd)"
cd "$REPO_ROOT"

PROJECT="${LANE_PHONE_PROJECT:-momo_maestro1}"
API_PORT="${LANE_PHONE_API_PORT:-24330}"
CENT_PORT="${LANE_PHONE_CENT_PORT:-24331}"
HERMES_PORT="${LANE_PHONE_HERMES_PORT:-24333}"
# The turn-open window `MAESTRO SLOW` buys, in seconds.
#
# 25, not the 5.0 this held while the lane ran on Swift, and the number did not
# change meaning by accident. On the streamed wire 5.0 was the delay BETWEEN
# events and the window was their sum — a lead-in plus three chunks plus usage,
# i.e. about 25 seconds, arrived at by counting chunks nobody was counting on
# purpose. The Rust worker's chat wire is not streamed, so the mock now holds the
# response once, for exactly this long. Same window, stated instead of emergent
# (#1069).
#
# It has to comfortably outlast Maestro's own step overhead inside the window:
# 20-stop must see 「작업 중」, find the arm control, tap it, assert the confirm
# sentence, wait out the 400ms guard, and commit — all before the turn ends on
# its own, because a stop that lands after the run finished is a correct
# `alreadyOver` screen and a useless test.
SLOW_SECONDS="${LANE_PHONE_SLOW_SECONDS:-25}"
BOOT_TIMEOUT="${LANE_PHONE_BOOT_TIMEOUT:-300}"
FLOW_TIMEOUT="${LANE_PHONE_FLOW_TIMEOUT:-1800}"

COMPOSE_BASE="$REPO_ROOT/infra/rust/docker-compose.rust.yml"
COMPOSE_BUILD="$REPO_ROOT/infra/rust/docker-compose.rust.build.yml"
COMPOSE_LANE="$REPO_ROOT/infra/rust/docker-compose.lane-phone.yml"

DEVICE_NAME="iPhone 17 Pro"
BUNDLE_ID="app.momo.ios"
APP_PATH="$APP_ROOT/build/sim/Build/Products/Debug-iphonesimulator/MomoMobile.app"
# The app's OWN default. Metro must answer here because Maestro does not
# interpolate `${...}` into `launchApp.arguments`, so `-RCT_jsLocation` could
# only be passed as a hard-coded literal — see the header of maestro/00-login.yaml.
METRO_PORT=8081

DO_BUILD=1
KEEP=0
SKIP_FLOWS=0
ONLY_FLOW=""
FLOWS=(00-login 10-mention-working 20-stop 30-approval 40-agents-tab 45-work-console)

while [ "$#" -gt 0 ]; do
  case "$1" in
    --no-build)   DO_BUILD=0; shift ;;
    --keep)       KEEP=1; shift ;;
    --skip-flows) SKIP_FLOWS=1; shift ;;
    --flow)       ONLY_FLOW="${2:-}"; shift 2 ;;
    --device)     DEVICE_NAME="${2:-}"; shift 2 ;;
    -h|--help)    sed -n '2,93p' "$0"; exit 0 ;;
    *) echo "[lane] unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ -n "$ONLY_FLOW" ]; then
  FLOWS=("$ONLY_FLOW")
fi

# --------------------------------------------------------------------------
# `--no-build` is refused HERE, before anything is started (#1035)
# --------------------------------------------------------------------------
# This check used to sit after the stack was up, the fixture installed and the
# agent path warmed — several minutes of Docker, all of it thrown away, to print
# a message that was already true at argument-parse time. Worse, on a fresh
# worktree the message a person actually needs is not "pass --build": it is that
# this checkout has never had `pod install` run in it. Both are said now, before
# a container exists.
if [ "$DO_BUILD" = "0" ] && [ ! -d "$APP_PATH" ]; then
  echo "[lane] --no-build was given but there is no build to reuse:" >&2
  echo "[lane]   $APP_PATH" >&2
  if [ ! -d "$APP_ROOT/ios/MomoMobile.xcworkspace" ]; then
    echo "[lane] This checkout has never been bootstrapped (no ios/MomoMobile.xcworkspace)." >&2
    echo "[lane] Re-run WITHOUT --no-build; build-sim.sh installs pods by itself." >&2
  else
    echo "[lane] Re-run without --no-build." >&2
  fi
  exit 1
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
need openssl
[ "$SKIP_FLOWS" = "1" ] || need maestro

# ---- node dependencies, before anything that needs them (#1035) -------------
#
# THREE things in this run import from `clients/mobile/node_modules`: the
# realtime probe (`centrifuge`, `ws`), Metro (`react-native/cli.js`), and the
# simulator build. `build-sim.sh` heals this for itself, but it runs LAST — so on
# a checkout that has never been bootstrapped the lane booted the whole stack,
# seeded the fixture, warmed the agent path, and only then died inside the probe
# with `ERR_MODULE_NOT_FOUND`, several minutes in, printing a message that
# pointed at the Centrifugo allow-list. Measured here on 2026-08-06, on the first
# run of a deliberately wiped checkout — which is what "부트스트랩부터" is for.
#
# Hoisted here, before a container exists. `npm ci` installs exactly
# `package-lock.json` and is skipped entirely when `node_modules` is present, so
# a warm checkout takes the path it always did.
INSTALLED_NODE_MODULES=0
if [ ! -d "$APP_ROOT/node_modules" ]; then
  say "node_modules is missing; running npm ci (lockfile-pinned, once)"
  ( cd "$APP_ROOT" && npm ci ) || {
    echo "[lane] npm ci failed — the lane cannot drive the app without it." >&2
    exit 1
  }
  INSTALLED_NODE_MODULES=1
fi

# ---------------------------------------------------------------------------
# run-scoped secrets and the compose env file
# ---------------------------------------------------------------------------
# Nothing committed is used as a credential. `infra/rust/rust-smoke.env.example`
# ships `change-me-*` placeholders and this lane never reads them: every secret
# below is born with the run and dies with it, in a 0600 file inside a 0700
# directory. Same discipline as scripts/verify_openapi_contract_rust.sh:117-153.
TMP_DIR="$OUT_DIR/stack"
mkdir -p "$TMP_DIR"
chmod 700 "$TMP_DIR"
rand_hex() { openssl rand -hex 24; }

PG_DB="momo"
PG_USER="momo"
PG_PASSWORD="$(rand_hex)"
APP_PASSWORD="$(rand_hex)"
RELAY_PASSWORD="$(rand_hex)"
WORKER_PASSWORD="$(rand_hex)"
CENT_API_KEY="$(rand_hex)"

# The origins React Native's WebSocket can present (#1051). RN sends an `Origin`
# header valued as the websocket URL's own origin (clients/mobile/README.md:117),
# and `infra/centrifugo.json` cannot contain it because the port is allocated per
# run. The rust compose parameterises the allow-list as
# `CENTRIFUGO_ALLOWED_ORIGINS` (docker-compose.rust.yml:74) — a **space
# separated** list; a JSON array string becomes one element and every handshake
# 403s (measured 2026-08-01, QA blocker B1).
LANE_RN_ORIGIN="http://127.0.0.1:$CENT_PORT"
CENT_ALLOWED_ORIGINS="$LANE_RN_ORIGIN http://127.0.0.1:$API_PORT http://localhost:$CENT_PORT"

# `LANE_PHONE_REALTIME_RED_PROOF=1` boots the SAME stack with the phone's origin
# removed from the allow-list and passes only if the rail then refuses to open.
#
# It is a mode of this script rather than a ritual somebody performs by hand,
# because an assertion nobody can re-run is an assertion that quietly stops
# meaning anything: the green probe above proves a frame arrived, but only this
# proves the allow-list is what decides. Without it, a probe that had silently
# started ignoring `--origin` would keep reporting PASS forever.
REALTIME_RED_PROOF="${LANE_PHONE_REALTIME_RED_PROOF:-0}"
if [ "$REALTIME_RED_PROOF" = "1" ]; then
  CENT_ALLOWED_ORIGINS="http://127.0.0.1:$API_PORT http://localhost:$CENT_PORT"
  say "RED PROOF: booting with $LANE_RN_ORIGIN removed from the allow-list"
fi

RUST_IMAGE="${LANE_PHONE_RUST_IMAGE:-}"
BUILD_IMAGE=0
if [ -z "$RUST_IMAGE" ]; then
  RUST_IMAGE="momo-rust:lane-phone"
  BUILD_IMAGE=1
fi

# `infra/rust`'s pgdata volume is a FIXED name, not project-scoped. See the
# header: without this override the lane adopts — and then deletes — the real
# smoke stack's database.
LANE_DB_VOLUME="${PROJECT}-pgdata"

ENV_FILE="$TMP_DIR/lane-phone.env"
: >"$ENV_FILE"
chmod 600 "$ENV_FILE"
cat >"$ENV_FILE" <<ENV
MOMO_RUST_IMAGE=$RUST_IMAGE
MOMO_ENV=local
LOG_LEVEL=info

POSTGRES_DB=$PG_DB
POSTGRES_USER=$PG_USER
POSTGRES_PASSWORD=$PG_PASSWORD
MIGRATE_DATABASE_URL=postgres://$PG_USER:$PG_PASSWORD@postgres:5432/$PG_DB

MOMO_APP_POSTGRES_PASSWORD=$APP_PASSWORD
RELAY_POSTGRES_PASSWORD=$RELAY_PASSWORD
WORKER_POSTGRES_PASSWORD=$WORKER_PASSWORD
MOMO_APP_DATABASE_URL=postgres://momo_app:$APP_PASSWORD@postgres:5432/$PG_DB
RELAY_DATABASE_URL=postgres://momo_relay:$RELAY_PASSWORD@postgres:5432/$PG_DB

JWT_HMAC=$(rand_hex)
CENT_TOKEN_HMAC=$(rand_hex)
CENT_API_KEY=$CENT_API_KEY
CENT_PROXY_SECRET=$(rand_hex)
PROVIDER_LINK_MASTER_KEY=$(rand_hex)
HERMES_API_KEY=$(rand_hex)

# ADR-0110: the only authority for the realtime address handed to clients. The
# simulator shares the host's loopback, so 127.0.0.1 is reachable from the app.
MOMO_CENTRIFUGO_WS_URL=ws://127.0.0.1:$CENT_PORT/connection/websocket
CENTRIFUGO_ALLOWED_ORIGINS=$CENT_ALLOWED_ORIGINS

MOMO_RUST_API_PORT=$API_PORT
CENT_HOST_PORT=$CENT_PORT
HERMES_HOST_PORT=$HERMES_PORT

# The seeded 김인턴 agent every flow mentions.
MOMO_AGENT_SEED_MODE=e2e
MIGRATE_IDEMPOTENCY_CHECK=1
MOMO_INITIAL_OWNER_EMAIL=
MOMO_INITIAL_OWNER_PASSWORD=

RELAY_POLL_INTERVAL_MS=100
WORKER_POLL_INTERVAL_MS=100
MOCK_HERMES_MAESTRO_SLOW_SECONDS=$SLOW_SECONDS

DB_VOLUME_NAME=$LANE_DB_VOLUME
ENV

COMPOSE_ARGS=(--env-file "$ENV_FILE" -p "$PROJECT" -f "$COMPOSE_BASE")
[ "$BUILD_IMAGE" -eq 1 ] && COMPOSE_ARGS+=(-f "$COMPOSE_BUILD")
COMPOSE_ARGS+=(-f "$COMPOSE_LANE")

compose() { docker compose "${COMPOSE_ARGS[@]}" "$@"; }

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
    say "        docker compose --env-file $ENV_FILE -p $PROJECT \\"
    say "          -f infra/rust/docker-compose.rust.yml \\"
    say "          -f infra/rust/docker-compose.lane-phone.yml down -v --remove-orphans)"
  else
    say "tearing down compose project '$PROJECT' (containers, network, volumes)"
    compose down -v --remove-orphans >/dev/null 2>&1 || true
    # `down -v` only removes volumes compose knows about. This one's name was
    # supplied by us, so it is reclaimed by name too — resource accumulation is
    # a hard rule in this repo, not a preference.
    docker volume rm -f "$LANE_DB_VOLUME" >/dev/null 2>&1 || true
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
docker volume rm -f "$LANE_DB_VOLUME" >/dev/null 2>&1 || true

port_in_use() {
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null && { exec 3>&- 3<&-; return 0; }
  return 1
}
for p in "$API_PORT" "$CENT_PORT" "$HERMES_PORT"; do
  if port_in_use "$p"; then
    echo "[lane] host port $p is busy and is not this lane's." >&2
    echo "[lane] Override with LANE_PHONE_API_PORT / _CENT_PORT / _HERMES_PORT." >&2
    exit 1
  fi
done

# ---------------------------------------------------------------------------
# the deploy image
# ---------------------------------------------------------------------------
# Built from the checkout through the COMMITTED build overlay, so this lane
# exercises the real `server-rust/Dockerfile` path. That is deliberate insurance:
# a crate added to the workspace but not to the Dockerfile's manifest pre-copy
# list breaks the image for every deployment while `cargo build` on the host
# stays green (#1119 did exactly that). Now it breaks the lane first.
if [ "$BUILD_IMAGE" -eq 1 ]; then
  say "building the deploy image $RUST_IMAGE (log: $OUT_DIR/rust-image.log)"
  if ! compose build api >"$OUT_DIR/rust-image.log" 2>&1; then
    tail -30 "$OUT_DIR/rust-image.log" >&2
    echo "[lane] server-rust image build failed — full log: $OUT_DIR/rust-image.log" >&2
    exit 1
  fi
else
  say "reusing prebuilt image $RUST_IMAGE (LANE_PHONE_RUST_IMAGE)"
fi

# ---------------------------------------------------------------------------
# stack
# ---------------------------------------------------------------------------
# No staggering, unlike the Swift stack this replaced: these containers start a
# prebuilt binary instead of cold-compiling one under a memory ceiling, so
# `depends_on` alone orders them (postgres healthy -> runtime-roles -> migrate ->
# api/relay/agent-worker).
say "booting rust stack (api :$API_PORT, centrifugo :$CENT_PORT, mock hermes :$HERMES_PORT)"
compose up -d api relay agent-worker >/dev/null

BASE_URL="http://127.0.0.1:$API_PORT"
say "waiting for $BASE_URL/health (timeout ${BOOT_TIMEOUT}s)"
deadline=$(( $(date -u +%s) + BOOT_TIMEOUT ))
until curl -fsS "$BASE_URL/health" >/dev/null 2>&1; do
  if [ "$(date -u +%s)" -ge "$deadline" ]; then
    echo "[lane] timed out waiting for api health" >&2
    compose logs --tail 80 api >&2 || true
    compose logs --tail 40 migrate >&2 || true
    exit 1
  fi
  if [ -n "$(compose ps -aq --status exited api 2>/dev/null)" ]; then
    echo "[lane] api container exited before health became green" >&2
    compose logs --tail 120 api >&2 || true
    compose logs --tail 40 migrate >&2 || true
    exit 1
  fi
  sleep 2
done
say "api healthy"

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
LANE_SESSION_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
LANE_SESSION_HOST_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
LANE_EMAIL="lane-$RUN_ID@momo.local"
# Alphanumeric on purpose. It is typed into a `secureTextEntry` field by an
# automation, and that field is already delicate enough (see the `eraseText`
# note in maestro/00-login.yaml) without adding punctuation the software
# keyboard has to switch planes to reach.
LANE_PASSWORD="lane$(uuidgen | tr -d '-' | tr '[:upper:]' '[:lower:]' | cut -c1-16)"

run_sql() {
  compose exec -T postgres psql -U "$PG_USER" -d "$PG_DB" \
    -v ON_ERROR_STOP=1 --no-psqlrc -q "$@"
}
query_sql() {
  compose exec -T postgres psql -U "$PG_USER" -d "$PG_DB" \
    -tAq --no-psqlrc -c "$1" 2>/dev/null | tr -d '[:space:]'
}

say "installing disposable fixture member ($LANE_EMAIL)"
run_sql <<SQL
BEGIN;
SET LOCAL app.workspace_id = '$DEMO_WORKSPACE_ID';
SET LOCAL row_security = off;

DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM agent WHERE member_id = '$AGENT_MEMBER_ID') THEN
    RAISE EXCEPTION
      'agent seed missing — the rust stack must migrate with MOMO_AGENT_SEED_MODE=e2e (002_seed.sql)';
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
# the work session 30-approval ends
# ---------------------------------------------------------------------------
# 30-approval's last claim is that an APPROVED tool call actually runs. On the
# Swift server that was `momo.mock.echo`, an entry on `ToolResumeExecutor`'s
# allowlist and on nothing else. The Rust worker's executable catalog holds
# exactly one tool — `work.session.end` (momo-agent/src/tools.rs:41) — so the
# lane gives it something real to end, and the mock aims the call at it
# (scripts/mock_hermes.py `_tool_fixture`).
#
# `end_session_in_tx` (tool_exec.rs:194) refuses unless all four hold, so all
# four are set up here: the session exists and is `running`; its `member_id` is
# the APPROVER (the lane member, who taps 승인); the approver is an active member
# of the session's channel; and the session's channel is the run's channel.
# The host is type `app`, and that is the load-bearing choice: `work_session`
# carries a real FK to `work_host` (migration 021), so it cannot be a made-up
# uuid — but an `app` host matches no `work_cloud_host` row, so
# `resolve_cloud_host_id` answers None and the tool takes the plain tenant
# transaction instead of the T3 termination ladder. The ladder would need a
# provisioned cloud host and a credit ledger, neither of which this lane has any
# business creating to watch a person tap 승인.
say "seeding a running work session for the approval flow ($LANE_SESSION_ID)"
session_root_message="$(curl -sS -X POST \
  "$BASE_URL/v1/workspaces/$DEMO_WORKSPACE_ID/channels/$GENERAL_CHANNEL_ID/messages" \
  -H "authorization: Bearer $LANE_TOKEN" -H 'content-type: application/json' \
  -d "{\"body\":\"lane work session card\",\"clientMsgId\":\"$(uuidgen)\"}" \
  | python3 -c 'import json,sys
# The Rust send route answers with the MessageDto itself; the Swift one wrapped
# it in {"message": …}. Both are accepted so this line does not become the thing
# that breaks the next time a projection is tidied.
try:
    body = json.load(sys.stdin)
    print((body.get("message") or body)["id"])
except Exception: pass')"
[ -n "$session_root_message" ] || {
  echo "[lane] could not post the work session root message" >&2
  exit 1
}
# `work_host.public_key` is CHECK-constrained to base64 of exactly 32 bytes
# (`^[A-Za-z0-9+/]{43}=$`), which is what `openssl rand -base64 32` produces. It
# is never used to verify anything here — no host process enrols against this
# lane — but a column that refuses junk is worth feeding correctly rather than
# working around.
LANE_HOST_PUBLIC_KEY="$(openssl rand -base64 32)"
run_sql <<SQL
BEGIN;
SET LOCAL app.workspace_id = '$DEMO_WORKSPACE_ID';
SET LOCAL row_security = off;

INSERT INTO work_host
  (id, workspace_id, scope, owner_member_id, type, display_name, public_key)
VALUES ('$LANE_SESSION_HOST_ID', '$DEMO_WORKSPACE_ID', 'member',
        '$LANE_MEMBER_ID', 'app', 'MAESTRO-1 lane host',
        '$LANE_HOST_PUBLIC_KEY');

INSERT INTO work_session
  (id, workspace_id, channel_id, member_id, host_id, root_message_id,
   tool, label, status)
VALUES ('$LANE_SESSION_ID', '$DEMO_WORKSPACE_ID', '$GENERAL_CHANNEL_ID',
        '$LANE_MEMBER_ID', '$LANE_SESSION_HOST_ID', '$session_root_message',
        'codex', 'MAESTRO-1 phone lane session', 'running');
COMMIT;
SQL

# ---------------------------------------------------------------------------
# readiness — one real agent round trip before the phone is involved
# ---------------------------------------------------------------------------
# "The containers are up" is not the same as "the worker is claiming jobs", and
# the difference is invisible until a flow sends a mention and waits two minutes
# for a reply that was never going to come. So the lane provokes one full
# REST -> PG -> outbox -> relay -> worker -> mock -> PG round trip itself, and
# only then starts Maestro.
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
until [ "$(query_sql "SET row_security=off; SELECT count(*) FROM message
              WHERE channel_id = '$AGENT_LAB_CHANNEL_ID'
                AND author_member_id = '$AGENT_MEMBER_ID'
                AND type = 'text';")" = "1" ]; do
  if [ "$(date -u +%s)" -ge "$warm_deadline" ]; then
    echo "[lane] the agent never answered the warm-up mention." >&2
    echo "[lane] agent-worker/relay/mock last lines:" >&2
    compose logs --tail 40 agent-worker >&2 || true
    compose logs --tail 20 relay >&2 || true
    compose logs --tail 20 mock-hermes >&2 || true
    exit 1
  fi
  sleep 2
done
say "agent path live"

# ---------------------------------------------------------------------------
# ADR-0004 — the provider is the mock, proved rather than self-reported
# ---------------------------------------------------------------------------
# The Swift lane asked `/health` whether its runtime was a mock and refused to
# run if it said otherwise. The Rust `/health` does not carry that field, and
# replacing it with a different self-report would have been a downgrade anyway:
# what a lane needs is not the server's opinion of its provider but evidence
# about the turn that just happened. Three facts, none of which a misconfigured
# stack can produce:
#
#   1. no `provider_link` row exists. A usable row BEATS the environment for
#      every turn (ADR-0004 증보 1 P-1b), so this is the only thing that could
#      have silently pointed the warm-up at a real gateway. The seed creates
#      none; asserting it makes that structural instead of assumed.
#   2. the mock container logged a `/v1/chat/completions` request. The turn went
#      somewhere, and this is where.
#   3. the reply the agent wrote is the mock's own fixed string. A real provider
#      would have answered something else.
assert_provider_is_the_mock() {
  local links mock_hits reply
  links="$(query_sql "SET row_security=off; SELECT count(*) FROM provider_link;")"
  if [ "$links" != "0" ]; then
    echo "[lane] refusing to run: $links provider_link row(s) exist and would beat the" >&2
    echo "[lane] mock for every turn (ADR-0004). This stack is not credential-free." >&2
    exit 1
  fi

  mock_hits="$(compose logs mock-hermes 2>/dev/null | grep -c 'POST /v1/chat/completions' || true)"
  if [ "${mock_hits:-0}" -lt 1 ]; then
    echo "[lane] refusing to run: the mock provider never received a completion request," >&2
    echo "[lane] so the warm-up reply came from somewhere this lane cannot account for." >&2
    compose logs --tail 40 mock-hermes >&2 || true
    exit 1
  fi

  reply="$(query_sql "SET row_security=off; SELECT count(*) FROM message
            WHERE channel_id = '$AGENT_LAB_CHANNEL_ID'
              AND author_member_id = '$AGENT_MEMBER_ID'
              AND body LIKE '김인턴 mock reply:%';")"
  if [ "$reply" != "1" ]; then
    echo "[lane] refusing to run: the warm-up reply is not the mock's fixed text." >&2
    echo "[lane] Something other than scripts/mock_hermes.py answered this turn." >&2
    exit 1
  fi
  say "provider is the mock · provider_link rows=0 · mock served $mock_hits request(s)"
}
assert_provider_is_the_mock

# ---------------------------------------------------------------------------
# realtime — the phone's own Origin, and a frame that really arrives (#1051)
# ---------------------------------------------------------------------------
# Nothing in the five flows distinguishes "the frame arrived over the socket"
# from "a re-fetch drew the same row", so the lane could be green with the
# realtime rail entirely shut — which is how the QA stack rejected every phone
# handshake for weeks without a single red run. The probe closes that: it speaks
# the app's own centrifuge client, presents the Origin React Native presents, and
# fails unless a live publication lands on the channel.
realtime_probe() {
  node "$APP_ROOT/scripts/lane-realtime-probe.mjs" \
    --server "$BASE_URL" \
    --ws "ws://127.0.0.1:$CENT_PORT/connection/websocket" \
    --origin "$LANE_RN_ORIGIN" \
    --email "$LANE_EMAIL" --password "$LANE_PASSWORD" \
    --workspace "$DEMO_WORKSPACE_ID" --channel "$AGENT_LAB_CHANNEL_ID" \
    "$@"
}
if [ "$REALTIME_RED_PROOF" = "1" ]; then
  say "RED PROOF: the rail must now REFUSE to open"
  if ! realtime_probe --expect-refused >"$OUT_DIR/realtime.log" 2>&1; then
    cat "$OUT_DIR/realtime.log" >&2
    echo "[lane] RED PROOF FAILED: removing the phone's origin did not shut the rail." >&2
    echo "[lane] The green assertion therefore proves nothing about the allow-list." >&2
    exit 1
  fi
  tail -2 "$OUT_DIR/realtime.log" | sed 's/^/[lane] /'
  say "RED PROOF PASS — the allow-list is what gates the phone's rail (#1051)"
  exit 0
fi

say "asserting the phone realtime rail (Origin: $LANE_RN_ORIGIN)"
if ! realtime_probe >"$OUT_DIR/realtime.log" 2>&1; then
  cat "$OUT_DIR/realtime.log" >&2
  echo "[lane] realtime assertion failed — the phone's live rail is shut." >&2
  echo "[lane] Check CENTRIFUGO_ALLOWED_ORIGINS in $ENV_FILE (#1051)." >&2
  exit 1
fi
tail -2 "$OUT_DIR/realtime.log" | sed 's/^/[lane] /'

# ---------------------------------------------------------------------------
# simulator
# ---------------------------------------------------------------------------
if [ "$SKIP_FLOWS" = "1" ]; then
  say "--skip-flows: stack and realtime proof done, stopping before the app"
  exit 0
fi

if [ "$DO_BUILD" = "1" ]; then
  say "building the simulator app (log: $OUT_DIR/build-sim.log)"
  if ! ( cd "$APP_ROOT" && bash scripts/build-sim.sh "platform=iOS Simulator,name=$DEVICE_NAME" ) \
        >"$OUT_DIR/build-sim.log" 2>&1; then
    grep -E 'error:|BUILD FAILED' "$OUT_DIR/build-sim.log" | tail -10 >&2 || tail -20 "$OUT_DIR/build-sim.log" >&2
    echo "[lane] build-sim.sh failed — full log: $OUT_DIR/build-sim.log" >&2
    exit 1
  fi
fi
[ -d "$APP_PATH" ] || { echo "[lane] $APP_PATH is missing after build-sim.sh" >&2; exit 1; }

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
  # `--reset-cache` only when this run installed the dependencies itself.
  #
  # Metro caches its module map under $TMPDIR keyed by PROJECT ROOT, not by the
  # contents of node_modules — so a checkout whose node_modules was just created
  # gets served by a map describing the tree that was there before. Measured on
  # 2026-08-06, on the bootstrap run: Metro answered every request with
  # `Unable to resolve module @babel/runtime/helpers/createClass` for a package
  # that was sitting on disk the whole time, and 00-login failed on a login form
  # that had never rendered.
  #
  # Conditional rather than always-on because a cold Metro start costs about a
  # minute, and paying it on every warm run to protect the rare cold one is the
  # wrong trade.
  metro_args=(start --port "$METRO_PORT")
  if [ "$INSTALLED_NODE_MODULES" = "1" ]; then
    say "starting Metro on :$METRO_PORT (--reset-cache: node_modules is new)"
    metro_args+=(--reset-cache)
  else
    say "starting Metro on :$METRO_PORT"
  fi
  ( cd "$APP_ROOT" && exec node node_modules/react-native/cli.js "${metro_args[@]}" ) \
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
      -e WORK_SESSION_ID="$LANE_SESSION_ID" \
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

  # 30-approval's subject is that an approved call RUNS, and the phone cannot
  # show that: the screen looks identical whether the tool executed or came back
  # "this server cannot execute it". So the row is read here. A flow that went
  # green on a tool that never ran is downgraded to FAIL, because that is the
  # half-verified green the flow's own header warns about.
  if [ "$flow" = "30-approval" ] && [ "$flow_rc" = "0" ]; then
    session_status="$(query_sql "SET row_security=off; SELECT status FROM work_session
                        WHERE id = '$LANE_SESSION_ID';")"
    if [ "$session_status" != "ended" ]; then
      say "  30-approval passed on screen but the approved tool did not run"
      say "  (work_session $LANE_SESSION_ID is '$session_status', expected 'ended')"
      flow_rc=90
    else
      say "  approved tool executed for real (work session ended)"
    fi
  fi

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
      (clients/mobile/scripts/build-sim.sh 헤더 · docs/cicd/11-ios-push-device-check.md)

  서버는 이제 라이브와 같다 (#1022):
    · 이 레인의 api·relay·agent-worker는 server-rust/Dockerfile이 굽는 배포 이미지
      그대로이고, 스택은 infra/rust/docker-compose.rust.yml(배포 compose) 위에
      목 프로바이더 오버레이 한 겹이다. Swift 서버는 이 레인에 들어오지 않는다.
    · 그래서 프레임 패턴·카드 props가 "라이브와 다를 수 있다"는 옛 경고는 끝났다.
    · 남은 차이는 목 프로바이더 하나다 — 실제 LLM의 답문 내용은 여기서 증명되지 않는다.
NOTE

printf '\n  artifacts: %s\n\n' "$OUT_DIR"

if [ "$FAILED" = "1" ]; then
  say "FAIL"
  exit 1
fi
say "PASS — all flows green"

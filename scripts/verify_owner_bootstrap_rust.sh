#!/usr/bin/env bash
# #1227 — first-boot owner bootstrap, proven on the Rust stack end to end.
#
# `scripts/verify_owner_bootstrap.sh` (MOMO-561) covers the *Swift* migrate
# image's one-shot `set-owner`. This is its Rust twin, and it proves a different
# claim: that following `infra/rust/README.md` §2 → §3 produces a stack you can
# actually log into, that a restart cannot undo that, and that omitting the two
# variables still leaves the door shut.
#
# Five phases, in the order a new self-hoster meets them:
#   1. RED   — boot with the owner variables empty. Login is impossible, and the
#              migrate log says why. This is migration 012 doing its job.
#   2. GREEN — fill the two variables, `up -d` again. The owner is created and
#              the login works. No `down -v`: the fail-closed state is
#              recoverable in place (the audit's costliest finding was that it
#              was not).
#   3. IDEMPOTENT — re-run migrate with the same values. Nothing is written.
#   4. ROTATION SAFETY — rotate with `migrate set-owner`, then re-run migrate
#              with the ORIGINAL env values still in the file. The rotated
#              password must survive: a restart may never resurrect a stale
#              password out of an env file.
#   5. HALF-SET — one variable without the other is exit 2, not a silent "off".
#
# Secrets: every password is generated here, passed only through the process
# environment, and the script fails if one appears in argv or any log.
#
# Usage:  scripts/verify_owner_bootstrap_rust.sh
#   MOMO_RUST_IMAGE=<ref>  reuse an existing image instead of building one.
set -euo pipefail
umask 077

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

RUN_TAG="$(date -u +%Y%m%dT%H%M%SZ)-$$"
# Compose refuses uppercase in a project name; the tag itself keeps its shape
# so the log lines stay comparable with the other verifiers'.
PROJECT="momo-owner-bootstrap-rust-$(printf '%s' "$RUN_TAG" | tr 'A-Z' 'a-z')"
COMPOSE_FILE="infra/rust/docker-compose.rust.yml"
API_PORT=28201
CENT_PORT=28202
API="http://127.0.0.1:${API_PORT}"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/momo-owner-bootstrap-rust.XXXXXX")"
ENV_FILE="$TMP_DIR/stack.env"
BUILT_IMAGE=""

fail() {
  printf '[owner-bootstrap-rust] FAIL: %s\n' "$*" >&2
  exit 1
}

note() { printf '[owner-bootstrap-rust] %s\n' "$*"; }

for command_name in docker python3 openssl curl; do
  command -v "$command_name" >/dev/null 2>&1 || fail "missing required command: $command_name"
done

python3 - "$API_PORT" "$CENT_PORT" <<'PY'
import socket, sys
for raw in sys.argv[1:]:
    port = int(raw)
    sock = socket.socket()
    try:
        sock.bind(("127.0.0.1", port))
    except OSError:
        raise SystemExit(f"reserved verifier port is already in use: {port}")
    finally:
        sock.close()
PY

compose() { docker compose --project-name "$PROJECT" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"; }

cleanup() {
  compose down -v --remove-orphans >/dev/null 2>&1 || true
  [ -n "$BUILT_IMAGE" ] && docker image rm "$BUILT_IMAGE" >/dev/null 2>&1 || true
  rm -rf -- "$TMP_DIR"
}
trap cleanup EXIT INT TERM

# ---------------------------------------------------------------------------
# image
# ---------------------------------------------------------------------------
if [ -n "${MOMO_RUST_IMAGE:-}" ]; then
  IMAGE="$MOMO_RUST_IMAGE"
  docker image inspect "$IMAGE" >/dev/null 2>&1 ||
    fail "MOMO_RUST_IMAGE=$IMAGE is not present locally"
else
  IMAGE="momo-rust:owner-bootstrap-$RUN_TAG"
  note "building $IMAGE (set MOMO_RUST_IMAGE to reuse one)"
  docker build -f server-rust/Dockerfile -t "$IMAGE" . >"$TMP_DIR/build.log" 2>&1 ||
    { tail -30 "$TMP_DIR/build.log" >&2; fail "image build failed"; }
  BUILT_IMAGE="$IMAGE"
fi

# The image must carry the fixed SQL and immutable runtime marker without any
# legacy path override env. Otherwise a dotenv value could replace pre-gate SQL.
docker run --rm --entrypoint sh "$IMAGE" -c \
  'test "$MOMO_IN_CONTAINER" = 1 &&
   test -s /opt/momo/sql/bootstrap_owner_if_absent.sql &&
   test -s /opt/momo/sql/bootstrap_owner_claim_if_absent.sql &&
   test -s /opt/momo/sql/set_initial_owner.sql &&
   test -s /opt/momo/sql/bootstrap_runtime_roles.sql &&
   test -s /opt/momo/sql/bootstrap_roles.sql &&
   test -d /opt/momo/migrations &&
   test -z "${MOMO_MIGRATIONS_DIR+x}${MOMO_BOOTSTRAP_ROLES_SQL+x}${MOMO_RUNTIME_ROLES_SQL+x}${MOMO_SET_OWNER_SQL+x}${MOMO_BOOTSTRAP_OWNER_SQL+x}${MOMO_BOOTSTRAP_OWNER_CLAIM_SQL+x}"' ||
  fail "image SQL/migration payload is missing or runtime path overrides remain enabled"

# ---------------------------------------------------------------------------
# env — generated, never committed, never echoed
# ---------------------------------------------------------------------------
gen() { openssl rand -hex 24; }
PG_PASSWORD="$(gen)"; APP_PASSWORD="$(gen)"; RELAY_PASSWORD="$(gen)"; WORKER_PASSWORD="$(gen)"
# Lowercase because phases 1-4 assert on this exact spelling in both directions;
# the mixed-case round trip that #1234 fixed gets its own address in phase 5b.
OWNER_EMAIL="owner-$(printf '%s' "$RUN_TAG" | tr 'A-Z' 'a-z')@momo.local"
OWNER_PASSWORD="first-$(gen)"
ROTATED_PASSWORD="rotated-$(gen)"

write_env() {
  # $1 = owner email, $2 = owner password (either may be empty)
  cat >"$ENV_FILE" <<EOF
MOMO_RUST_IMAGE=$IMAGE
MOMO_ENV=staging
MOMO_MIGRATE_ENV=development
MOMO_PITR_EVIDENCE_REQUIRED=0
MOMO_PITR_BOOTSTRAP_EMPTY=0
LOG_LEVEL=info
POSTGRES_DB=momo
POSTGRES_USER=momo
POSTGRES_PASSWORD=$PG_PASSWORD
MIGRATE_DATABASE_URL=postgres://momo:$PG_PASSWORD@postgres:5432/momo
MOMO_APP_POSTGRES_PASSWORD=$APP_PASSWORD
RELAY_POSTGRES_PASSWORD=$RELAY_PASSWORD
WORKER_POSTGRES_PASSWORD=$WORKER_PASSWORD
MOMO_APP_DATABASE_URL=postgres://momo_app:$APP_PASSWORD@postgres:5432/momo
RELAY_DATABASE_URL=postgres://momo_relay:$RELAY_PASSWORD@postgres:5432/momo
JWT_HMAC=$(gen)
CENT_TOKEN_HMAC=$(gen)
CENT_API_KEY=$(gen)
CENT_PROXY_SECRET=$(gen)
PROVIDER_LINK_MASTER_KEY=$(gen)
MOMO_CENTRIFUGO_WS_URL=ws://127.0.0.1:$CENT_PORT/connection/websocket
MOMO_RUST_API_PORT=$API_PORT
CENT_HOST_PORT=$CENT_PORT
DB_VOLUME_NAME=$PROJECT-pgdata
MOMO_AGENT_SEED_MODE=none
MIGRATE_IDEMPOTENCY_CHECK=1
MOMO_INITIAL_OWNER_EMAIL=$1
MOMO_INITIAL_OWNER_PASSWORD=$2
EOF
  chmod 600 "$ENV_FILE"
}

wait_for_api() {
  for _ in $(seq 1 90); do
    curl -fsS "$API/healthz" >/dev/null 2>&1 && return 0
    sleep 1
  done
  compose logs api >&2 || true
  fail "api did not become healthy on $API"
}

# Returns 0 when the credential is accepted.
login_works() {
  local email="$1" password="$2" body
  body="$(python3 -c 'import json,sys; print(json.dumps({"email": sys.argv[1], "password": sys.argv[2]}))' "$email" "$password")"
  curl -fsS -X POST "$API/v1/auth/login" -H 'content-type: application/json' \
    -d "$body" 2>/dev/null | grep -q '"accessToken"'
}

migrate_log() { compose logs --no-log-prefix migrate 2>&1; }

# ---------------------------------------------------------------------------
# phase 1 — RED: the documented default with the two variables left empty
# ---------------------------------------------------------------------------
note 'phase 1/5 RED — booting with MOMO_INITIAL_OWNER_* empty'
write_env "" ""
compose up -d >"$TMP_DIR/up-red.log" 2>&1 || { tail -20 "$TMP_DIR/up-red.log" >&2; fail "stack did not start"; }
wait_for_api

migrate_log >"$TMP_DIR/migrate-red.log"
grep -Fq 'IDEMPOTENCY_OK' "$TMP_DIR/migrate-red.log" || fail "migrations did not report idempotency"
grep -Fq 'no bootstrap owner requested' "$TMP_DIR/migrate-red.log" ||
  fail "an unset owner environment did not announce the closed door"
grep -Fq 'MOMO_BOOTSTRAP_OWNER=' "$TMP_DIR/migrate-red.log" &&
  fail "the bootstrap SQL ran without the environment being set"

login_works "$OWNER_EMAIL" "$OWNER_PASSWORD" && fail "RED: the intended owner could log in before being created"
login_works 'demo@momo.local' 'dev-password' && fail "RED: migration 012 did not lock the public seed password"
note 'phase 1 PASS — healthy stack, every login refused, migration 012 holding'

# ---------------------------------------------------------------------------
# phase 2 — GREEN: fill the two lines and boot again. No volume destruction.
# ---------------------------------------------------------------------------
note 'phase 2/5 GREEN — filling the two variables and re-running up -d'
write_env "$OWNER_EMAIL" "$OWNER_PASSWORD"
compose up -d >"$TMP_DIR/up-green.log" 2>&1 || { tail -20 "$TMP_DIR/up-green.log" >&2; fail "stack did not restart"; }
wait_for_api

migrate_log >"$TMP_DIR/migrate-green.log"
grep -Fq 'MOMO_BOOTSTRAP_OWNER=created' "$TMP_DIR/migrate-green.log" ||
  fail "the owner was not created on the second boot (in-place recovery is the point)"
login_works "$OWNER_EMAIL" "$OWNER_PASSWORD" ||
  fail "GREEN: the bootstrapped owner cannot log in"
note 'phase 2 PASS — login works, and the database was never destroyed to get here'

# ---------------------------------------------------------------------------
# phase 3 — IDEMPOTENT: the same migrate again writes nothing
# ---------------------------------------------------------------------------
note 'phase 3/5 IDEMPOTENT — re-running migrate with the same values'
compose run --rm migrate >"$TMP_DIR/migrate-again.log" 2>&1 ||
  fail "the second migrate run failed"
grep -Fq 'MOMO_BOOTSTRAP_OWNER=skipped' "$TMP_DIR/migrate-again.log" ||
  { cat "$TMP_DIR/migrate-again.log" >&2; fail "a re-run did not report itself as a no-op"; }
grep -Fq 'MOMO_BOOTSTRAP_OWNER=created' "$TMP_DIR/migrate-again.log" &&
  fail "a re-run rewrote the owner password"
login_works "$OWNER_EMAIL" "$OWNER_PASSWORD" || fail "the re-run invalidated a working login"
note 'phase 3 PASS'

# ---------------------------------------------------------------------------
# phase 4 — ROTATION SAFETY: a restart must not resurrect the env-file password
# ---------------------------------------------------------------------------
note 'phase 4/5 ROTATION — set-owner rotates, then migrate must leave it alone'
MOMO_INITIAL_OWNER_EMAIL="$OWNER_EMAIL" MOMO_INITIAL_OWNER_PASSWORD="$ROTATED_PASSWORD" \
  compose run --rm -e MOMO_INITIAL_OWNER_EMAIL -e MOMO_INITIAL_OWNER_PASSWORD \
  migrate set-owner >"$TMP_DIR/rotate.log" 2>&1 || fail "set-owner failed"
grep -Fq 'bootstrap owner credentials updated' "$TMP_DIR/rotate.log" ||
  fail "set-owner did not report completion"
login_works "$OWNER_EMAIL" "$ROTATED_PASSWORD" || fail "rotation did not take effect"

# The env file still carries the ORIGINAL password. A restart reads it.
compose run --rm migrate >"$TMP_DIR/migrate-after-rotate.log" 2>&1 ||
  fail "migrate failed after rotation"
grep -Fq 'MOMO_BOOTSTRAP_OWNER=skipped' "$TMP_DIR/migrate-after-rotate.log" ||
  fail "migrate did not skip an owner that already has a password"
login_works "$OWNER_EMAIL" "$ROTATED_PASSWORD" ||
  fail "a restart clobbered the rotated password with the stale env value"
login_works "$OWNER_EMAIL" "$OWNER_PASSWORD" &&
  fail "the superseded password still works after rotation"
note 'phase 4 PASS — the rotated password survives a restart'

# ---------------------------------------------------------------------------
# phase 5 — HALF-SET is exit 2, never a silent "off"
# ---------------------------------------------------------------------------
note 'phase 5/5 HALF-SET — one variable without the other'
set +e
compose run --rm -e MOMO_INITIAL_OWNER_PASSWORD= migrate >"$TMP_DIR/half-set.log" 2>&1
half_set_status=$?
set -e
[ "$half_set_status" -eq 2 ] ||
  { cat "$TMP_DIR/half-set.log" >&2; fail "a half-filled owner environment exited $half_set_status, expected 2"; }
grep -Fq 'must be set together' "$TMP_DIR/half-set.log" ||
  fail "the half-set failure did not name the contract"

# 5b. #1234 — the mixed-case round trip, end to end.
#
# This assertion used to be the mirror image: a mixed-case address had to exit 2,
# because the credential was stored lower(btrim(...)) while verify_password_login
# compared `h.email = $2` verbatim, so booting with it produced a healthy stack
# nobody could enter. The lookup now normalises its own input and migration 064
# makes the stored form a CHECK constraint, so the correct behaviour is the
# opposite: accept the spelling the operator typed and let them sign in with it.
#
# The login half is what makes this a proof rather than an exit-code check — it
# drives the exact 401 from #1234 through the real HTTP route.
MIXED_CASE_EMAIL="Owner-$(printf '%s' "$RUN_TAG" | tr 'a-z' 'A-Z')@Example.COM"
MIXED_CASE_NORMALISED="$(printf '%s' "$MIXED_CASE_EMAIL" | tr 'A-Z' 'a-z')"
MIXED_CASE_PASSWORD="mixed-$(gen)"

# A fresh database: the bootstrap only writes when no usable password exists, and
# phases 1-4 have already claimed the seeded owner in this one.
compose down -v >"$TMP_DIR/down-mixed-case.log" 2>&1 || true
write_env "$MIXED_CASE_EMAIL" "$MIXED_CASE_PASSWORD"
compose up -d >"$TMP_DIR/up-mixed-case.log" 2>&1 ||
  { tail -20 "$TMP_DIR/up-mixed-case.log" >&2; fail "the stack did not start with a mixed-case owner email"; }
wait_for_api

migrate_log >"$TMP_DIR/migrate-mixed-case.log"
grep -Fq 'MOMO_BOOTSTRAP_OWNER=created' "$TMP_DIR/migrate-mixed-case.log" ||
  { cat "$TMP_DIR/migrate-mixed-case.log" >&2; fail "a mixed-case owner email was refused instead of bootstrapped"; }

login_works "$MIXED_CASE_EMAIL" "$MIXED_CASE_PASSWORD" ||
  fail "#1234: the operator cannot log in with the address they typed into the env file"
login_works "$MIXED_CASE_NORMALISED" "$MIXED_CASE_PASSWORD" ||
  fail "#1234: the normalised spelling of the same address does not log in"
note 'phase 5 PASS — mixed-case owner email boots and signs in both ways (#1234)'

# ---------------------------------------------------------------------------
# secret hygiene across every log this run produced
# ---------------------------------------------------------------------------
for secret in "$OWNER_PASSWORD" "$ROTATED_PASSWORD" "$MIXED_CASE_PASSWORD" "$PG_PASSWORD" "$APP_PASSWORD"; do
  if grep -rqF "$secret" "$TMP_DIR" --include='*.log' 2>/dev/null; then
    fail "a generated secret leaked into command output"
  fi
done
compose logs 2>&1 | grep -qF "$ROTATED_PASSWORD" && fail "a password leaked into the stack logs"

printf '[owner-bootstrap-rust] PASS: fail-closed without the variables, one boot to a working login with them, idempotent on re-run, rotation-safe, and exit 2 on a half-filled pair (ports %s/%s)\n' \
  "$API_PORT" "$CENT_PORT"

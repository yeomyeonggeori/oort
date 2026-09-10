#!/usr/bin/env bash
# Isolated red proofs for SH-3a / #1955 (scripts/oort doctor).
#
# Fixture-driven: materialized env files live in a temp dir. The committed
# template under scripts/tests/fixtures/oort-doctor/ has no live secrets.
# Green on a stub is not evidence — every case below names the mutation.
set -euo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/../.." && pwd)"
OORT="$REPO_ROOT/scripts/oort"
TEMPLATE="$SCRIPT_DIR/fixtures/oort-doctor/valid.env.template"
OVERLAY="$SCRIPT_DIR/fixtures/oort-doctor/doorbell-true.env.overlay"
SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/oort-doctor-test.XXXXXX")"
PG_CID=""
HTTP_PID=""
cleanup() {
  [ -n "$HTTP_PID" ] && kill "$HTTP_PID" >/dev/null 2>&1 || true
  [ -n "$PG_CID" ] && docker rm -f "$PG_CID" >/dev/null 2>&1 || true
  rm -rf "$SANDBOX"
}
trap cleanup EXIT INT TERM
cd "$REPO_ROOT"

CASES=0
fail() { echo "[oort-doctor-test] FAIL: $*" >&2; exit 1; }
pass() { CASES=$((CASES + 1)); echo "[oort-doctor-test] ok: $*"; }

[ -x "$OORT" ] || chmod +x "$OORT"
[ -f "$TEMPLATE" ] || fail "missing fixture template: $TEMPLATE"
command -v jq >/dev/null 2>&1 || fail "jq is required"
command -v openssl >/dev/null 2>&1 || fail "openssl is required"
command -v python3 >/dev/null 2>&1 || fail "python3 is required"

port_busy() {
  local port="$1"
  (exec 3<>"/dev/tcp/127.0.0.1/$port") >/dev/null 2>&1 && { exec 3>&- 3<&-; return 0; }
  return 1
}

pick_port() {
  local port="$1" limit=$(($1 + 40))
  [ "$limit" -le 65536 ] || limit=65536
  while [ "$port" -lt "$limit" ]; do
    port_busy "$port" || { printf '%s' "$port"; return 0; }
    port=$((port + 1))
  done
  fail "no free port near $1"
}

validate_schema() {
  local file="$1"
  jq -e '
    (.summary | type == "object")
    and (.summary.pass | type == "number")
    and (.summary.fail | type == "number")
    and (.summary.skip | type == "number")
    and (.summary.verdict == "PASS" or .summary.verdict == "FAIL")
    and (.checks | type == "array")
    and (
      .checks | all(
        (.id | type == "string" and length > 0)
        and (.severity == "blocker" or .severity == "major" or .severity == "minor")
        and (.status == "pass" or .status == "fail" or .status == "skip" or .status == "info")
        and (.detail | type == "string")
        and (.fix | type == "string")
      )
    )
  ' "$file" >/dev/null
}

check_field() {
  local file="$1" id="$2" field="$3"
  jq -r --arg id "$id" --arg field "$field" '
    .checks[] | select(.id == $id) | .[$field]
  ' "$file" | head -1
}

has_check() {
  local file="$1" id="$2"
  jq -e --arg id "$id" '.checks[] | select(.id == $id)' "$file" >/dev/null
}

# Tokens are unique per run so the leak grep cannot match a committed literal.
TOKEN_PG="$(openssl rand -hex 12)"
TOKEN_APP="$(openssl rand -hex 12)"
TOKEN_RELAY="$(openssl rand -hex 12)"
TOKEN_WORKER="$(openssl rand -hex 12)"
TOKEN_NOTIFIER="$(openssl rand -hex 12)"
TOKEN_JWT="$(openssl rand -hex 12)"
TOKEN_CENT_TOKEN="$(openssl rand -hex 12)"
TOKEN_CENT_API="$(openssl rand -hex 12)"
TOKEN_CENT_PROXY="$(openssl rand -hex 12)"
TOKEN_PLINK="$(openssl rand -hex 12)"
TOKEN_OWNER="$(openssl rand -hex 12)"
WEB_PORT="$(pick_port 18088)"
API_PORT="$(pick_port 18080)"
CENT_PORT="$(pick_port 18000)"

materialize() {
  local dest="$1"
  python3 - "$TEMPLATE" "$dest" <<PY
import sys
src, dest = sys.argv[1], sys.argv[2]
text = open(src, encoding="utf-8").read()
repl = {
    "__TOKEN_PG__": "${TOKEN_PG}",
    "__TOKEN_APP__": "${TOKEN_APP}",
    "__TOKEN_RELAY__": "${TOKEN_RELAY}",
    "__TOKEN_WORKER__": "${TOKEN_WORKER}",
    "__TOKEN_NOTIFIER__": "${TOKEN_NOTIFIER}",
    "__TOKEN_JWT__": "${TOKEN_JWT}",
    "__TOKEN_CENT_TOKEN__": "${TOKEN_CENT_TOKEN}",
    "__TOKEN_CENT_API__": "${TOKEN_CENT_API}",
    "__TOKEN_CENT_PROXY__": "${TOKEN_CENT_PROXY}",
    "__TOKEN_PLINK__": "${TOKEN_PLINK}",
    "__TOKEN_OWNER__": "${TOKEN_OWNER}",
    "__TOKEN_WEB_PORT__": "${WEB_PORT}",
    "__TOKEN_API_PORT__": "${API_PORT}",
    "__TOKEN_CENT_PORT__": "${CENT_PORT}",
}
for k, v in repl.items():
    text = text.replace(k, v)
open(dest, "w", encoding="utf-8").write(text)
PY
  chmod 600 "$dest"
}

run_doctor() {
  # usage: run_doctor <env> <stdout> <stderr> [extra args...]
  local env="$1" stdout="$2" stderr="$3"
  shift 3
  set +e
  "$OORT" doctor --env "$env" "$@" >"$stdout" 2>"$stderr"
  echo $?
  set -e
}

assert_no_secret_leak() {
  local label="$1" file="$2"
  local token
  for token in \
    "$TOKEN_PG" "$TOKEN_APP" "$TOKEN_RELAY" "$TOKEN_WORKER" "$TOKEN_NOTIFIER" \
    "$TOKEN_JWT" "$TOKEN_CENT_TOKEN" "$TOKEN_CENT_API" "$TOKEN_CENT_PROXY" \
    "$TOKEN_PLINK" "$TOKEN_OWNER"
  do
    if grep -F -- "$token" "$file" >/dev/null 2>&1; then
      fail "$label leaked secret token"
    fi
  done
}

VALID="$SANDBOX/valid.env"
materialize "$VALID"

# -----------------------------------------------------------------------------
# 1. valid fixture → PASS, stack checks skip, JSON schema, no secret leak
# -----------------------------------------------------------------------------
OUT="$SANDBOX/valid.json"
ERR="$SANDBOX/valid.err"
code="$(run_doctor "$VALID" "$OUT" "$ERR" --json)"
[ "$code" = "0" ] || fail "valid fixture exit $code (want 0); stderr=$(cat "$ERR")"
validate_schema "$OUT" || fail "valid fixture JSON schema"
verdict="$(jq -r '.summary.verdict' "$OUT")"
[ "$verdict" = "PASS" ] || fail "valid fixture verdict $verdict (want PASS)"
has_check "$OUT" env.bool.doorbell || fail "valid fixture missing env.bool.doorbell"
[ "$(check_field "$OUT" env.bool.doorbell status)" = "pass" ] || \
  fail "valid doorbell should pass when unset"
has_check "$OUT" env.platform_admin_emails || fail "missing env.platform_admin_emails"
[ "$(check_field "$OUT" env.platform_admin_emails status)" = "pass" ] || \
  fail "valid PLATFORM_ADMIN_EMAILS should pass"
has_check "$OUT" env.role_passwords || fail "missing env.role_passwords"
[ "$(check_field "$OUT" env.role_passwords status)" = "pass" ] || \
  fail "valid role passwords should pass"

for id in stack.compose_ps stack.healthz stack.agent_port stack.outbox stack.migrate_idempotency roles.momo_notifier; do
  has_check "$OUT" "$id" || fail "missing $id"
  [ "$(check_field "$OUT" "$id" status)" = "skip" ] || \
    fail "$id should skip when stack is down: $(check_field "$OUT" "$id" status)"
  detail="$(check_field "$OUT" "$id" detail)"
  fix="$(check_field "$OUT" "$id" fix)"
  printf '%s %s' "$detail" "$fix" | grep -qi 'compose up\|self_host_env\|기동\|not running\|스택' || \
    fail "$id skip lacks guidance: $detail / $fix"
done
assert_no_secret_leak "valid json" "$OUT"
assert_no_secret_leak "valid stderr" "$ERR"
pass "valid fixture PASS; stack checks skip with guidance; schema; no secret leak"

HUM="$SANDBOX/valid.human"
HUMERR="$SANDBOX/valid.human.err"
hcode="$(run_doctor "$VALID" "$HUM" "$HUMERR")"
[ "$hcode" = "0" ] || fail "valid human exit $hcode"
assert_no_secret_leak "valid human" "$HUM"
assert_no_secret_leak "valid human stderr" "$HUMERR"
pass "valid human output has no secret tokens"

# Generator does not backfill MOMO_LIVEKIT_NODE_IP on existing env (#1856).
NOLK="$SANDBOX/nolivekit.env"
awk 'index($0, "MOMO_LIVEKIT_NODE_IP=") != 1 { print }' "$VALID" >"$NOLK"
chmod 600 "$NOLK"
OUT="$SANDBOX/nolivekit.json"
ERR="$SANDBOX/nolivekit.err"
code="$(run_doctor "$NOLK" "$OUT" "$ERR" --json)"
[ "$code" = "0" ] || fail "missing LIVEKIT exit $code (want 0); stderr=$(cat "$ERR")"
[ "$(jq -r '.summary.verdict' "$OUT")" = "PASS" ] || fail "missing LIVEKIT should not FAIL verdict"
[ "$(check_field "$OUT" env.required_keys status)" = "pass" ] || \
  fail "LIVEKIT must not be a required-keys blocker"
[ "$(check_field "$OUT" env.livekit_node_ip status)" = "skip" ] || \
  fail "LIVEKIT missing should skip: $(check_field "$OUT" env.livekit_node_ip status)"
pass "MOMO_LIVEKIT_NODE_IP absent on old env is skip, not blocker"

# -----------------------------------------------------------------------------
# 2. MOMO_DOORBELL_ENABLED=True → fail major, fix mentions lowercase true
# -----------------------------------------------------------------------------
DOORBELL="$SANDBOX/doorbell.env"
cp "$VALID" "$DOORBELL"
cat "$OVERLAY" >>"$DOORBELL"
chmod 600 "$DOORBELL"
OUT="$SANDBOX/doorbell.json"
ERR="$SANDBOX/doorbell.err"
code="$(run_doctor "$DOORBELL" "$OUT" "$ERR" --json)"
[ "$code" = "1" ] || fail "doorbell True exit $code (want 1 major-only); stderr=$(cat "$ERR")"
validate_schema "$OUT" || fail "doorbell JSON schema"
[ "$(jq -r '.summary.verdict' "$OUT")" = "FAIL" ] || fail "doorbell verdict not FAIL"
[ "$(check_field "$OUT" env.bool.doorbell status)" = "fail" ] || \
  fail "doorbell check status $(check_field "$OUT" env.bool.doorbell status)"
[ "$(check_field "$OUT" env.bool.doorbell severity)" = "major" ] || \
  fail "doorbell severity $(check_field "$OUT" env.bool.doorbell severity)"
fix="$(check_field "$OUT" env.bool.doorbell fix)"
printf '%s' "$fix" | grep -q 'true' || fail "doorbell fix must mention lowercase true: $fix"
printf '%s' "$fix" | grep -Eqi 'lowercase|소문자' || \
  fail "doorbell fix must say lowercase/소문자: $fix"
assert_no_secret_leak "doorbell json" "$OUT"
pass "doorbell True → fail(major), fix mentions lowercase true, exit 1"

# --strict promotes major to 2
code="$(run_doctor "$DOORBELL" "$SANDBOX/doorbell-strict.json" "$SANDBOX/doorbell-strict.err" --json --strict)"
[ "$code" = "2" ] || fail "--strict doorbell exit $code (want 2)"
pass "--strict promotes major to exit 2"

# hosted-delivery / unfurl misspellings from the same overlay
[ "$(check_field "$OUT" env.bool.hosted_delivery status)" = "fail" ] || \
  fail "hosted_delivery True should fail"
[ "$(check_field "$OUT" env.bool.unfurl status)" = "fail" ] || \
  fail "unfurl=yes should fail"
pass "hosted_delivery True and unfurl=yes also fail"

# -----------------------------------------------------------------------------
# 3. PLATFORM_ADMIN_EMAILS removed → fail blocker, exit 2
# -----------------------------------------------------------------------------
NOADMIN="$SANDBOX/noadmin.env"
awk 'index($0, "PLATFORM_ADMIN_EMAILS=") != 1 { print }' "$VALID" >"$NOADMIN"
chmod 600 "$NOADMIN"
grep -q '^PLATFORM_ADMIN_EMAILS=' "$NOADMIN" && fail "overlay did not drop PLATFORM_ADMIN_EMAILS"
OUT="$SANDBOX/noadmin.json"
ERR="$SANDBOX/noadmin.err"
code="$(run_doctor "$NOADMIN" "$OUT" "$ERR" --json)"
[ "$code" = "2" ] || fail "missing PLATFORM_ADMIN_EMAILS exit $code (want 2); stderr=$(cat "$ERR")"
validate_schema "$OUT" || fail "noadmin JSON schema"
[ "$(jq -r '.summary.verdict' "$OUT")" = "FAIL" ] || fail "noadmin verdict not FAIL"
[ "$(check_field "$OUT" env.platform_admin_emails status)" = "fail" ] || \
  fail "platform_admin_emails status $(check_field "$OUT" env.platform_admin_emails status)"
[ "$(check_field "$OUT" env.platform_admin_emails severity)" = "blocker" ] || \
  fail "platform_admin_emails severity $(check_field "$OUT" env.platform_admin_emails severity)"
assert_no_secret_leak "noadmin json" "$OUT"
pass "PLATFORM_ADMIN_EMAILS removed → fail(blocker), exit 2"

# -----------------------------------------------------------------------------
# 4. role password ≠ DATABASE_URL → fail blocker
# -----------------------------------------------------------------------------
MISMATCH="$SANDBOX/mismatch.env"
awk -v newpass="mismatch-${TOKEN_APP}" '
  index($0, "MOMO_APP_DATABASE_URL=") == 1 {
    sub(/momo_app:[^@]+@/, "momo_app:" newpass "@")
  }
  { print }
' "$VALID" >"$MISMATCH"
chmod 600 "$MISMATCH"
OUT="$SANDBOX/mismatch.json"
ERR="$SANDBOX/mismatch.err"
code="$(run_doctor "$MISMATCH" "$OUT" "$ERR" --json)"
[ "$code" = "2" ] || fail "password mismatch exit $code (want 2); stderr=$(cat "$ERR")"
validate_schema "$OUT" || fail "mismatch JSON schema"
[ "$(check_field "$OUT" env.role_passwords status)" = "fail" ] || \
  fail "role_passwords status $(check_field "$OUT" env.role_passwords status)"
[ "$(check_field "$OUT" env.role_passwords severity)" = "blocker" ] || \
  fail "role_passwords severity $(check_field "$OUT" env.role_passwords severity)"
assert_no_secret_leak "mismatch json" "$OUT"
# the mutated URL password must also stay out of the report
if grep -F -- "mismatch-${TOKEN_APP}" "$OUT" "$ERR" >/dev/null 2>&1; then
  fail "mismatch password leaked"
fi
pass "role password ≠ DATABASE_URL → fail(blocker), exit 2"

# Unknown stamp → exit 1 and still emit JSON (no JSON-less oort_die).
UNK="$SANDBOX/unknown-platform.env"
cp "$VALID" "$UNK"
printf '\nMOMO_SELF_HOST_PLATFORM=not-a-platform\n' >>"$UNK"
chmod 600 "$UNK"
OUT="$SANDBOX/unknown-platform.json"
ERR="$SANDBOX/unknown-platform.err"
code="$(run_doctor "$UNK" "$OUT" "$ERR" --json)"
[ "$code" = "1" ] || fail "unknown platform exit $code (want 1); stderr=$(cat "$ERR") stdout=$(head -c 200 "$OUT")"
[ -s "$OUT" ] || fail "unknown platform emitted no JSON"
validate_schema "$OUT" || fail "unknown platform JSON schema: $(head -c 400 "$OUT")"
[ "$(check_field "$OUT" env.platform status)" = "fail" ] || \
  fail "unknown platform env.platform status=$(check_field "$OUT" env.platform status) detail=$(check_field "$OUT" env.platform detail)"
UNK_COUNT="$(jq -r '.checks[].id' "$OUT" | wc -l | tr -d '[:space:]')"
[ "$UNK_COUNT" = "34" ] || \
  fail "unknown platform check id count ${UNK_COUNT} != 34 (env.platform extra on the normal 33)"
if grep -F -- "$TOKEN_PG" "$OUT" "$ERR" >/dev/null; then
  fail "unknown platform leaked password"
fi
pass "unknown MOMO_SELF_HOST_PLATFORM → exit 1 + JSON env.platform fail; 34 ids"

# -----------------------------------------------------------------------------
# 5. outbox oracle: push_candidate|pending is non-failing without a push relay
#    (fixture TSV / mocked query — no live postgres). Other kinds unchanged.
# -----------------------------------------------------------------------------
# shellcheck source=../lib/oort_doctor.sh
# shellcheck disable=SC1091
. "$REPO_ROOT/scripts/lib/oort_doctor.sh"

OUTBOX_PUSH_PENDING="$(printf 'push_candidate\tpending\t5\nbroadcast\tdone\t5\n')"

oort_doctor_classify_outbox 0 <<EOF
$OUTBOX_PUSH_PENDING
EOF
[ "$OORT_DOCTOR_OUTBOX_STATUS" = "info" ] || \
  fail "push_candidate|pending + no relay want info, got $OORT_DOCTOR_OUTBOX_STATUS"
printf '%s' "$OORT_DOCTOR_OUTBOX_DETAIL" | grep -Eq '5|pending' || \
  fail "no-relay info detail must name the pending count: $OORT_DOCTOR_OUTBOX_DETAIL"
printf '%s' "$OORT_DOCTOR_OUTBOX_DETAIL" | grep -Eqi 'push relay|push-relay|PUSH_RELAY|docker-compose.push' || \
  fail "no-relay info detail must state the rule: $OORT_DOCTOR_OUTBOX_DETAIL"
pass "push_candidate|pending + no relay → info (detail names count)"

oort_doctor_classify_outbox 1 <<EOF
$OUTBOX_PUSH_PENDING
EOF
[ "$OORT_DOCTOR_OUTBOX_STATUS" = "fail" ] || \
  fail "push_candidate|pending + relay configured want fail, got $OORT_DOCTOR_OUTBOX_STATUS"
pass "push_candidate|pending + relay configured → fail"

oort_doctor_classify_outbox 0 <<EOF
$(printf 'broadcast\tpending\t2\n')
EOF
[ "$OORT_DOCTOR_OUTBOX_STATUS" = "fail" ] || \
  fail "broadcast|pending without relay must still fail, got $OORT_DOCTOR_OUTBOX_STATUS"
pass "other kinds keep failing when not done"

# Env/compose facts: overlay keys from infra/rust/push-relay.env.example
OORT_DOCTOR_ENV_NORM="$(mktemp "$SANDBOX/env-norm.XXXXXX")"
export OORT_DOCTOR_ENV_NORM
oort_doctor_load_env "$VALID"
if oort_doctor_push_relay_configured ""; then
  fail "valid fixture must not look like a configured push relay"
fi
pass "self-host env without overlay keys → push relay not configured"

RELAY_ENV="$SANDBOX/with-push-relay.env"
cp "$VALID" "$RELAY_ENV"
printf '\nPUSH_RELAY_URL=http://push-relay:28195/v1/push\n' >>"$RELAY_ENV"
chmod 600 "$RELAY_ENV"
oort_doctor_load_env "$RELAY_ENV"
if ! oort_doctor_push_relay_configured ""; then
  fail "PUSH_RELAY_URL must count as push relay configured"
fi
pass "PUSH_RELAY_URL set → push relay configured"

if ! oort_doctor_push_relay_configured "$(printf 'api running healthy\npush-relay running healthy\n')"; then
  fail "compose service push-relay must count as configured"
fi
oort_doctor_load_env "$VALID"
if ! oort_doctor_push_relay_configured "$(printf 'notifier running healthy\n')"; then
  fail "compose service notifier must count as configured"
fi
pass "compose push-relay/notifier services → push relay configured"

# -----------------------------------------------------------------------------
# 6. status is live (SH-3b): doctor reuse + image object, not a stub
# -----------------------------------------------------------------------------
set +e
"$OORT" status --env "$VALID" --json >"$SANDBOX/status.out" 2>"$SANDBOX/status.err"
sc=$?
set -e
[ "$sc" = "0" ] || fail "status live exit $sc (want 0); stderr=$(cat "$SANDBOX/status.err")"
validate_schema "$SANDBOX/status.out" || fail "status --json schema"
jq -e '.image.state == "local"' "$SANDBOX/status.out" >/dev/null || \
  fail "status --json missing local image.state: $(head -c 200 "$SANDBOX/status.out")"
if grep -q 'SH-3b에서' "$SANDBOX/status.err" "$SANDBOX/status.out"; then
  fail "status still a stub"
fi
assert_no_secret_leak "status json" "$SANDBOX/status.out"
assert_no_secret_leak "status stderr" "$SANDBOX/status.err"
pass "status is live (doctor reuse + image); not a stub"

# -----------------------------------------------------------------------------
# 7. T2 stack.* v2 (local PG URL + HTTP origin fixture)
# -----------------------------------------------------------------------------
command -v docker >/dev/null 2>&1 || fail "docker is required for T2 doctor proofs"
docker info >/dev/null 2>&1 || fail "docker daemon is required for T2 doctor proofs"
# shellcheck source=../lib/oort_common.sh
# shellcheck disable=SC1091
OORT_ROOT="$REPO_ROOT"
export OORT_ROOT
. "$REPO_ROOT/scripts/lib/oort_doctor.sh"
. "$REPO_ROOT/scripts/lib/oort_common.sh"

EXPECTED_MIG="$(oort_doctor_expected_migration_count)"
printf '%s' "$EXPECTED_MIG" | grep -Eq '^[1-9][0-9]*$' || \
  fail "expected migration count is not a positive integer: ${EXPECTED_MIG}"
MIG_INFO="$SANDBOX/migrate-files.tsv"
: >"$MIG_INFO"
OORT_DOCTOR_CHECKS="$MIG_INFO"
saved_root="$OORT_ROOT"
OORT_ROOT="$SANDBOX/no-mig-root"
mkdir -p "$OORT_ROOT"
mig_n="$(oort_doctor_expected_migration_count)"
OORT_ROOT="$saved_root"
unset OORT_DOCTOR_CHECKS
[ "$mig_n" = "0" ] || fail "missing migrations dir count want 0 got ${mig_n}"
grep -Fq 'stack.migrate_files' "$MIG_INFO" || fail "missing dir did not record stack.migrate_files"
grep -Fq 'migrations dir 없음' "$MIG_INFO" || fail "missing dir info reason: $(cat "$MIG_INFO")"
pass "missing migrations dir → info (not silent 0)"
SQL_FN="$(oort_doctor_migrate_idempotency_sql "$EXPECTED_MIG")"
printf '%s' "$SQL_FN" | grep -Fq 'schema_migrations' || \
  fail "migrate SQL does not observe schema_migrations: $SQL_FN"
printf '%s' "$SQL_FN" | grep -Eq '^SELECT 1;?$' && \
  fail "migrate SQL is a tautology SELECT 1"

T1_IDS="$SANDBOX/t1.ids"
jq -r '.checks[].id' "$SANDBOX/status.out" | sort >"$T1_IDS"
# status --json includes the same checks as doctor plus image; ids come from doctor.
# Normal case is 33. 34 is not the happy path:
#   - stack.migrate_files (info) when server/Migrations and /opt/momo/migrations
#     are both missing (see the missing-dir probe above)
#   - env.platform (fail) when MOMO_SELF_HOST_PLATFORM is not a platform_profiles row
T1_COUNT="$(wc -l <"$T1_IDS" | tr -d '[:space:]')"
[ "$T1_COUNT" = "33" ] || fail "T1 check id count ${T1_COUNT} != 33 (normal case)"

PG_PORT="$(pick_port 25432)"
MOCK_PORT="$(pick_port 18765)"
PG_CID="$(docker run -d --rm \
  -e POSTGRES_USER=momo \
  -e POSTGRES_PASSWORD="$TOKEN_PG" \
  -e POSTGRES_DB=momo \
  -p "127.0.0.1:${PG_PORT}:5432" \
  postgres:18)"
i=0
while [ "$i" -lt 40 ]; do
  docker exec "$PG_CID" pg_isready -U momo >/dev/null 2>&1 && break
  i=$((i + 1))
  sleep 1
done
docker exec "$PG_CID" pg_isready -U momo >/dev/null 2>&1 || fail "T2 doctor postgres not ready"
T2_URL="postgres://momo:${TOKEN_PG}@127.0.0.1:${PG_PORT}/momo"

docker exec -i "$PG_CID" psql -U momo -d momo -v ON_ERROR_STOP=1 <<SQL
CREATE TABLE outbox (
  kind text NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  lease_acquired_at timestamptz
);
CREATE TABLE schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
CREATE ROLE momo_notifier LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS;
SQL
MIG_SQL="$SANDBOX/schema_migrations.sql"
{
  echo "BEGIN;"
  find "$REPO_ROOT/server/Migrations" -maxdepth 1 -name '[0-9][0-9][0-9]_*.sql' \
    | sort | while IFS= read -r f; do
    printf "INSERT INTO schema_migrations(version) VALUES ('%s');\n" "$(basename "$f")"
  done
  echo "COMMIT;"
} >"$MIG_SQL"
docker exec -i "$PG_CID" psql -U momo -d momo -v ON_ERROR_STOP=1 <"$MIG_SQL" >/dev/null
APPLIED_N="$(docker exec -i "$PG_CID" psql -U momo -d momo -At -c "SELECT count(*)::text FROM schema_migrations;")"
[ "$APPLIED_N" = "$EXPECTED_MIG" ] || \
  fail "seeded schema_migrations count ${APPLIED_N} != expected ${EXPECTED_MIG}"

python3 - "$MOCK_PORT" "$EXPECTED_MIG" <<'PY' &
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

port = int(sys.argv[1])
applied = int(sys.argv[2])
body = json.dumps({
    "status": "ok",
    "service": "momo-server",
    "database": "ok",
    "schema": {"applied": applied, "head": "086_device_link_token.sql"},
}).encode()

class H(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.split("?")[0] == "/healthz":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        if self.path.split("?")[0] == "/v1/mcp/agent-port":
            self.send_response(401)
            self.send_header("WWW-Authenticate", 'Bearer scope="agent:port:connect"')
            self.end_headers()
            return
        self.send_response(404)
        self.end_headers()

    def log_message(self, *_args):
        return

HTTPServer(("127.0.0.1", port), H).serve_forever()
PY
HTTP_PID=$!
i=0
while [ "$i" -lt 20 ]; do
  curl -sS -m 1 "http://127.0.0.1:${MOCK_PORT}/healthz" >/dev/null 2>&1 && break
  i=$((i + 1))
  sleep 0.2
done
curl -sS -m 1 "http://127.0.0.1:${MOCK_PORT}/healthz" >/dev/null || fail "T2 mock /healthz did not start"
HEALTHZ_BODY="$(curl -sS -m 2 "http://127.0.0.1:${MOCK_PORT}/healthz")"
printf '%s' "$HEALTHZ_BODY" | jq -e '.status=="ok" and .service=="momo-server" and .database=="ok" and (.schema|type=="object")' >/dev/null || \
  fail "mock /healthz missing schema or original fields: $HEALTHZ_BODY"

# Fixture-side mock: a skip-list host is not a T2 origin. Bind the HTTP
# server on 127.0.0.1 and rewrite a public fixture hostname via PATH curl.
T2_FIXTURE_HOST="t2.example.test"
T2_FIXTURE_ORIGIN="http://${T2_FIXTURE_HOST}:${MOCK_PORT}"
REAL_CURL="$(command -v curl)"
mkdir -p "$SANDBOX/bin"
cat >"$SANDBOX/bin/curl" <<EOF
#!/usr/bin/env bash
set -euo pipefail
args=()
for a in "\$@"; do
  case "\$a" in
    *://${T2_FIXTURE_HOST}*)
      a="\${a//${T2_FIXTURE_HOST}/127.0.0.1}"
      ;;
  esac
  args+=("\$a")
done
exec "$REAL_CURL" "\${args[@]}"
EOF
chmod +x "$SANDBOX/bin/curl"
export PATH="$SANDBOX/bin:$PATH"

T2_ENV="$SANDBOX/t2.env"
awk -v url="$T2_URL" -v origin="$T2_FIXTURE_ORIGIN" '
  index($0, "MIGRATE_DATABASE_URL=") == 1 { print "MIGRATE_DATABASE_URL=" url; next }
  index($0, "CENTRIFUGO_ALLOWED_ORIGINS=") == 1 {
    print "CENTRIFUGO_ALLOWED_ORIGINS=tauri://localhost http://tauri.localhost " origin
    next
  }
  { print }
' "$VALID" >"$T2_ENV"
printf '\nMOMO_SELF_HOST_PLATFORM=railway\n' >>"$T2_ENV"
chmod 600 "$T2_ENV"

OORT_DOCTOR_ENV_NORM="$(mktemp "$SANDBOX/t2-origin-norm.XXXXXX")"
export OORT_DOCTOR_ENV_NORM
oort_doctor_load_env "$T2_ENV"
picked="$(oort_doctor_t2_http_origin)"
[ "$picked" = "$T2_FIXTURE_ORIGIN" ] || \
  fail "T2 origin picker want fixture origin ${T2_FIXTURE_ORIGIN}, got ${picked}"
printf '%s' "$picked" | grep -Fq 'tauri.localhost' && \
  fail "T2 origin picker chose tauri: ${picked}"
printf '%s' "$picked" | grep -Fq '127.0.0.1' && \
  fail "T2 origin picker chose loopback: ${picked}"
pass "T2 origin picker skips tauri:// and loopback; fixture origin is picked"

LOOP_ENV="$SANDBOX/t2-loopback-only.env"
awk -v url="$T2_URL" -v origin="http://127.0.0.1:${MOCK_PORT}" '
  index($0, "MIGRATE_DATABASE_URL=") == 1 { print "MIGRATE_DATABASE_URL=" url; next }
  index($0, "CENTRIFUGO_ALLOWED_ORIGINS=") == 1 {
    print "CENTRIFUGO_ALLOWED_ORIGINS=tauri://localhost http://tauri.localhost http://localhost:18088 " origin
    next
  }
  { print }
' "$VALID" >"$LOOP_ENV"
printf '\nMOMO_SELF_HOST_PLATFORM=railway\n' >>"$LOOP_ENV"
chmod 600 "$LOOP_ENV"
OORT_DOCTOR_ENV_NORM="$(mktemp "$SANDBOX/t2-loop-norm.XXXXXX")"
export OORT_DOCTOR_ENV_NORM
oort_doctor_load_env "$LOOP_ENV"
picked="$(oort_doctor_t2_http_origin)"
[ -z "$picked" ] || \
  fail "loopback-only T2 origin picker must be empty (fail-closed), got ${picked}"
LOOP_OUT="$SANDBOX/t2-loopback.json"
LOOP_ERR="$SANDBOX/t2-loopback.err"
loop_code="$(run_doctor "$LOOP_ENV" "$LOOP_OUT" "$LOOP_ERR" --json --tier t2)"
[ "$(check_field "$LOOP_OUT" stack.healthz status)" = "fail" ] || \
  fail "loopback-only T2 healthz want fail, got $(check_field "$LOOP_OUT" stack.healthz status) $(check_field "$LOOP_OUT" stack.healthz detail)"
printf '%s' "$(check_field "$LOOP_OUT" stack.healthz detail)" | grep -Fq 'T2 공개 오리진 없음' || \
  fail "loopback-only T2 healthz should name missing public origin: $(check_field "$LOOP_OUT" stack.healthz detail)"
pass "loopback-only env: T2 origin picker fail-closed (empty); healthz fail (exit ${loop_code})"

OUT="$SANDBOX/t2-doctor.json"
ERR="$SANDBOX/t2-doctor.err"
code="$(run_doctor "$T2_ENV" "$OUT" "$ERR" --json --tier t2)"
validate_schema "$OUT" || fail "T2 doctor JSON schema: $(head -c 400 "$OUT")"
T2_IDS="$SANDBOX/t2.ids"
jq -r '.checks[].id' "$OUT" | sort >"$T2_IDS"
T2_COUNT="$(wc -l <"$T2_IDS" | tr -d '[:space:]')"
[ "$T2_COUNT" = "33" ] || fail "T2 check id count ${T2_COUNT} != 33 (normal case)"
[ "$T1_COUNT" = "$T2_COUNT" ] || \
  fail "T2 check id count ${T2_COUNT} != T1 ${T1_COUNT}"
cmp -s "$T1_IDS" "$T2_IDS" || \
  fail "T2 checks[].id set != T1: $(diff "$T1_IDS" "$T2_IDS" || true)"
[ "$(check_field "$OUT" stack.compose_ps status)" = "skip" ] || \
  fail "T2 stack.compose_ps should skip: $(check_field "$OUT" stack.compose_ps status)"
detail="$(check_field "$OUT" stack.compose_ps detail)"
printf '%s' "$detail" | grep -Fq 'T2: compose 없음, 플랫폼 서비스 상태는 레시피 CLI 소관' || \
  fail "compose_ps skip wording: $detail"
for id in stack.healthz stack.agent_port stack.outbox stack.migrate_idempotency roles.momo_notifier; do
  st="$(check_field "$OUT" "$id" status)"
  [ "$st" = "pass" ] || [ "$st" = "fail" ] || \
    fail "$id T2 status was $st (pass/fail only)"
  [ "$st" != "skip" ] || fail "$id T2 skipped (only compose_ps may skip)"
done
[ "$(check_field "$OUT" stack.healthz status)" = "pass" ] || \
  fail "T2 stack.healthz want pass: $(check_field "$OUT" stack.healthz detail)"
[ "$(check_field "$OUT" stack.agent_port status)" = "pass" ] || \
  fail "T2 stack.agent_port want pass: $(check_field "$OUT" stack.agent_port detail)"
[ "$(check_field "$OUT" stack.outbox status)" = "pass" ] || \
  fail "T2 stack.outbox want pass: $(check_field "$OUT" stack.outbox detail)"
[ "$(check_field "$OUT" stack.migrate_idempotency status)" = "pass" ] || \
  fail "T2 stack.migrate_idempotency want pass: $(check_field "$OUT" stack.migrate_idempotency detail)"
[ "$(check_field "$OUT" roles.momo_notifier status)" = "pass" ] || \
  fail "T2 roles.momo_notifier want pass: $(check_field "$OUT" roles.momo_notifier detail)"
assert_no_secret_leak "t2 doctor json" "$OUT"
assert_no_secret_leak "t2 doctor stderr" "$ERR"
if grep -Fq "$T2_URL" "$OUT" "$ERR"; then
  fail "T2 doctor leaked MIGRATE_DATABASE_URL"
fi
if grep -F -- "$TOKEN_PG" "$OUT" "$ERR" >/dev/null; then
  fail "T2 doctor leaked postgres password"
fi
pass "T2 doctor ids=${T2_COUNT} match T1; stack.* skip only compose_ps; other 5 pass"

# Sabotage: GRANT DELETE ON outbox still passed attribute-only checks (N-2).
docker exec -i "$PG_CID" psql -U momo -d momo -v ON_ERROR_STOP=1 \
  -c "GRANT DELETE ON TABLE outbox TO momo_notifier;" >/dev/null
OUT="$SANDBOX/t2-delete-grant.json"
ERR="$SANDBOX/t2-delete-grant.err"
code="$(run_doctor "$T2_ENV" "$OUT" "$ERR" --json --tier t2)"
[ "$code" != "0" ] || fail "GRANT DELETE ON outbox still exited 0"
[ "$(check_field "$OUT" roles.momo_notifier status)" = "fail" ] || \
  fail "GRANT DELETE: roles.momo_notifier status=$(check_field "$OUT" roles.momo_notifier status) (want fail)"
printf '%s' "$(check_field "$OUT" roles.momo_notifier detail)" | grep -Fq 'momo_notifier 에 DELETE 가 있다' || \
  fail "GRANT DELETE detail: $(check_field "$OUT" roles.momo_notifier detail)"
assert_no_secret_leak "delete-grant json" "$OUT"
pass "sabotage GRANT DELETE ON outbox → roles.momo_notifier fail (blocker)"
docker exec -i "$PG_CID" psql -U momo -d momo -v ON_ERROR_STOP=1 \
  -c "REVOKE DELETE ON TABLE outbox FROM momo_notifier;" >/dev/null

# Incomplete ledger (one migration missing) → migrate_idempotency fail.
docker exec -i "$PG_CID" psql -U momo -d momo -v ON_ERROR_STOP=1 \
  -c "DELETE FROM schema_migrations WHERE version = (SELECT max(version) FROM schema_migrations);" >/dev/null
OORT_DOCTOR_ENV_NORM="$(mktemp "$SANDBOX/t2-norm.XXXXXX")"
export OORT_DOCTOR_ENV_NORM
oort_doctor_load_env "$T2_ENV"
INCOMPLETE="$(oort_psql_migrate "$(oort_doctor_migrate_idempotency_sql "$EXPECTED_MIG")")"
[ "$INCOMPLETE" = "INCOMPLETE" ] || \
  fail "incomplete ledger SQL want INCOMPLETE got ${INCOMPLETE}"
OUT="$SANDBOX/t2-incomplete.json"
ERR="$SANDBOX/t2-incomplete.err"
code="$(run_doctor "$T2_ENV" "$OUT" "$ERR" --json --tier t2)"
[ "$(check_field "$OUT" stack.migrate_idempotency status)" = "fail" ] || \
  fail "incomplete ledger should fail migrate_idempotency: $(check_field "$OUT" stack.migrate_idempotency status) $(check_field "$OUT" stack.migrate_idempotency detail)"
pass "incomplete schema_migrations (1 missing) → stack.migrate_idempotency fail"

# Wrong password → stack.outbox fail (not skip/pass).
BAD_ENV="$SANDBOX/t2-badpw.env"
awk -v url="$T2_URL" '
  index($0, "MIGRATE_DATABASE_URL=") == 1 {
    sub(/:'"$TOKEN_PG"'@/, ":x'"${TOKEN_PG}"'@")
    print
    next
  }
  { print }
' "$T2_ENV" >"$BAD_ENV"
# Keep POSTGRES_PASSWORD matching the real secret so env.role_passwords is not
# the only failure; pair check compares POSTGRES_PASSWORD to URL password.
# After mutation they will mismatch — that is a blocker. Still require outbox fail.
chmod 600 "$BAD_ENV"
OUT="$SANDBOX/t2-badpw.json"
ERR="$SANDBOX/t2-badpw.err"
code="$(run_doctor "$BAD_ENV" "$OUT" "$ERR" --json --tier t2)"
[ "$(check_field "$OUT" stack.outbox status)" = "fail" ] || \
  fail "bad MIGRATE_DATABASE_URL password: outbox status=$(check_field "$OUT" stack.outbox status) (want fail)"
[ "$(check_field "$OUT" stack.outbox status)" != "skip" ] || fail "bad password outbox skipped"
[ "$(check_field "$OUT" stack.outbox status)" != "pass" ] || fail "bad password outbox passed"
if grep -F -- "$TOKEN_PG" "$OUT" "$ERR" >/dev/null; then
  fail "bad-password doctor leaked the real password"
fi
pass "bad MIGRATE_DATABASE_URL password → stack.outbox fail; password not printed"

# Sabotage: drop momo_notifier → roles.momo_notifier RED (fail-closed).
docker exec -i "$PG_CID" psql -U momo -d momo -v ON_ERROR_STOP=1 \
  -c "DROP ROLE IF EXISTS momo_notifier;" >/dev/null
OUT="$SANDBOX/t2-drop-notifier.json"
ERR="$SANDBOX/t2-drop-notifier.err"
code="$(run_doctor "$T2_ENV" "$OUT" "$ERR" --json --tier t2)"
[ "$code" != "0" ] || fail "drop momo_notifier still exited 0"
[ "$(check_field "$OUT" roles.momo_notifier status)" = "fail" ] || \
  fail "drop momo_notifier: roles.momo_notifier status=$(check_field "$OUT" roles.momo_notifier status) (want fail)"
[ "$(check_field "$OUT" roles.momo_notifier severity)" = "blocker" ] || \
  fail "drop momo_notifier severity=$(check_field "$OUT" roles.momo_notifier severity)"
printf '%s' "$(check_field "$OUT" roles.momo_notifier detail)" | grep -Fq 'momo_notifier 롤 없음' || \
  fail "drop momo_notifier detail: $(check_field "$OUT" roles.momo_notifier detail)"
assert_no_secret_leak "drop notifier json" "$OUT"
pass "sabotage DROP ROLE momo_notifier → roles.momo_notifier fail (blocker)"

echo "[oort-doctor-test] PASS: $CASES case(s)"

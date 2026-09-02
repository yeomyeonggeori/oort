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
cleanup() { rm -rf "$SANDBOX"; }
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
        and (.status == "pass" or .status == "fail" or .status == "skip")
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
    "$TOKEN_PG" "$TOKEN_APP" "$TOKEN_RELAY" "$TOKEN_WORKER" \
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

for id in stack.compose_ps stack.healthz stack.agent_port stack.outbox stack.migrate_idempotency; do
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

# -----------------------------------------------------------------------------
# 5. JSON schema on every --json run already covered; dispatcher stubs
# -----------------------------------------------------------------------------
set +e
"$OORT" status >"$SANDBOX/status.out" 2>"$SANDBOX/status.err"
sc=$?
set -e
[ "$sc" = "2" ] || fail "status stub exit $sc (want 2)"
grep -q 'SH-3b' "$SANDBOX/status.err" "$SANDBOX/status.out" || \
  fail "status stub should mention SH-3b"
pass "status stub points at SH-3b"

echo "[oort-doctor-test] PASS: $CASES case(s)"

#!/usr/bin/env bash
# Isolated red proofs for #2264 (scripts/oort doctor stack.outbox).
#
# Fixture-driven classify + one sabotage: delete the unconfigured-push
# branch and the no-relay pending case must go RED (fail instead of info).
set -euo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/../.." && pwd)"
DOCTOR="$REPO_ROOT/scripts/lib/oort_doctor.sh"
SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/oort-doctor-outbox.XXXXXX")"
cleanup() { rm -rf "$SANDBOX"; }
trap cleanup EXIT INT TERM
cd "$REPO_ROOT"

CASES=0
fail() { echo "[oort-doctor-outbox] FAIL: $*" >&2; exit 1; }
pass() { CASES=$((CASES + 1)); echo "[oort-doctor-outbox] ok: $*"; }

[ -f "$DOCTOR" ] || fail "missing $DOCTOR"
command -v python3 >/dev/null 2>&1 || fail "python3 is required"

bash -n "$DOCTOR" || fail "bash -n scripts/lib/oort_doctor.sh"
bash -n "$0" || fail "bash -n test_oort_doctor_outbox.sh"
pass "bash -n doctor lib and this harness"

# shellcheck source=../lib/oort_doctor.sh
# shellcheck disable=SC1091
. "$DOCTOR"

# -----------------------------------------------------------------------------
# 1. 미구성 + push_candidate pending → info (count, not fail)
# -----------------------------------------------------------------------------
oort_doctor_classify_outbox 0 <<EOF
$(printf 'push_candidate\tpending\t4\nbroadcast\tdone\t4\n')
EOF
[ "$OORT_DOCTOR_OUTBOX_STATUS" = "info" ] || \
  fail "unconfigured push pending want info, got $OORT_DOCTOR_OUTBOX_STATUS ($OORT_DOCTOR_OUTBOX_DETAIL)"
[ "$OORT_DOCTOR_OUTBOX_SEVERITY" = "minor" ] || \
  fail "unconfigured push pending severity want minor, got $OORT_DOCTOR_OUTBOX_SEVERITY"
printf '%s' "$OORT_DOCTOR_OUTBOX_DETAIL" | grep -Eq '4|pending' || \
  fail "info detail must name the pending count: $OORT_DOCTOR_OUTBOX_DETAIL"
printf '%s' "$OORT_DOCTOR_OUTBOX_DETAIL" | grep -Eqi 'push relay|push-relay|PUSH_RELAY|docker-compose.push' || \
  fail "info detail must state the no-relay rule: $OORT_DOCTOR_OUTBOX_DETAIL"
pass "fixture 1: unconfigured + push_candidate pending → info"

# -----------------------------------------------------------------------------
# 2. 구성 + push_candidate pending → fail
# -----------------------------------------------------------------------------
oort_doctor_classify_outbox 1 <<EOF
$(printf 'push_candidate\tpending\t4\nbroadcast\tdone\t4\n')
EOF
[ "$OORT_DOCTOR_OUTBOX_STATUS" = "fail" ] || \
  fail "configured push pending want fail, got $OORT_DOCTOR_OUTBOX_STATUS"
[ "$OORT_DOCTOR_OUTBOX_SEVERITY" = "major" ] || \
  fail "configured push pending severity want major, got $OORT_DOCTOR_OUTBOX_SEVERITY"
printf '%s' "$OORT_DOCTOR_OUTBOX_DETAIL" | grep -Eq 'push_candidate|pending|4' || \
  fail "configured fail detail must list push_candidate: $OORT_DOCTOR_OUTBOX_DETAIL"
pass "fixture 2: configured + push_candidate pending → fail"

# -----------------------------------------------------------------------------
# 3. 오래된 agent_job pending → major (values listed)
# -----------------------------------------------------------------------------
oort_doctor_classify_outbox 0 <<EOF
$(printf 'agent_job\tpending\t1\t600\n')
EOF
[ "$OORT_DOCTOR_OUTBOX_STATUS" = "fail" ] || \
  fail "stale agent_job want fail, got $OORT_DOCTOR_OUTBOX_STATUS ($OORT_DOCTOR_OUTBOX_DETAIL)"
[ "$OORT_DOCTOR_OUTBOX_SEVERITY" = "major" ] || \
  fail "stale agent_job severity want major, got $OORT_DOCTOR_OUTBOX_SEVERITY"
printf '%s' "$OORT_DOCTOR_OUTBOX_DETAIL" | grep -Fq 'agent_job|pending|1' || \
  fail "stale agent_job detail must list kind|status|count: $OORT_DOCTOR_OUTBOX_DETAIL"
printf '%s' "$OORT_DOCTOR_OUTBOX_DETAIL" | grep -Eq 'max_age=600s' || \
  fail "stale agent_job detail must list max age: $OORT_DOCTOR_OUTBOX_DETAIL"
pass "fixture 3: stale agent_job pending → major with values listed"

# Young agent_job is info, not fail (the measured E2E-B pending=1 case).
oort_doctor_classify_outbox 0 <<EOF
$(printf 'agent_job\tpending\t1\t12\npush_candidate\tpending\t4\n')
EOF
[ "$OORT_DOCTOR_OUTBOX_STATUS" = "info" ] || \
  fail "young agent_job + unconfigured push want info, got $OORT_DOCTOR_OUTBOX_STATUS ($OORT_DOCTOR_OUTBOX_DETAIL)"
printf '%s' "$OORT_DOCTOR_OUTBOX_DETAIL" | grep -Fq 'agent_job|pending|1' || \
  fail "young mix must still name agent_job: $OORT_DOCTOR_OUTBOX_DETAIL"
pass "young agent_job + unconfigured push_candidate → info"

# Empty successful query is pass (not skip-on-empty-stdout).
oort_doctor_classify_outbox 0 <<EOF
EOF
[ "$OORT_DOCTOR_OUTBOX_STATUS" = "pass" ] || \
  fail "empty outbox want pass, got $OORT_DOCTOR_OUTBOX_STATUS"
pass "empty GROUP BY result → pass"

# Exec skip reasons (contract item 3) — no live docker required.
oort_doctor_apply_outbox_query 0 2 running starting \
  'psql: error: connection to server on socket failed: No such file or directory' <<EOF
EOF
[ "$OORT_DOCTOR_OUTBOX_STATUS" = "skip" ] || \
  fail "starting postgres want skip, got $OORT_DOCTOR_OUTBOX_STATUS"
printf '%s' "$OORT_DOCTOR_OUTBOX_DETAIL" | grep -Fq '아직 준비되지 않음(재시도)' || \
  fail "starting skip must name retry: $OORT_DOCTOR_OUTBOX_DETAIL"
pass "postgres starting → skip 재시도"

oort_doctor_apply_outbox_query 0 0 running healthy "" <<EOF
EOF
[ "$OORT_DOCTOR_OUTBOX_STATUS" = "pass" ] || \
  fail "healthy empty query want pass, got $OORT_DOCTOR_OUTBOX_STATUS"
pass "healthy empty stdout rc=0 → pass (not postgres-exec skip)"

oort_doctor_apply_outbox_query 0 1 running healthy \
  'ERROR:  relation "outbox" does not exist' <<EOF
EOF
[ "$OORT_DOCTOR_OUTBOX_STATUS" = "skip" ] || \
  fail "missing outbox table want skip, got $OORT_DOCTOR_OUTBOX_STATUS"
printf '%s' "$OORT_DOCTOR_OUTBOX_DETAIL" | grep -Eq 'migrate|테이블' || \
  fail "missing table skip must name migrate: $OORT_DOCTOR_OUTBOX_DETAIL"
pass "missing outbox relation → skip migrate 대기"

# -----------------------------------------------------------------------------
# Sabotage: strip the unconfigured-push branch → fixture 1 goes RED
# -----------------------------------------------------------------------------
SAB="$SANDBOX/oort_doctor_sabotaged.sh"
cp "$DOCTOR" "$SAB"
python3 - "$SAB" <<'PY'
import pathlib
import re
import sys

path = pathlib.Path(sys.argv[1])
text = path.read_text(encoding="utf-8")
new, n = re.subn(
    r"[ \t]*# BEGIN oort-doctor-unconfigured-push.*?#[ \t]*END oort-doctor-unconfigured-push\n",
    "",
    text,
    count=1,
    flags=re.S,
)
if n != 1:
    raise SystemExit(f"expected 1 unconfigured-push block, stripped {n}")
path.write_text(new, encoding="utf-8")
PY
if grep -F 'BEGIN oort-doctor-unconfigured-push' "$SAB" >/dev/null 2>&1; then
  fail "sabotage left the unconfigured-push markers in place"
fi
# shellcheck disable=SC1090
. "$SAB"
oort_doctor_classify_outbox 0 <<EOF
$(printf 'push_candidate\tpending\t4\nbroadcast\tdone\t4\n')
EOF
if [ "$OORT_DOCTOR_OUTBOX_STATUS" = "info" ]; then
  fail "sabotage stayed green (unconfigured push still info) — branch is not load-bearing"
fi
[ "$OORT_DOCTOR_OUTBOX_STATUS" = "fail" ] || \
  fail "sabotage want fail, got $OORT_DOCTOR_OUTBOX_STATUS ($OORT_DOCTOR_OUTBOX_DETAIL)"
pass "sabotage: remove unconfigured-push branch → RED (fail not info)"

echo "[oort-doctor-outbox] PASS: $CASES case(s)"

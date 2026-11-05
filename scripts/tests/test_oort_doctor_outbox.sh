#!/usr/bin/env bash
# Isolated red proofs for #2264 (scripts/oort doctor stack.outbox).
#
# Fixture-driven classify + one sabotage: delete the unconfigured-push
# branch and the no-relay pending case must go RED (fail instead of info).
#
# #5353 (ADR-0206 D4): a push_candidate the notifier handed back to wait out a member's phone delay
# (pending, available_at still in the future) is labelled pending_deferred by the SQL and is info, not
# FAIL, even with a push relay configured. The classifier is checked by fixtures and a sabotage
# below; the label itself is checked against a real Postgres when OORT_DOCTOR_TEST_PG_URL names one
# (any database: the probe uses a TEMP table called outbox, so it reads and writes nothing real),
# and is skipped with a message otherwise.
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
# push_system (ADR-0206 D15, #4341): a push that names no message — the test push.
# No relay configured → info (as push_candidate); relay configured → by age (as agent_job).
# -----------------------------------------------------------------------------
oort_doctor_classify_outbox 0 <<EOF
$(printf 'push_system\tpending\t2\t900\n')
EOF
[ "$OORT_DOCTOR_OUTBOX_STATUS" = "info" ] || \
  fail "push_system with no relay want info (nothing can drain it), got $OORT_DOCTOR_OUTBOX_STATUS ($OORT_DOCTOR_OUTBOX_DETAIL)"
printf '%s' "$OORT_DOCTOR_OUTBOX_DETAIL" | grep -Fq 'push_system|pending|2' || \
  fail "push_system info detail must name the row: $OORT_DOCTOR_OUTBOX_DETAIL"
if printf '%s' "$OORT_DOCTOR_OUTBOX_DETAIL" | grep -Fq 'push_candidate'; then
  fail "a push_system row must not be explained as push_candidate: $OORT_DOCTOR_OUTBOX_DETAIL"
fi
pass "fixture 4: no relay + old push_system pending → info (not the permanent FAIL)"

oort_doctor_classify_outbox 1 <<EOF
$(printf 'push_system\tpending\t1\t20\n')
EOF
[ "$OORT_DOCTOR_OUTBOX_STATUS" = "info" ] || \
  fail "young push_system with a relay want info (in flight), got $OORT_DOCTOR_OUTBOX_STATUS ($OORT_DOCTOR_OUTBOX_DETAIL)"
pass "fixture 5: relay + young push_system pending → info (in flight)"

oort_doctor_classify_outbox 1 <<EOF
$(printf 'push_system\tpending\t1\t600\n')
EOF
[ "$OORT_DOCTOR_OUTBOX_STATUS" = "fail" ] || \
  fail "stale push_system with a relay want fail, got $OORT_DOCTOR_OUTBOX_STATUS ($OORT_DOCTOR_OUTBOX_DETAIL)"
printf '%s' "$OORT_DOCTOR_OUTBOX_DETAIL" | grep -Fq 'push_system|pending|1 max_age=600s' || \
  fail "stale push_system detail must list kind|status|count and its age: $OORT_DOCTOR_OUTBOX_DETAIL"
pass "fixture 6: relay + stale push_system pending → fail with the age listed"

oort_doctor_classify_outbox 1 <<EOF
$(printf 'push_system\tfailed\t1\t3600\nbroadcast\tdone\t9\n')
EOF
[ "$OORT_DOCTOR_OUTBOX_STATUS" = "fail" ] || \
  fail "an old failed push_system with a relay want fail, got $OORT_DOCTOR_OUTBOX_STATUS"
pass "fixture 7: relay + old failed push_system → fail"

# The two rules do not leak into each other: with a relay, a young push_system beside a
# push_candidate is still the candidate's FAIL, and the candidate's own row is still named.
oort_doctor_classify_outbox 1 <<EOF
$(printf 'push_candidate\tpending\t3\nbroadcast\tdone\t9\npush_system\tpending\t1\t20\n')
EOF
[ "$OORT_DOCTOR_OUTBOX_STATUS" = "fail" ] || \
  fail "push_candidate pending with a relay is still fail, got $OORT_DOCTOR_OUTBOX_STATUS"
printf '%s' "$OORT_DOCTOR_OUTBOX_DETAIL" | grep -Fq 'push_candidate|pending|3' || \
  fail "the candidate row must still be listed: $OORT_DOCTOR_OUTBOX_DETAIL"
pass "fixture 8: relay + push_candidate pending + young push_system → still the candidate's fail"

# -----------------------------------------------------------------------------
# push_candidate waiting out a phone delay (ADR-0206 D4, #5353): the SQL labels a pending
# push_candidate whose available_at is still in the future `pending_deferred`.
# -----------------------------------------------------------------------------
oort_doctor_classify_outbox 1 <<EOF
$(printf 'push_candidate\tpending_deferred\t2\t45\nbroadcast\tdone\t9\n')
EOF
[ "$OORT_DOCTOR_OUTBOX_STATUS" = "info" ] || \
  fail "a delayed push_candidate with a relay want info, got $OORT_DOCTOR_OUTBOX_STATUS ($OORT_DOCTOR_OUTBOX_DETAIL)"
[ "$OORT_DOCTOR_OUTBOX_SEVERITY" = "minor" ] || \
  fail "a delayed push_candidate severity want minor, got $OORT_DOCTOR_OUTBOX_SEVERITY"
printf '%s' "$OORT_DOCTOR_OUTBOX_DETAIL" | grep -Fq 'push_candidate|pending_deferred|2' || \
  fail "the delayed row must still be named: $OORT_DOCTOR_OUTBOX_DETAIL"
pass "fixture 9: relay + delayed push_candidate → info (a phone delay is not a stuck notifier)"

oort_doctor_classify_outbox 0 <<EOF
$(printf 'push_candidate\tpending_deferred\t2\t45\n')
EOF
[ "$OORT_DOCTOR_OUTBOX_STATUS" = "info" ] || \
  fail "a delayed push_candidate with no relay want info, got $OORT_DOCTOR_OUTBOX_STATUS"
if printf '%s' "$OORT_DOCTOR_OUTBOX_DETAIL" | grep -Fqi 'no push relay'; then
  fail "a delayed row is not 'pending with no relay' and must not be explained that way: $OORT_DOCTOR_OUTBOX_DETAIL"
fi
pass "fixture 10: no relay + delayed push_candidate → info without the no-relay explanation"

# A delayed row never hides a due one: a pending row whose time has come and that nobody took is
# the notifier not draining, and keeps its FAIL; the delayed rows beside it are not counted as pending.
oort_doctor_classify_outbox 1 <<EOF
$(printf 'push_candidate\tpending\t1\t400\npush_candidate\tpending_deferred\t3\t20\n')
EOF
[ "$OORT_DOCTOR_OUTBOX_STATUS" = "fail" ] || \
  fail "a due pending push_candidate beside delayed ones with a relay want fail, got $OORT_DOCTOR_OUTBOX_STATUS ($OORT_DOCTOR_OUTBOX_DETAIL)"
printf '%s' "$OORT_DOCTOR_OUTBOX_DETAIL" | grep -Fq 'push_candidate|pending|1' || \
  fail "the due row must be listed: $OORT_DOCTOR_OUTBOX_DETAIL"
printf '%s' "$OORT_DOCTOR_OUTBOX_DETAIL" | grep -Fq 'push_candidate pending=1' || \
  fail "only the due row counts as pending (not the 3 delayed): $OORT_DOCTOR_OUTBOX_DETAIL"
pass "fixture 11: relay + due pending beside delayed → still fail, counting only the due row"

# The label comes from the SQL: a structural check that runs everywhere (the real-Postgres probe
# below runs where OORT_DOCTOR_TEST_PG_URL is set).
SQL_TEXT="$(oort_doctor_outbox_sql)"
printf '%s' "$SQL_TEXT" | grep -Fq "available_at > now()" || \
  fail "the outbox SQL must separate rows whose available_at is in the future: $SQL_TEXT"
printf '%s' "$SQL_TEXT" | grep -Fq "'pending_deferred'" || \
  fail "the outbox SQL must label them pending_deferred: $SQL_TEXT"
pass "the outbox SQL labels future-available pending push_candidate rows pending_deferred"

# The previous SQL, kept to show the probe below can fail: no label, so a delayed row is `pending`.
OLD_OUTBOX_SQL="SELECT kind::text, status::text, count(*)::bigint, COALESCE(EXTRACT(EPOCH FROM (now() - min(COALESCE(lease_acquired_at, created_at))))::bigint, 0) FROM outbox GROUP BY 1, 2 ORDER BY 1, 2;"

# $1 = the SQL to run, $2 = with_due to add a pending row that is already due. Prints the grouped
# rows the doctor would read, from a TEMP outbox holding two delayed push_candidate rows, the due one
# when asked, and one done broadcast. TEMP: it shadows the real table for this session only.
oort_probe_outbox_rows() {
  local sql="$1" with_due="${2:-}"
  local due_row=""
  if [ "$with_due" = "with_due" ]; then
    due_row="('push_candidate', 'pending', now() - interval '1 minute', now() - interval '400 seconds', NULL),"
  fi
  psql "$OORT_DOCTOR_TEST_PG_URL" -v ON_ERROR_STOP=1 -X -q -At -F $'\t' -f - <<SQL
CREATE TEMP TABLE outbox (kind text, status text, available_at timestamptz, created_at timestamptz, lease_acquired_at timestamptz);
INSERT INTO outbox VALUES
  ${due_row}
  ('push_candidate', 'pending', now() + interval '1 minute', now() - interval '10 seconds', NULL),
  ('push_candidate', 'pending', now() + interval '50 seconds', now() - interval '20 seconds', NULL),
  ('broadcast', 'done', now(), now(), NULL);
${sql}
SQL
}

TAB=$'\t'
if [ -n "${OORT_DOCTOR_TEST_PG_URL:-}" ] && command -v psql >/dev/null 2>&1; then
  ROWS="$(oort_probe_outbox_rows "$SQL_TEXT")"
  printf '%s\n' "$ROWS" | grep -Fq "push_candidate${TAB}pending_deferred${TAB}2${TAB}" || \
    fail "real Postgres: two future-available pending rows must read pending_deferred|2: $ROWS"
  if printf '%s\n' "$ROWS" | grep -Fq "push_candidate${TAB}pending${TAB}"; then
    fail "real Postgres: no due row was inserted, so no bare pending row is expected: $ROWS"
  fi
  oort_doctor_classify_outbox 1 <<EOF
$ROWS
EOF
  [ "$OORT_DOCTOR_OUTBOX_STATUS" = "info" ] || \
    fail "real Postgres: delayed rows read through the real SQL want info, got $OORT_DOCTOR_OUTBOX_STATUS ($OORT_DOCTOR_OUTBOX_DETAIL)"
  pass "real Postgres: delayed rows → pending_deferred → info"

  ROWS="$(oort_probe_outbox_rows "$SQL_TEXT" with_due)"
  printf '%s\n' "$ROWS" | grep -Fq "push_candidate${TAB}pending${TAB}1${TAB}" || \
    fail "real Postgres: the due row must read as a bare pending|1: $ROWS"
  oort_doctor_classify_outbox 1 <<EOF
$ROWS
EOF
  [ "$OORT_DOCTOR_OUTBOX_STATUS" = "fail" ] || \
    fail "real Postgres: a due pending row beside delayed ones want fail, got $OORT_DOCTOR_OUTBOX_STATUS ($OORT_DOCTOR_OUTBOX_DETAIL)"
  pass "real Postgres: a due pending row beside delayed ones still fails"

  # Sabotage: the SQL without the label reads the delayed rows as plain pending - FAIL with a relay.
  ROWS="$(oort_probe_outbox_rows "$OLD_OUTBOX_SQL")"
  oort_doctor_classify_outbox 1 <<EOF
$ROWS
EOF
  if [ "$OORT_DOCTOR_OUTBOX_STATUS" = "info" ]; then
    fail "real Postgres sabotage stayed green - the label in the SQL is not load-bearing"
  fi
  [ "$OORT_DOCTOR_OUTBOX_STATUS" = "fail" ] || \
    fail "real Postgres sabotage want fail, got $OORT_DOCTOR_OUTBOX_STATUS ($OORT_DOCTOR_OUTBOX_DETAIL)"
  pass "sabotage: the SQL without the pending_deferred label → RED (the delayed rows fail)"
else
  echo "[oort-doctor-outbox] skip: real-Postgres probe of the pending_deferred label (set OORT_DOCTOR_TEST_PG_URL to run it)"
fi

# -----------------------------------------------------------------------------
# Sabotage: strip the deferred-push branch → fixture 9 goes RED (the generic rule fails it)
# -----------------------------------------------------------------------------
SAB3="$SANDBOX/oort_doctor_sabotaged_deferred_push.sh"
cp "$DOCTOR" "$SAB3"
python3 - "$SAB3" <<'PY'
import pathlib
import re
import sys

path = pathlib.Path(sys.argv[1])
text = path.read_text(encoding="utf-8")
new, n = re.subn(
    r"[ \t]*# BEGIN oort-doctor-deferred-push.*?#[ \t]*END oort-doctor-deferred-push\n",
    "",
    text,
    count=1,
    flags=re.S,
)
if n != 1:
    raise SystemExit(f"expected 1 deferred-push block, stripped {n}")
path.write_text(new, encoding="utf-8")
PY
if grep -F 'BEGIN oort-doctor-deferred-push' "$SAB3" >/dev/null 2>&1; then
  fail "sabotage left the deferred-push markers in place"
fi
# shellcheck disable=SC1090
. "$SAB3"
oort_doctor_classify_outbox 1 <<EOF
$(printf 'push_candidate\tpending_deferred\t2\t45\nbroadcast\tdone\t9\n')
EOF
if [ "$OORT_DOCTOR_OUTBOX_STATUS" = "info" ]; then
  fail "deferred-push sabotage stayed green - the branch is not load-bearing"
fi
[ "$OORT_DOCTOR_OUTBOX_STATUS" = "fail" ] || \
  fail "deferred-push sabotage want fail, got $OORT_DOCTOR_OUTBOX_STATUS ($OORT_DOCTOR_OUTBOX_DETAIL)"
pass "sabotage: remove the deferred-push branch → RED (fail not info)"

# The sabotages below source their own copies; load the real library again first.
# shellcheck disable=SC1090
. "$DOCTOR"

# -----------------------------------------------------------------------------
# Sabotage: strip the push_system branch → fixture 4 goes RED (the generic rule fails it)
# -----------------------------------------------------------------------------
SAB2="$SANDBOX/oort_doctor_sabotaged_push_system.sh"
cp "$DOCTOR" "$SAB2"
python3 - "$SAB2" <<'PY'
import pathlib
import re
import sys

path = pathlib.Path(sys.argv[1])
text = path.read_text(encoding="utf-8")
new, n = re.subn(
    r"[ \t]*# BEGIN oort-doctor-push-system.*?#[ \t]*END oort-doctor-push-system\n",
    "",
    text,
    count=1,
    flags=re.S,
)
if n != 1:
    raise SystemExit(f"expected 1 push-system block, stripped {n}")
path.write_text(new, encoding="utf-8")
PY
if grep -F 'BEGIN oort-doctor-push-system' "$SAB2" >/dev/null 2>&1; then
  fail "sabotage left the push-system markers in place"
fi
# shellcheck disable=SC1090
. "$SAB2"
oort_doctor_classify_outbox 0 <<EOF
$(printf 'push_system\tpending\t2\t900\n')
EOF
if [ "$OORT_DOCTOR_OUTBOX_STATUS" = "info" ]; then
  fail "push_system sabotage stayed green — the branch is not load-bearing"
fi
[ "$OORT_DOCTOR_OUTBOX_STATUS" = "fail" ] || \
  fail "push_system sabotage want fail, got $OORT_DOCTOR_OUTBOX_STATUS ($OORT_DOCTOR_OUTBOX_DETAIL)"
oort_doctor_classify_outbox 1 <<EOF
$(printf 'push_system\tpending\t1\t20\n')
EOF
[ "$OORT_DOCTOR_OUTBOX_STATUS" = "fail" ] || \
  fail "young push_system sabotage want fail (the generic rule), got $OORT_DOCTOR_OUTBOX_STATUS"
pass "sabotage: remove the push_system branch → RED (fail not info)"

# The original sabotage below sources its own copy; load the real library again first.
# shellcheck disable=SC1090
. "$DOCTOR"

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

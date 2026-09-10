#!/usr/bin/env bash
# #2193 R2: every table the notifier process actually queries must appear in
# bootstrap_runtime_roles.sql GRANT ON TABLE … TO momo_notifier. Next loop
# added to the binary cannot silently regress.
set -euo pipefail

ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd -P)"
cd "$ROOT"
BOOTSTRAP="$ROOT/infra/rust/sql/bootstrap_runtime_roles.sql"
fail() { printf '[test-notifier-role-grants] FAIL %s\n' "$*" >&2; exit 1; }
pass() { printf '[test-notifier-role-grants] ok: %s\n' "$*"; }

bash -n "$0"
[ -f "$BOOTSTRAP" ] || fail "missing $BOOTSTRAP"

if grep -E 'GRANT[[:space:]].*DELETE.*ON TABLE.*TO[[:space:]]+momo_notifier' "$BOOTSTRAP" >/dev/null; then
  fail "bootstrap GRANT list includes DELETE for momo_notifier"
fi
if grep -E 'GRANT[[:space:]].*ALL TABLES.*momo_notifier' "$BOOTSTRAP" >/dev/null; then
  fail "bootstrap grants ALL TABLES to momo_notifier"
fi
pass "bootstrap GRANT list has no DELETE / ALL TABLES for momo_notifier"

# shellcheck disable=SC1091
. "$ROOT/scripts/lib/oort_doctor.sh"
OORT_ROOT="$ROOT"
granted="$(oort_notifier_grant_tables "$BOOTSTRAP")"
[ -n "$granted" ] || fail "parsed zero GRANT ON TABLE lines"
printf '%s\n' "$granted" | grep -Fxq approval || fail "GRANT list missing approval"
printf '%s\n' "$granted" | grep -Fxq display_control_window || \
  fail "GRANT list missing display_control_window"
printf '%s\n' "$granted" | grep -Fxq work_session || fail "GRANT list missing work_session"
printf '%s\n' "$granted" | grep -Fxq work_control || fail "GRANT list missing work_control"
pass "parsed GRANT ON TABLE allowlist ($(printf '%s\n' "$granted" | grep -c .))"

real_tables="$(
  python3 - "$ROOT" <<'PY'
import pathlib, re, sys
root = pathlib.Path(sys.argv[1])
names = set()
pat = re.compile(r'CREATE TABLE(?: IF NOT EXISTS)?\s+(?:public\.)?([a-z][a-z0-9_]*)', re.I)
for path in [root / "schema_v0.sql", *sorted((root / "server/Migrations").glob("*.sql"))]:
    text = path.read_text(encoding="utf-8")
    names.update(pat.findall(text))
print("\n".join(sorted(names)))
PY
)"

referenced="$(
  python3 - "$ROOT" <<'PY'
import pathlib, re, sys
root = pathlib.Path(sys.argv[1])
files = [
    *sorted((root / "server-rust/bins/momo-notifier/src").glob("*.rs")),
    root / "server-rust/crates/momo-t3/src/reconcile.rs",
    root / "server-rust/crates/momo-t3/src/sweep.rs",
    root / "server-rust/crates/momo-t3/src/lease.rs",
    root / "server-rust/crates/momo-t3/src/billing.rs",
    root / "server-rust/crates/momo-t3/src/display_control.rs",
    root / "server-rust/crates/momo-agent/src/approval.rs",
    root / "server-rust/crates/momo-agent/src/run.rs",
    root / "server-rust/crates/momo-push/src/candidate.rs",
    root / "server-rust/crates/momo-push/src/dispatch.rs",
    root / "server-rust/crates/momo-push/src/dispatch_log.rs",
    root / "server-rust/crates/momo-push/src/judgment.rs",
    root / "server-rust/crates/momo-outbox/src/emit.rs",
    root / "server-rust/crates/momo-outbox/src/push.rs",
]
pat = re.compile(
    r'(?i)(?:\bFROM|\bJOIN|\bINTO|\bUPDATE|\bTABLE)\s+(?:ONLY\s+)?(?:public\.)?([a-z][a-z0-9_]*)'
)
skip = {
    "select", "only", "lateral", "unnest", "generate_series", "json_each_text",
    "jsonb_each", "jsonb_array_elements", "information_schema", "pg_catalog",
    "pg_roles", "pg_proc", "pg_stat_activity", "pg_locks",
    # Same crate file, not on the notifier call graph (eligibility / human
    # decision / hosted-delivery). work_control IS on the graph (control-window
    # resume joins it) and must stay in the GRANT list.
    "agent_profile", "hosted_agent_connection", "approval_decision",
}
found = set()
for path in files:
    text = path.read_text(encoding="utf-8")
    for name in pat.findall(text):
        if name.lower() not in skip:
            found.add(name.lower())
print("\n".join(sorted(found)))
PY
)"

missing=""
while IFS= read -r table; do
  [ -n "$table" ] || continue
  printf '%s\n' "$real_tables" | grep -Fxq "$table" || continue
  printf '%s\n' "$granted" | grep -Fxq "$table" && continue
  missing="${missing} ${table}"
done <<EOF
$referenced
EOF
missing="$(printf '%s' "$missing" | awk '{$1=$1; print}')"
[ -z "$missing" ] || fail "notifier SQL tables missing from GRANT list:${missing}"
pass "every referenced public table is in the GRANT list"

# Sabotage: drop approval from the GRANT list → this harness RED.
sabotaged="$(printf '%s\n' "$granted" | grep -vx approval || true)"
printf '%s\n' "$sabotaged" | grep -Fxq approval && fail "sabotage grep -vx approval still lists it"
printf '%s\n' "$referenced" | grep -Fxq approval || fail "notifier SQL no longer names approval"
printf '%s\n' "$real_tables" | grep -Fxq approval || fail "approval is not a public table"
if printf '%s\n' "$sabotaged" | grep -Fxq approval; then
  fail "unreachable"
fi
# Reconstruct the same missing check against the sabotaged list.
if printf '%s\n' "$referenced" | grep -Fxq approval && \
   printf '%s\n' "$real_tables" | grep -Fxq approval && \
   ! printf '%s\n' "$sabotaged" | grep -Fxq approval; then
  pass "sabotage drop approval from GRANT list → would RED"
else
  fail "sabotage drop approval did not produce a miss"
fi
echo "[test-notifier-role-grants] PASS"

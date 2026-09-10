#!/usr/bin/env bash
# #2448 / #2193 R2: every SQL statement the notifier process can execute at
# runtime must be granted on momo_notifier, verb by verb — not just table
# presence. Scan scope is defined once (python SCAN_SCOPE) and printed.
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
printf '%s\n' "$granted" | grep -Fxq workspace && \
  fail "GRANT list still has workspace (trimmed in #2448; topup_credit is REST-only)"
printf '%s\n' "$granted" | grep -Fxq work_pool && \
  fail "GRANT list still has work_pool (trimmed in #2448; lock_work_pool=false on notifier)"
pass "parsed GRANT ON TABLE allowlist ($(printf '%s\n' "$granted" | grep -c .))"

python3 - "$ROOT" "$BOOTSTRAP" <<'PY'
import pathlib, re, sys

root = pathlib.Path(sys.argv[1])
bootstrap = pathlib.Path(sys.argv[2])

# ---------------------------------------------------------------------------
# SCAN SCOPE — the one place that defines over-grant / under-grant.
# Printed at start. A table/verb is "used" iff a statement in this scope
# names it. Files mixed with REST/worker SQL are sliced to the functions
# the notifier actually calls (cite the call edge in `why`).
# ---------------------------------------------------------------------------
SCAN_SCOPE = [
    {
        "path": "server-rust/bins/momo-notifier/src/*.rs",
        "mode": "all",
        "why": (
            "process loops: push drain, approval sweep, control-window sweep, "
            "T3 reconcile/sweep/lease supervision "
            "(lib.rs:226 reconcile_once, :425 sweep_once, :505 renew_leases_once, "
            ":673 approval_sweep::sweep_expired_approvals, "
            ":703 control_window_sweep::sweep_lapsed_control_windows, "
            "push.rs:85 drain_once). Binary owns no SQL of its own."
        ),
    },
    {
        "path": "server-rust/crates/momo-t3/src/reconcile.rs",
        "mode": "all",
        "why": "lib.rs:69-71 due_lifecycle_candidates / claim_lifecycle_intent / apply_convergence_to_intent",
    },
    {
        "path": "server-rust/crates/momo-t3/src/sweep.rs",
        "mode": "all",
        "why": "lib.rs:73 stale_session_candidates / converge_stale_session",
    },
    {
        "path": "server-rust/crates/momo-t3/src/lease.rs",
        "mode": "all",
        "why": "lib.rs:68 renewable_lease_candidates (SELECT only; writes nothing)",
    },
    {
        "path": "server-rust/crates/momo-t3/src/lifecycle.rs",
        "mode": "symbols",
        "symbols": [
            "acquire_host_advisories",
            "acquire_row_ladder",
            "with_t3_lifecycle_tx",
            "terminate_in_tx",
            "transition_cloud_host_in_tx",
        ],
        "strip_lock_work_pool": True,
        "why": (
            "reconcile.rs:192 / :310 and sweep.rs:221 with_t3_lifecycle_tx; "
            "terminate_in_tx from sweep.rs:265 and reconcile.rs:442; "
            "transition_cloud_host_in_tx from confirm/revert/terminate_missing. "
            "`if lock_work_pool` SQL is stripped: every notifier ladder is "
            "T3LockLadder::host or .with_workspace_credit() (lock_work_pool=false; "
            "lifecycle.rs:149, 302-306, sweep.rs:224)."
        ),
    },
    {
        "path": "server-rust/crates/momo-t3/src/billing.rs",
        "mode": "symbols",
        "symbols": [
            "pause_usage_in_tx",
            "resume_usage_in_tx",
            "lock_open_usage",
            "transition_interval",
        ],
        "why": (
            "reconcile.rs:382-388 confirm_lifecycle_operation_in_tx → "
            "pause_usage_in_tx / resume_usage_in_tx. Not scanned: "
            "topup_credit_in_tx (momo-server credits.rs; SELECT workspace), "
            "reserve_provisioning_slot_in_tx / acquire_slot_in_tx / start_usage_in_tx "
            "(REST / agent-worker admission)."
        ),
    },
    {
        "path": "server-rust/crates/momo-t3/src/display_control.rs",
        "mode": "symbols",
        "symbols": [
            "RESTORE_OBSERVATION_CTE",
            "workspaces_with_lapsed_control_windows",
            "expire_lapsed_control_windows_for_workspace_in_tx",
            "stamp_control_window_on_cards_in_tx",
        ],
        "why": "control_window_sweep.rs:73-75 expire/stamp/workspaces_with_lapsed",
    },
    {
        "path": "server-rust/crates/momo-agent/src/approval.rs",
        "mode": "symbols",
        "symbols": [
            "lock_approval_in_tx",
            "mark_approval_expired_in_tx",
            "overdue_approvals_in_tx",
            "workspaces_with_overdue_approvals",
        ],
        "why": "approval_sweep.rs:42-44, :78, :128, :163. Not scanned: create_pending / approval_decision (REST).",
    },
    {
        "path": "server-rust/crates/momo-agent/src/run.rs",
        "mode": "symbols",
        "symbols": [
            "RUN_DRIVES_SESSION",
            "end_parked_run_in_tx",
            "lock_driver_runs_in_tx",
            "resume_runs_from_control_window_in_tx",
        ],
        "why": (
            "approval_sweep.rs:169 end_parked_run_in_tx; "
            "control_window_sweep.rs:67 resume_runs_from_control_window_in_tx "
            "(audit_log ⋈ work_control SELECT)."
        ),
    },
    {
        "path": "server-rust/crates/momo-push/src/judgment.rs",
        "mode": "all",
        "why": "push.rs:139 judge_targets / :212 unread_badge",
    },
    {
        "path": "server-rust/crates/momo-push/src/dispatch_log.rs",
        "mode": "all",
        "why": "push.rs:200 claim_dispatch / :304 settle_dispatch",
    },
    {
        "path": "server-rust/crates/momo-outbox/src/emit.rs",
        "mode": "all",
        "why": "approval_sweep.rs:194 and control_window_sweep.rs:238 emit_outbox",
    },
    {
        "path": "server-rust/crates/momo-outbox/src/push.rs",
        "mode": "all",
        "why": "push.rs:36 claim_push_candidate_batch / reclaim_stuck_push_candidates",
    },
    {
        "path": "server-rust/crates/momo-outbox/src/relay.rs",
        "mode": "symbols",
        "symbols": ["mark_done", "mark_failed", "requeue"],
        "why": "push.rs:36 mark_done / mark_failed / requeue (shared outbox settle)",
    },
    {
        "path": "server-rust/crates/momo-db/src/audit.rs",
        "mode": "all",
        "why": "approval_sweep.rs:245 write_audit; control_window_sweep.rs:214 write_audit",
    },
    {
        "path": "server-rust/crates/momo-messaging/src/message.rs",
        "mode": "symbols",
        "symbols": ["insert_message_in_tx", "send_message_in_tx"],
        "why": (
            "approval_sweep.rs:222 send_message_in_tx → insert_message_in_tx "
            "(UPDATE channel_seq + INSERT message). Thread/attachment SQL is REST-only."
        ),
    },
    {
        "path": "server-rust/crates/momo-messaging/src/interaction.rs",
        "mode": "symbols",
        "symbols": ["reread_interaction_in_tx", "emit_message_edited_in_tx"],
        "why": "control_window_sweep.rs:70 emit_message_edited_in_tx after stamp",
    },
    {
        "path": "server/Migrations/058_t3_interval_micro_precision.sql",
        "mode": "sql_function",
        "symbols": ["t3_terminate"],
        "why": "lifecycle.rs:1214 SELECT t3_terminate(); function is SECURITY INVOKER (GRANT EXECUTE in bootstrap)",
    },
    {
        "path": "server/Migrations/057_t3_lifecycle_deadline.sql",
        "mode": "sql_function",
        "symbols": ["t3_claim_lifecycle_operation", "t3_lifecycle_intent_is_current"],
        "why": "reconcile.rs:216 t3_claim_lifecycle_operation; :252 t3_lifecycle_intent_is_current",
    },
    {
        "path": "server/Migrations/045_t3_provisioner_credit_ledger.sql",
        "mode": "sql_function",
        "symbols": ["apply_credit_entry"],
        "why": (
            "AFTER INSERT ON credit_entry trigger. t3_terminate INSERTs credit_entry "
            "(058:240) and this function runs as momo_notifier (no SECURITY DEFINER). "
            "INSERT … ON CONFLICT DO UPDATE on workspace_credit — PG requires INSERT "
            "privilege even when the existing row takes the UPDATE path."
        ),
    },
]

NOT_SCANNED = [
    "momo-t3/reattach.rs, terminal_attach.rs, work_control.rs, provision.rs, cloud_host.rs — R2: not on the notifier call graph",
    "billing.rs topup/admission/start_usage — REST / agent-worker",
    "approval.rs create_pending / approval_decision — REST human decision",
    "message.rs thread/attachment/list — REST send extras; notifier uses ThreadPolicy::Skip",
]

SKIP_IDENT = {
    "select", "only", "lateral", "unnest", "generate_series", "json_each_text",
    "jsonb_each", "jsonb_array_elements", "jsonb_array_elements_text",
    "information_schema", "pg_catalog", "pg_roles", "pg_proc",
    "pg_stat_activity", "pg_locks", "as", "on", "set", "values",
}

ITEM_RE = re.compile(
    r'(?m)^((?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:fn|const)\s+([A-Za-z0-9_]+))'
)
GRANT_RE = re.compile(
    r'GRANT\s+(.+?)\s+ON TABLE\s+([a-z][a-z0-9_]*)\s+TO\s+momo_notifier',
    re.I,
)
FUNC_RE = re.compile(
    r'CREATE(?:\s+OR\s+REPLACE)?\s+FUNCTION\s+([a-z_][a-z0-9_]*)\s*\(.*?\$\$(.*?)\$\$',
    re.I | re.S,
)
INSERT_RE = re.compile(
    r'(?i)\bINSERT\s+INTO\s+(?:ONLY\s+)?(?:public\.)?([a-z][a-z0-9_]*)\b'
)
INSERT_UPSERT_RE = re.compile(
    r'(?i)\bINSERT\s+INTO\s+(?:ONLY\s+)?(?:public\.)?([a-z][a-z0-9_]*)\b'
    r'[\s\S]{0,800}?\bON\s+CONFLICT\b[\s\S]{0,400}?\bDO\s+UPDATE\b'
)
UPDATE_RE = re.compile(
    r'(?i)\bUPDATE\s+(?:ONLY\s+)?(?:public\.)?([a-z][a-z0-9_]*)\b'
)
DELETE_RE = re.compile(
    r'(?i)\bDELETE\s+FROM\s+(?:ONLY\s+)?(?:public\.)?([a-z][a-z0-9_]*)\b'
)
FROM_RE = re.compile(
    r'(?i)\b(?:FROM|JOIN)\s+(?:ONLY\s+)?(?:public\.)?([a-z][a-z0-9_]*)\b'
)
CTE_RE = re.compile(r'(?i)\b([a-z][a-z0-9_]*)\s+AS\s*\(')
CREATE_TABLE_RE = re.compile(
    r'CREATE TABLE(?: IF NOT EXISTS)?\s+(?:public\.)?([a-z][a-z0-9_]*)',
    re.I,
)


def fail(msg):
    print(f"[test-notifier-role-grants] FAIL {msg}", file=sys.stderr)
    sys.exit(1)


def brace_cut(text, start):
    depth = 0
    i = start
    while i < len(text):
        ch = text[i]
        if ch == '{':
            depth += 1
        elif ch == '}':
            depth -= 1
            if depth == 0:
                return i + 1
        i += 1
    return len(text)


def strip_cfg_test(text):
    out = []
    i = 0
    needle = "#[cfg(test)]"
    while True:
        j = text.find(needle, i)
        if j < 0:
            out.append(text[i:])
            break
        out.append(text[i:j])
        k = text.find('{', j)
        if k < 0:
            break
        i = brace_cut(text, k)
    return "".join(out)


def strip_lock_work_pool(text):
    out = []
    i = 0
    needle = "if lock_work_pool"
    while True:
        j = text.find(needle, i)
        if j < 0:
            out.append(text[i:])
            break
        out.append(text[i:j])
        k = text.find('{', j)
        if k < 0:
            out.append(text[j:])
            break
        i = brace_cut(text, k)
    return "".join(out)


def slice_symbols(text, names):
    wanted = set(names)
    matches = list(ITEM_RE.finditer(text))
    chunks = []
    for i, m in enumerate(matches):
        if m.group(2) not in wanted:
            continue
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        chunks.append(text[m.start():end])
    missing = wanted - {m.group(2) for m in matches}
    if missing:
        fail(f"scan symbols not found: {sorted(missing)}")
    return "\n".join(chunks)


def expand_glob(rel):
    path = root / rel
    if "*" in rel:
        parent = path.parent
        pattern = path.name
        found = sorted(parent.glob(pattern))
        if not found:
            fail(f"scan glob matched nothing: {rel}")
        return found
    if not path.is_file():
        fail(f"scan path missing: {rel}")
    return [path]


def load_sql_functions(text, names):
    found = {m.group(1).lower(): m.group(2) for m in FUNC_RE.finditer(text)}
    chunks = []
    for name in names:
        body = found.get(name.lower())
        if body is None:
            fail(f"SQL function {name} not found in scanned migration")
        chunks.append(body)
    return "\n".join(chunks)


def corpus_for(entry, extra_text=""):
    pieces = []
    for path in expand_glob(entry["path"]):
        text = path.read_text(encoding="utf-8")
        if path.suffix == ".rs":
            text = strip_cfg_test(text)
        if entry.get("strip_lock_work_pool"):
            text = strip_lock_work_pool(text)
        mode = entry["mode"]
        if mode == "all":
            pieces.append(text)
        elif mode == "symbols":
            pieces.append(slice_symbols(text, entry["symbols"]))
        elif mode == "sql_function":
            pieces.append(load_sql_functions(text, entry["symbols"]))
        else:
            fail(f"unknown scan mode {mode}")
    if extra_text:
        pieces.append(extra_text)
    return "\n".join(pieces)


def next_nonspace(sql, idx):
    while idx < len(sql) and sql[idx].isspace():
        idx += 1
    return idx


def parse_verbs(sql):
    used = {}
    deletes = []
    ctes = {m.group(1).lower() for m in CTE_RE.finditer(sql)}

    def add(table, verb):
        table = table.lower()
        if table in SKIP_IDENT or table in ctes:
            return
        used.setdefault(table, set()).add(verb)

    for m in INSERT_RE.finditer(sql):
        add(m.group(1), "INSERT")
    # INSERT … ON CONFLICT DO UPDATE needs INSERT+UPDATE (+ SELECT for the
    # conflict read). apply_credit_entry (045) is this shape on workspace_credit.
    for m in INSERT_UPSERT_RE.finditer(sql):
        add(m.group(1), "UPDATE")
        add(m.group(1), "SELECT")
    for m in UPDATE_RE.finditer(sql):
        add(m.group(1), "UPDATE")
    for m in DELETE_RE.finditer(sql):
        deletes.append(m.group(1).lower())
        add(m.group(1), "DELETE")
    for m in FROM_RE.finditer(sql):
        nxt = next_nonspace(sql, m.end())
        if nxt < len(sql) and sql[nxt] == "(":
            continue
        add(m.group(1), "SELECT")
    return used, deletes


def parse_grants(text):
    grants = {}
    for m in GRANT_RE.finditer(text):
        verbs_raw, table = m.group(1), m.group(2).lower()
        verbs = {v.strip().upper() for v in verbs_raw.split(",") if v.strip()}
        grants.setdefault(table, set()).update(verbs)
    return grants


def public_tables():
    names = set()
    for path in [root / "schema_v0.sql", *sorted((root / "server/Migrations").glob("*.sql"))]:
        names.update(CREATE_TABLE_RE.findall(path.read_text(encoding="utf-8")))
    return {n.lower() for n in names}


def collect_used(extra_by_path=None):
    used = {}
    deletes = []
    extra_by_path = extra_by_path or {}
    for entry in SCAN_SCOPE:
        extra = extra_by_path.get(entry["path"], "")
        verbs, dels = parse_verbs(corpus_for(entry, extra))
        deletes.extend(dels)
        for table, vs in verbs.items():
            used.setdefault(table, set()).update(vs)
    return used, deletes


def compare(used, grants, real):
    problems = []
    for table, verbs in sorted(used.items()):
        if table not in real:
            continue
        have = grants.get(table, set())
        if "DELETE" in verbs:
            problems.append(f"statement DELETE {table} is always forbidden")
        for verb in sorted(verbs):
            if verb == "DELETE":
                continue
            if verb not in have:
                have_s = ",".join(sorted(have)) if have else "(none)"
                problems.append(
                    f"statement {verb} {table} not in GRANT (have {have_s})"
                )
    for table, verbs in sorted(grants.items()):
        if "DELETE" in verbs:
            problems.append(f"GRANT DELETE ON TABLE {table}")
        used_verbs = used.get(table, set())
        if table in real and not used_verbs:
            problems.append(f"over-grant table {table} (no scanned statement uses it)")
            continue
        for verb in sorted(verbs):
            if verb == "SELECT":
                continue
            if verb == "DELETE":
                continue
            if verb not in used_verbs:
                problems.append(
                    f"over-grant {verb} ON {table} (no scanned statement uses it)"
                )
    return problems


print("[test-notifier-role-grants] scan scope:")
for entry in SCAN_SCOPE:
    mode = entry["mode"]
    extra = ""
    if mode == "symbols":
        extra = " symbols=" + ",".join(entry["symbols"])
    elif mode == "sql_function":
        extra = " functions=" + ",".join(entry["symbols"])
    print(f"  - {entry['path']} [{mode}{extra}]")
    print(f"      why: {entry['why']}")
print("[test-notifier-role-grants] not scanned:")
for line in NOT_SCANNED:
    print(f"  - {line}")

real = public_tables()
grants = parse_grants(bootstrap.read_text(encoding="utf-8"))
used, deletes = collect_used()
used_real = {t: v for t, v in used.items() if t in real}

if deletes:
    fail("DELETE statements in scan scope: " + ",".join(deletes))

problems = compare(used_real, grants, real)
if problems:
    fail("; ".join(problems))

print(
    "[test-notifier-role-grants] ok: every scanned statement verb ⊆ GRANT verbs "
    f"({len(used_real)} tables)"
)

# (a) UPDATE work_control SET x=1 inside a scanned notifier source → RED
used_a, _ = collect_used(
    extra_by_path={
        "server-rust/bins/momo-notifier/src/*.rs": "UPDATE work_control SET x=1"
    }
)
used_a = {t: v for t, v in used_a.items() if t in real}
probs_a = compare(used_a, grants, real)
if not any("statement UPDATE work_control" in p for p in probs_a):
    fail(
        "sabotage UPDATE work_control SET x=1 stayed GREEN "
        f"(problems={probs_a})"
    )
print(
    "[test-notifier-role-grants] ok: sabotage UPDATE work_control SET x=1 "
    f"in scanned source → RED ({[p for p in probs_a if 'work_control' in p][0]})"
)

# (b) remove UPDATE from the approval GRANT → RED
grants_b = {t: set(vs) for t, vs in grants.items()}
grants_b["approval"] = grants_b.get("approval", set()) - {"UPDATE"}
probs_b = compare(used_real, grants_b, real)
if not any("statement UPDATE approval" in p for p in probs_b):
    fail(f"sabotage drop UPDATE from approval GRANT stayed GREEN (problems={probs_b})")
print(
    "[test-notifier-role-grants] ok: sabotage drop UPDATE from approval GRANT → RED "
    f"({[p for p in probs_b if 'approval' in p][0]})"
)

# (c) add DELETE to any GRANT → RED
grants_c = {t: set(vs) for t, vs in grants.items()}
grants_c.setdefault("outbox", set()).add("DELETE")
probs_c = compare(used_real, grants_c, real)
if not any("GRANT DELETE ON TABLE outbox" in p for p in probs_c):
    fail(f"sabotage GRANT DELETE ON outbox stayed GREEN (problems={probs_c})")
print(
    "[test-notifier-role-grants] ok: sabotage GRANT DELETE ON outbox → RED "
    f"({[p for p in probs_c if 'DELETE' in p][0]})"
)

# (d) grant a table no statement uses (workspace after trim) → RED
grants_d = {t: set(vs) for t, vs in grants.items()}
grants_d["workspace"] = {"SELECT"}
probs_d = compare(used_real, grants_d, real)
if not any("over-grant table workspace" in p for p in probs_d):
    fail(f"sabotage GRANT workspace SELECT stayed GREEN (problems={probs_d})")
print(
    "[test-notifier-role-grants] ok: sabotage GRANT SELECT ON workspace "
    f"(no scanned statement) → RED ({[p for p in probs_d if 'workspace' in p][0]})"
)

# (d2) unused INSERT verb on a used table
grants_d2 = {t: set(vs) for t, vs in grants.items()}
grants_d2.setdefault("work_control", set()).add("INSERT")
probs_d2 = compare(used_real, grants_d2, real)
if not any("over-grant INSERT ON work_control" in p for p in probs_d2):
    fail(f"sabotage INSERT ON work_control stayed GREEN (problems={probs_d2})")
print(
    "[test-notifier-role-grants] ok: sabotage GRANT INSERT ON work_control "
    f"→ RED ({[p for p in probs_d2 if 'work_control' in p][0]})"
)

print("[test-notifier-role-grants] used verbs:")
for table in sorted(used_real):
    print(f"  {table}: {', '.join(sorted(used_real[table]))}")
PY

echo "[test-notifier-role-grants] PASS"

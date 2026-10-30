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
printf '%s\n' "$granted" | grep -Fxq work_cloud_host_transition || \
  fail "GRANT list missing work_cloud_host_transition"
printf '%s\n' "$granted" | grep -Fxq workspace && \
  fail "GRANT list has a table-level workspace grant (trimmed in #2448; the avatar reclaim read needs only the column, #3377)"
printf '%s\n' "$granted" | grep -Fxq work_pool && \
  fail "GRANT list still has work_pool (trimmed in #2448; lock_work_pool=false on notifier)"
# ADR-0186 증보 v5 U-f (#4702): the approval sweep never writes the proposer's hosted inbox
# (a lapse is told on a re-ask, not by a reference), and the notifier is BYPASSRLS, so it must
# not read credentials either. Opening these to make a sweep-side inbox write "work" is the
# wrong repair: the live check is prod_role_conformance_pg.
for denied_table in hosted_agent_inbox_event hosted_agent_inbox_counter token; do
  printf '%s\n' "$granted" | grep -Fxq "$denied_table" && \
    fail "GRANT list names $denied_table for momo_notifier (ADR-0186 v5 U-f: the sweep writes no inbox reference; no credential reads for a BYPASSRLS role)"
done
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
            "end_stalled_run_in_tx",
            "lock_driver_runs_in_tx",
            "resume_runs_from_control_window_in_tx",
            "run_trigger_message_in_tx",
        ],
        "why": (
            "approval_sweep.rs:169 end_parked_run_in_tx; "
            "run_stall_sweep.rs end_stalled_run_in_tx (ADR-0200 D1-4); "
            "control_window_sweep.rs:67 resume_runs_from_control_window_in_tx "
            "(audit_log ⋈ work_control SELECT); "
            "approval_sweep.rs / run_stall_sweep.rs run_trigger_message_in_tx "
            "(ADR-0204 D8, #3929: agent_run.trigger_message_id, stamped on the closing line)."
        ),
    },
    {
        "path": "server-rust/crates/momo-push/src/judgment.rs",
        "mode": "all",
        # #3553: the `wrun` arm only asks EXISTS (workspace_id, agent_member_id);
        # migration 120's agent_run trigger (derived below) asks the same.
        "column_reads": {"hosted_agent_connection": ["workspace_id", "agent_member_id"]},
        "why": "push.rs:139 judge_targets / :212 unread_badge",
    },
    {
        # ADR-0204 D7 (#3928): judge_targets narrows an approval's audience to the
        # people the decision route would let through, by calling the same reads the
        # route calls. approvers.rs holds no SQL of its own; the three scopes below
        # are the functions it calls.
        "path": "server-rust/crates/momo-push/src/approvers.rs",
        "mode": "all",
        "why": "judgment.rs judge_targets → may_approve_in_tx (no SQL; calls the three reads below)",
    },
    {
        "path": "server-rust/crates/momo-messaging/src/identity.rs",
        "mode": "symbols",
        "symbols": ["active_workspace_role"],
        # `SELECT wm.role … FROM workspace_membership wm JOIN member m ON
        # (workspace_id, id) WHERE wm.workspace_id AND wm.member_id` — and nothing else
        # of the table (joined_at / updated_at are never read), hence column grants.
        "column_reads": {"workspace_membership": ["workspace_id", "member_id", "role"]},
        "why": "approvers.rs CardAudience::allows: the agent-editor gate (require_profile_editor_in_tx calls this twin)",
    },
    {
        "path": "server-rust/crates/momo-auth/src/workspace_authorization.rs",
        "mode": "symbols",
        "symbols": ["active_workspace_role"],
        # The same statement as the messaging twin above: `require_admin` calls THIS
        # one, so the admin / operator arm of the audience does too.
        "column_reads": {"workspace_membership": ["workspace_id", "member_id", "role"]},
        "why": "approvers.rs CardAudience::allows: the admin gate (require_admin calls this twin)",
    },
    {
        "path": "server-rust/crates/momo-agent/src/provisioning.rs",
        "mode": "symbols",
        "symbols": ["agent_owner_in_tx"],
        "why": "approvers.rs may_approve_in_tx: the owner arm of require_profile_editor_in_tx (agent ⋈ member, both already granted)",
    },
    {
        "path": "server-rust/crates/momo-t3/src/work_control.rs",
        "mode": "symbols",
        "symbols": ["remote_host_owner_in_tx"],
        "why": "approvers.rs may_approve_in_tx: ADR-0188 D3 host owner (work_host, already granted)",
    },
    {
        "path": "server-rust/crates/momo-push/src/dispatch_log.rs",
        "mode": "all",
        "why": "push.rs:200 claim_dispatch / :304 settle_dispatch",
    },
    {
        "path": "server-rust/crates/momo-outbox/src/stalled.rs",
        "mode": "all",
        "why": (
            "notifier run_stall_sweep.rs (#3744, ADR-0200 D1-4): the cross-tenant stalled-run "
            "READ and the per-workspace row-locking candidate read (agent_run ⋈ outbox, "
            "FOR UPDATE OF r on the run the sweep is about to end)."
        ),
    },
    {
        # ADR-0200 증보 3 E1/E7 (#4284): the woken-not-collected verdict's reads. Column
        # grants only; `token` and `hosted_agent_doorbell` stay unreadable (asserted below).
        "path": "server-rust/crates/momo-agent/src/woken.rs",
        "mode": "all",
        "column_reads": {
            "hosted_agent_connection": ["workspace_id", "id", "agent_member_id", "status"],
            "hosted_agent_liveness": [
                "workspace_id", "connection_id", "last_inbox_read_at", "last_claim_at",
                "last_run_event_at", "last_ping_at", "last_ping_state", "last_tool_error_at",
            ],
            "hosted_agent_doorbell_ring": ["workspace_id", "connection_id", "requested_at"],
        },
        "why": (
            "notifier run_stall_sweep.rs woken_run_should_end_in_tx → "
            "active_hosted_connection_id_in_tx / load_woken_agent_facts_in_tx: the run's "
            "status and ledger (agent_run, agent_run_event: already granted), the agent's "
            "ACTIVE connection, its liveness row and the last manual ring."
        ),
    },
    {
        "path": "server-rust/crates/momo-outbox/src/gateway.rs",
        "mode": "symbols",
        "symbols": ["lock_woken_job_facts_in_tx"],
        # `trial_members_stop_sql!` is spliced into the statement by `concat!`, so its
        # text is not in this slice: `agent_provider_pin` is named here (`kind` is the only
        # column it reads) and `hosted_connection_channel_ids()` — an INVOKER function the
        # statement calls — reads three more columns of hosted_agent_connection.
        "literal_tables": ["agent_provider_pin"],
        "column_reads": {
            "agent_provider_pin": ["workspace_id", "agent_member_id", "kind"],
            "hosted_agent_connection": [
                "workspace_id", "agent_member_id", "id", "approved_scopes",
                "approved_channel_ids", "approved_dm_channel_ids", "confirmed_by",
            ],
        },
        "why": (
            "notifier run_stall_sweep.rs woken_run_should_end_in_tx → "
            "lock_woken_job_facts_in_tx: the delivery job row (outbox FOR UPDATE, already "
            "granted) and oort's own claimability (agent, member, agent_run, "
            "hosted_agent_connection scope + channels), without the token join."
        ),
    },
    {
        "path": "server-rust/crates/momo-outbox/src/agent_job.rs",
        "mode": "symbols",
        "symbols": ["retire_pending_agent_jobs_for_run_with_reason_in_tx"],
        "why": (
            "notifier run_stall_sweep.rs retires the ended run's pending delivery job "
            "(outbox UPDATE, already granted for the push drain)."
        ),
    },
    {
        "path": "server-rust/crates/momo-agent/src/run_event.rs",
        "mode": "symbols",
        "symbols": ["workspaces_with_expired_run_events"],
        "why": (
            "notifier run_event_retention_sweep.rs (#3744, ADR-0200 D2): the cross-tenant "
            "candidate READ on the notifier pool. delete_expired_run_events_in_tx is the "
            "momo_app write pool's DELETE and must stay out of scope."
        ),
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
        # #3982 (#4822): the expiry sweep settles the card in place through the
        # shared settlement instead of posting a new message.
        "path": "server-rust/crates/momo-messaging/src/approval_card.rs",
        "mode": "all",
        "why": (
            "approval_sweep.rs:208 settle_approval_card_in_tx "
            "(UPDATE message props/body, SELECT agent_run)"
        ),
    },
    {
        "path": "server-rust/crates/momo-messaging/src/interaction.rs",
        "mode": "symbols",
        "symbols": ["reread_interaction_in_tx", "emit_message_edited_in_tx"],
        "why": "control_window_sweep.rs:70 emit_message_edited_in_tx after stamp",
    },
    {
        "path": "server-rust/crates/momo-t3/src/work_share.rs",
        "mode": "symbols",
        "symbols": ["workspaces_with_expired_shares"],
        "column_reads": {"work_session_share": ["workspace_id", "session_id"]},
        "why": (
            "share_retention_sweep.rs: the cross-tenant candidate READ on the "
            "notifier pool (#3377; v0.1.16 incident). Only this symbol: "
            "delete_expired_shares_for_workspace_in_tx is the momo_app write "
            "pool's DELETE and must stay out of scope."
        ),
    },
    {
        "path": "server-rust/crates/momo-messaging/src/avatar_reclaim.rs",
        "mode": "symbols",
        "symbols": ["candidate_sql", "avatar_reclaim_candidates"],
        "literal_tables": ["member"],
        "column_reads": {
            "member_avatar_media": [
                "id", "workspace_id", "drive_file_id", "status", "created_at",
                "drive_reclaimed_at",
            ],
            "workspace_avatar_media": [
                "id", "workspace_id", "drive_file_id", "status", "created_at",
                "drive_reclaimed_at",
            ],
            "workspace": ["avatar_media_id"],
        },
        "why": (
            "notifier avatar_reclaim.rs: avatar_reclaim_candidates on the "
            "notifier pool. candidate_sql builds `FROM {table} a … FROM {owner} o` "
            "from AvatarKind (Member → member_avatar_media / member, Workspace → "
            "workspace_avatar_media / workspace), which a literal scan cannot see, "
            "so the relations are named here: `member` (table grant) and, as column "
            "reads, the two media tables (never name/mime/member_id) and "
            "`workspace.avatar_media_id` (o.avatar_media_id), hence column grants. "
            "reclaim_avatar_media_in_tx is the momo_app write half and is not scanned."
        ),
    },
    {
        "path": "server-rust/crates/momo-messaging/src/attachment_reclaim.rs",
        "mode": "symbols",
        "symbols": ["workspaces_sql", "workspaces_with_reclaim_candidates"],
        "column_reads": {
            "attachment": [
                "workspace_id", "status", "message_id", "reserved", "unreserved_at",
                "created_at",
            ],
        },
        "why": (
            "notifier attachment_reclaim.rs: workspaces_with_reclaim_candidates on the notifier "
            "pool (#4443, ADR-0151 증보 2) is the ONE cross-tenant statement of the attachment "
            "reclaim and answers workspace ids only. workspaces_sql names exactly the columns "
            "above — never the attachment id, drive_file_id, name, mime, size_bytes or the "
            "uploader — and `eligible_core_sql`, the shared predicate fragment it embeds, holds "
            "no relation. The other half of the definition (`NO_OTHER_HOLD_SQL`: huddle "
            "transcript columns, avatar media Drive ids) is evaluated only by the momo_app "
            "tenant transactions and is not scanned. The reservation fact is the `reserved` / "
            "`unreserved_at` pair migration 150 mirrors from scheduled_message_attachment, "
            "which stays sealed from this role (NEVER_GRANTED_TO_NOTIFIER below). "
            "reclaim_candidate_ids_in_tx, reclaim_tally_in_tx, sweep_workspace and "
            "reclaim_unbound_attachment_in_tx run on the momo_app pool and are not scanned."
        ),
    },
    {
        "path": "server-rust/crates/momo-messaging/src/inbox.rs",
        "mode": "symbols",
        "symbols": ["workspaces_with_expired_inbox_items"],
        "why": (
            "notifier inbox_retention_sweep.rs: the cross-tenant candidate READ on the "
            "notifier pool (#3681, ADR-0199 D4). delete_read_inbox_items_in_tx is the "
            "momo_app write pool's DELETE and must stay out of scope; the SELECT itself "
            "is already granted (table-level, for the inbox trigger the notifier's "
            "message INSERT fires)."
        ),
    },
    {
        "path": "server-rust/crates/momo-messaging/src/huddle_sweep.rs",
        "mode": "symbols",
        "symbols": ["active_huddles_for_sweep"],
        "why": (
            "notifier huddle_sweep.rs: active_huddles_for_sweep, the cross-tenant "
            "READ on the notifier pool (#2758). Settlements are the momo_app pool."
        ),
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
            "AFTER INSERT ON credit_entry trigger. Also derived below from "
            "INSERT/UPDATE tables → CREATE TRIGGER. Kept explicit as the #2448 "
            "citation for workspace_credit INSERT."
        ),
    },
]

# INVOKER triggers on tables the notifier INSERTs/UPDATEs are derived from
# server/Migrations (not a hand list). SECURITY DEFINER functions are skipped
# and printed. Helpers called from those trigger bodies (PERFORM/SELECT fn())
# are included when they are INVOKER migration functions — otherwise 033's
# event_subscription SELECT is invisible, same hole as F-1.
LADDER_FILES = [
    "server-rust/crates/momo-t3/src/reconcile.rs",
    "server-rust/crates/momo-t3/src/sweep.rs",
    "server-rust/bins/momo-notifier/src/lib.rs",
]
LADDER_SITES = (
    "reconcile.rs:195 T3LockLadder::host (claim_lifecycle_intent), "
    "reconcile.rs:302-305 host / .with_workspace_credit (apply_convergence_to_intent), "
    "sweep.rs:224 host.with_workspace_credit (converge_stale_session)"
)

NOT_SCANNED = [
    "momo-t3/reattach.rs, terminal_attach.rs, work_control.rs (except remote_host_owner_in_tx, scanned since #3928), provision.rs, cloud_host.rs — R2: not on the notifier call graph",
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
    r'[\s\S]{0,3000}?\bON\s+CONFLICT\b[\s\S]{0,400}?\bDO\s+UPDATE\b'
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
    for table in entry.get("literal_tables", []):
        pieces.append(f"SELECT 1 FROM {table}")
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


COLUMN_GRANT_RE = re.compile(
    r'GRANT\s+SELECT\s*\(([^)]*)\)\s+ON\s+([a-z][a-z0-9_]*)\s+TO\s+momo_notifier',
    re.I | re.S,
)


def parse_column_grants(text):
    """`GRANT SELECT (a, b) ON <table> TO momo_notifier` → {table: {a, b}}.

    Deliberately a different shape from the table grants (no `ON TABLE`), so the
    doctor / table-grant parsers never read a column grant as a table grant."""
    grants = {}
    for m in COLUMN_GRANT_RE.finditer(text):
        cols = {c.strip().lower() for c in m.group(1).split(",") if c.strip()}
        grants.setdefault(m.group(2).lower(), set()).update(cols)
    return grants


# Tables the notifier may UPDATE only through a column-scoped GRANT. A table-level
# `GRANT … UPDATE ON TABLE <t>` on one of these is a problem even though every scanned
# statement would be covered by it — the point of the column list is the writes the
# notifier must NOT be able to make (#3930: it must not rewrite where a push goes).
COLUMN_SCOPED_UPDATE_ONLY = {
    "push_token": "#3930: the notifier retires a dead token; it must not rewrite apns_token, member_id or device_id",
}

COLUMN_UPDATE_GRANT_RE = re.compile(
    r'GRANT\s+UPDATE\s*\(([^)]*)\)\s+ON\s+([a-z][a-z0-9_]*)\s+TO\s+momo_notifier',
    re.I | re.S,
)


def parse_column_update_grants(text):
    """`GRANT UPDATE (a, b) ON <table> TO momo_notifier` → {table: {a, b}}.

    The same shape discipline as the SELECT column grants (no `ON TABLE`): the
    doctor / table-grant parsers never read a column grant as a table grant, and
    a statement that writes any other column of the table is a problem below
    (#3930: `push_token.invalidated_at, updated_at` is the first column-scoped
    write; a notifier must not be able to rewrite `apns_token` or `member_id`)."""
    grants = {}
    for m in COLUMN_UPDATE_GRANT_RE.finditer(text):
        cols = {c.strip().lower() for c in m.group(1).split(",") if c.strip()}
        grants.setdefault(m.group(2).lower(), set()).update(cols)
    return grants


UPDATE_SET_RE = re.compile(
    r'(?i)\bUPDATE\s+(?:ONLY\s+)?(?:public\.)?([a-z][a-z0-9_]*)\s+'
    r'(?:(?:AS\s+)?[a-z][a-z0-9_]*\s+)?SET\s+'
)
SET_END_RE = re.compile(r'(?i)(?:WHERE|FROM|RETURNING)\b')
IDENT_RE = re.compile(r'^[a-z_][a-z0-9_]*$', re.I)


def set_list_columns(sql, start):
    """The target columns of a `SET a = …, b = …` list that begins at `start`.

    Reads Rust-literal SQL: depth-aware (so `COALESCE(a, b)` and `now()` do not
    split), skips single-quoted strings, treats the `\\` of a line continuation as
    a space, and ends at a depth-0 WHERE / FROM / RETURNING, the closing quote of
    the literal, or `;`. Returns (columns, parsed_ok)."""
    parts, current = [], []
    depth, i, n = 0, start, len(sql)
    while i < n:
        ch = sql[i]
        if ch == "'":
            j = sql.find("'", i + 1)
            j = n - 1 if j < 0 else j
            current.append(sql[i:j + 1])
            i = j + 1
            continue
        if ch == '(':
            depth += 1
        elif ch == ')':
            if depth == 0:
                break
            depth -= 1
        elif depth == 0 and ch in '";':
            break
        elif depth == 0 and ch == ',':
            parts.append("".join(current))
            current = []
            i += 1
            continue
        elif depth == 0 and (i == 0 or not (sql[i - 1].isalnum() or sql[i - 1] == '_')):
            if SET_END_RE.match(sql, i):
                break
        if ch == '\\':
            ch = ' '
        current.append(ch)
        i += 1
    parts.append("".join(current))
    columns, ok = set(), True
    for part in parts:
        if not part.strip():
            ok = False
            continue
        left = part.split('=', 1)[0].strip()
        if not IDENT_RE.match(left):
            ok = False
            continue
        columns.add(left.lower())
    return columns, ok


def parse_update_columns(sql):
    """`UPDATE <table> SET …` statements in `sql` → ({table: columns}, unparsed)."""
    writes, unparsed = {}, []
    # A Rust string continuation (`\` + newline + indent) is whitespace to SQL.
    sql = re.sub(r'\\\r?\n\s*', ' ', sql)
    for m in UPDATE_SET_RE.finditer(sql):
        table = m.group(1).lower()
        if table in SKIP_IDENT:
            continue
        columns, ok = set_list_columns(sql, m.end())
        writes.setdefault(table, set()).update(columns)
        if not ok:
            unparsed.append(table)
    return writes, unparsed


def collect_column_reads():
    reads = {}
    for entry in SCAN_SCOPE:
        for table, cols in entry.get("column_reads", {}).items():
            reads.setdefault(table, set()).update(cols)
    return reads


def collect_column_writes(extra_by_path=None):
    """Columns every scanned `UPDATE … SET` writes, per table (+ unparseable ones)."""
    extra_by_path = extra_by_path or {}
    writes, unparsed = {}, []
    for entry in SCAN_SCOPE:
        extra = extra_by_path.get(entry["path"], "")
        found, bad = parse_update_columns(corpus_for(entry, extra))
        for table, cols in found.items():
            writes.setdefault(table, set()).update(cols)
        unparsed.extend(bad)
    return writes, sorted(set(unparsed))


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


def load_migration_catalog():
    functions = {}
    triggers = []
    for path in sorted((root / "server/Migrations").glob("*.sql")):
        text = path.read_text(encoding="utf-8")
        for m in re.finditer(
            r'CREATE(?:\s+OR\s+REPLACE)?\s+FUNCTION\s+([a-z_][a-z0-9_]*)',
            text,
            re.I,
        ):
            name = m.group(1).lower()
            rest = text[m.end():]
            as_m = re.search(r'\bAS\s+\$\$', rest, re.I)
            if not as_m:
                continue
            header = rest[: as_m.start()]
            body_start = as_m.end()
            body_end = rest.find("$$", body_start)
            if body_end < 0:
                continue
            functions[name] = {
                "body": rest[body_start:body_end],
                "definer": bool(re.search(r"SECURITY\s+DEFINER", header, re.I)),
                "file": str(path.relative_to(root)),
            }
        for m in re.finditer(
            r'CREATE\s+TRIGGER\s+(\w+)\s+'
            r'(BEFORE|AFTER|INSTEAD\s+OF)\s+'
            r'(.+?)\s+ON\s+(?:ONLY\s+)?(?:public\.)?([a-z][a-z0-9_]*)\s'
            r'[\s\S]*?EXECUTE\s+(?:FUNCTION|PROCEDURE)\s+([a-z_][a-z0-9_]*)',
            text,
            re.I,
        ):
            event_s = m.group(3).upper()
            events = set()
            if "INSERT" in event_s:
                events.add("INSERT")
            if "UPDATE" in event_s:
                events.add("UPDATE")
            if "DELETE" in event_s:
                events.add("DELETE")
            triggers.append(
                {
                    "name": m.group(1),
                    "events": events,
                    "table": m.group(4).lower(),
                    "fn": m.group(5).lower(),
                    "file": str(path.relative_to(root)),
                }
            )
    return functions, triggers


MIGRATION_FNS, MIGRATION_TRIGGERS = load_migration_catalog()
CALL_RE = re.compile(r"\b([a-z_][a-z0-9_]*)\s*\(", re.I)


def invoker_closure(fn_name, seen, definers):
    name = fn_name.lower()
    if name in seen:
        return ""
    info = MIGRATION_FNS.get(name)
    if info is None:
        return ""
    seen.add(name)
    if info["definer"]:
        definers.append((name, info["file"]))
        return ""
    chunks = [info["body"]]
    for called in CALL_RE.findall(info["body"]):
        chunks.append(invoker_closure(called, seen, definers))
    return "\n".join(chunks)


def derive_trigger_corpus(used):
    """INVOKER trigger bodies (+ helpers) for INSERT/UPDATE tables in `used`."""
    write_verbs = {"INSERT", "UPDATE"}
    included = []
    definers = []
    seen_fn = set()
    bodies = []
    for trig in MIGRATION_TRIGGERS:
        table_verbs = used.get(trig["table"], set())
        if not (table_verbs & write_verbs & trig["events"]):
            continue
        info = MIGRATION_FNS.get(trig["fn"])
        if info is None:
            continue
        if info["definer"]:
            definers.append((trig["fn"], info["file"]))
            included.append({**trig, "skipped": "SECURITY DEFINER"})
            continue
        bodies.append(invoker_closure(trig["fn"], seen_fn, definers))
        included.append({**trig, "skipped": None})
    return "\n".join(bodies), included, definers


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
    # Fixpoint: new INSERT/UPDATE tables from trigger bodies can grow the set.
    for _ in range(8):
        extra_sql, _, _ = derive_trigger_corpus(used)
        verbs, dels = parse_verbs(extra_sql)
        deletes.extend(dels)
        grew = False
        for table, vs in verbs.items():
            before = used.get(table, set())
            merged = before | vs
            if merged != before:
                used[table] = merged
                grew = True
        if not grew:
            break
    return used, deletes


def compare(used, grants, real, col_grants=None, col_reads=None,
            col_update_grants=None, col_writes=None, unparsed_updates=None):
    problems = []
    col_grants = col_grants if col_grants is not None else COLUMN_GRANTS
    col_reads = col_reads if col_reads is not None else COLUMN_READS
    col_update_grants = (
        col_update_grants if col_update_grants is not None else COLUMN_UPDATE_GRANTS
    )
    col_writes = col_writes if col_writes is not None else COLUMN_WRITES
    unparsed_updates = (
        unparsed_updates if unparsed_updates is not None else UNPARSED_UPDATES
    )
    # #3930: a table written through a column-scoped GRANT UPDATE (…). The columns
    # the scanned statements SET must equal the granted ones — a column more is a
    # write the production role does not have, a column less is an over-grant.
    for table, why in sorted(COLUMN_SCOPED_UPDATE_ONLY.items()):
        if "UPDATE" in grants.get(table, set()):
            problems.append(f"table-level UPDATE {table} (must stay column-scoped; {why})")
    for table, cols in sorted(col_update_grants.items()):
        if "UPDATE" in grants.get(table, set()) and table not in COLUMN_SCOPED_UPDATE_ONLY:
            problems.append(
                f"table-level UPDATE {table} next to a column-scoped GRANT UPDATE (…)"
            )
        if table in unparsed_updates:
            problems.append(
                f"UPDATE {table}: a SET list in the scan scope cannot be parsed, so the "
                "column grant cannot be proven to cover it"
            )
        written = col_writes.get(table, set())
        for col in sorted(written - cols):
            problems.append(
                f"column write {table}.{col} not in GRANT UPDATE (…) ON {table}"
            )
        for col in sorted(cols - written):
            problems.append(
                f"over-grant column write {table}.{col} (no scanned statement writes it)"
            )
    for table, cols in sorted(col_reads.items()):
        have = col_grants.get(table, set())
        if "SELECT" in grants.get(table, set()):
            problems.append(
                f"table-level SELECT {table} where only columns {sorted(cols)} are read"
            )
        for col in sorted(cols - have):
            problems.append(
                f"column read {table}.{col} not in GRANT SELECT (…) ON {table}"
            )
    for table, cols in sorted(col_grants.items()):
        for col in sorted(cols - col_reads.get(table, set())):
            problems.append(
                f"over-grant column {table}.{col} (no scanned statement reads it)"
            )
    for table, verbs in sorted(used.items()):
        if table not in real:
            continue
        have = grants.get(table, set())
        if "DELETE" in verbs:
            problems.append(f"statement DELETE {table} is always forbidden")
        for verb in sorted(verbs):
            if verb == "DELETE":
                continue
            if verb == "SELECT" and table in col_reads:
                continue  # column-scoped read: judged by the column rules above
            if verb == "UPDATE" and table in col_update_grants:
                continue  # column-scoped write: judged by the column rules above
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
COLUMN_GRANTS = parse_column_grants(bootstrap.read_text(encoding="utf-8"))
COLUMN_UPDATE_GRANTS = parse_column_update_grants(bootstrap.read_text(encoding="utf-8"))
COLUMN_READS = collect_column_reads()
COLUMN_WRITES, UNPARSED_UPDATES = collect_column_writes()
used, deletes = collect_used()
used_real = {t: v for t, v in used.items() if t in real}

_, derived_trigs, derived_definers = derive_trigger_corpus(used)
print("[test-notifier-role-grants] derived INVOKER triggers:")
if not derived_trigs:
    print("  (none)")
for trig in derived_trigs:
    ev = ",".join(sorted(trig["events"]))
    skip = f" SKIP {trig['skipped']}" if trig.get("skipped") else ""
    print(
        f"  - {trig['name']} ON {trig['table']} [{ev}] → {trig['fn']} "
        f"({trig['file']}){skip}"
    )
print("[test-notifier-role-grants] SECURITY DEFINER excluded:")
if derived_definers:
    for name, path in sorted(set(derived_definers)):
        print(f"  - {name} ({path})")
else:
    print("  (none on notifier INSERT/UPDATE tables)")

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

# (d) #3377: the grant the v0.1.16 share retention sweep lacked. Drop it → RED.
col_d = {t: set(c) for t, c in COLUMN_GRANTS.items()}
col_d.pop("work_session_share", None)
probs_d = compare(used_real, grants, real, col_grants=col_d)
if not any("column read work_session_share.session_id" in p for p in probs_d):
    fail(f"sabotage drop work_session_share GRANT stayed GREEN (problems={probs_d})")
print(
    "[test-notifier-role-grants] ok: sabotage drop work_session_share GRANT → RED "
    f"({[p for p in probs_d if 'work_session_share' in p][0]})"
)

# (d2) #3377: widening a column grant to the whole table is an over-grant → RED.
grants_d2 = {t: set(vs) for t, vs in grants.items()}
grants_d2["work_session_share"] = {"SELECT"}
probs_d2 = compare(used_real, grants_d2, real)
if not any("table-level SELECT work_session_share" in p for p in probs_d2):
    fail(f"sabotage table-level work_session_share stayed GREEN (problems={probs_d2})")
print(
    "[test-notifier-role-grants] ok: sabotage table-level SELECT work_session_share → RED "
    f"({[p for p in probs_d2 if 'work_session_share' in p][0]})"
)

# (e) #3377: drop the one-column workspace grant the avatar reclaim read needs → RED.
probs_e = compare(used_real, grants, real, col_grants={})
if not any("column read workspace.avatar_media_id" in p for p in probs_e):
    fail(f"sabotage drop workspace column GRANT stayed GREEN (problems={probs_e})")
print(
    "[test-notifier-role-grants] ok: sabotage drop workspace.avatar_media_id column GRANT → RED "
    f"({[p for p in probs_e if 'avatar_media_id' in p][0]})"
)

# (g) #3553: drop the hosted_agent_connection column grant the v0.1.18 push
# judgment (and migration 120's agent_run trigger) needs → RED.
col_g = {t: set(c) for t, c in COLUMN_GRANTS.items()}
col_g.pop("hosted_agent_connection", None)
probs_g = compare(used_real, grants, real, col_grants=col_g)
if not any("column read hosted_agent_connection.agent_member_id" in p for p in probs_g):
    fail(f"sabotage drop hosted_agent_connection GRANT stayed GREEN (problems={probs_g})")
print(
    "[test-notifier-role-grants] ok: sabotage drop hosted_agent_connection column GRANT → RED "
    f"({[p for p in probs_g if 'hosted_agent_connection' in p][0]})"
)

# (h) #3930: the grant that lets the notifier invalidate a dead push token. The dev
# bootstrap gives the notifier every verb, so only this scan and the production-role
# suite can see it go missing. Drop the column UPDATE grant → RED.
probs_h = compare(used_real, grants, real, col_update_grants={})
if not any("statement UPDATE push_token not in GRANT" in p for p in probs_h):
    fail(f"sabotage drop push_token column UPDATE GRANT stayed GREEN (problems={probs_h})")
print(
    "[test-notifier-role-grants] ok: sabotage drop GRANT UPDATE (invalidated_at, updated_at) "
    f"ON push_token → RED ({[p for p in probs_h if 'push_token' in p][0]})"
)

# (h2) #3930: a statement that writes another column of push_token → RED. The grant is
# two columns on purpose: a notifier must not be able to rewrite `apns_token`.
writes_h2, bad_h2 = collect_column_writes(
    extra_by_path={
        "server-rust/crates/momo-push/src/dispatch_log.rs": (
            'UPDATE push_token SET invalidated_at = now(), apns_token = $3 WHERE id = $1'
        )
    }
)
probs_h2 = compare(used_real, grants, real, col_writes=writes_h2, unparsed_updates=bad_h2)
if not any("column write push_token.apns_token not in GRANT UPDATE" in p for p in probs_h2):
    fail(f"sabotage SET apns_token in the scanned source stayed GREEN (problems={probs_h2})")
print(
    "[test-notifier-role-grants] ok: sabotage UPDATE push_token SET apns_token in scanned source "
    f"→ RED ({[p for p in probs_h2 if 'apns_token' in p][0]})"
)

# (h3) #3930: widening the column grant to the whole table → RED.
grants_h3 = {t: set(vs) for t, vs in grants.items()}
grants_h3["push_token"] = {"SELECT", "UPDATE"}
probs_h3 = compare(used_real, grants_h3, real)
if not any("table-level UPDATE push_token" in p for p in probs_h3):
    fail(f"sabotage table-level UPDATE push_token stayed GREEN (problems={probs_h3})")
print(
    "[test-notifier-role-grants] ok: sabotage table-level GRANT UPDATE ON push_token "
    f"→ RED ({[p for p in probs_h3 if 'push_token' in p][0]})"
)

# (h4) #3930: a third column in the grant that no statement writes → RED.
col_h4 = {t: set(c) for t, c in COLUMN_UPDATE_GRANTS.items()}
col_h4["push_token"].add("apns_token")
probs_h4 = compare(used_real, grants, real, col_update_grants=col_h4)
if not any("over-grant column write push_token.apns_token" in p for p in probs_h4):
    fail(f"sabotage over-granted push_token column stayed GREEN (problems={probs_h4})")
print(
    "[test-notifier-role-grants] ok: sabotage GRANT UPDATE (…, apns_token) ON push_token "
    f"→ RED ({[p for p in probs_h4 if 'apns_token' in p][0]})"
)

# (h5) #3930: a SET list the reader cannot parse never silently passes → RED.
writes_h5, bad_h5 = collect_column_writes(
    extra_by_path={
        "server-rust/crates/momo-push/src/dispatch_log.rs": (
            'UPDATE push_token SET (invalidated_at, updated_at) = (now(), now()) WHERE id = $1'
        )
    }
)
probs_h5 = compare(used_real, grants, real, col_writes=writes_h5, unparsed_updates=bad_h5)
if not any("push_token: a SET list in the scan scope cannot be parsed" in p for p in probs_h5):
    fail(f"sabotage unparseable SET list stayed GREEN (problems={probs_h5})")
print(
    "[test-notifier-role-grants] ok: sabotage tuple-form SET list on push_token "
    f"→ RED ({[p for p in probs_h5 if 'cannot be parsed' in p][0]})"
)

# (i) ADR-0200 증보 3 E7 (#4284): a BYPASSRLS role never reads a credential or a sealed
# webhook secret. The table-grant parsers only see `ON TABLE` lines, so this one reads
# EVERY `GRANT … ON [TABLE] <name> TO momo_notifier`, column-scoped ones included.
NEVER_GRANTED_TO_NOTIFIER = {
    "token": "credentials (the woken verdict drops the claim predicate's token join for this reason)",
    "hosted_agent_doorbell": "url and secret_sealed (the verdict needs no fire time)",
    "scheduled_message_attachment": (
        "ADR-0208 D3: owner-scoped, sealed from the BYPASSRLS roles; the attachment reclaim "
        "reads attachment.reserved, which a trigger mirrors from it (#4443)"
    ),
    "scheduled_message": "ADR-0208 D3: owner-scoped drafts, sealed from the BYPASSRLS roles",
}
ANY_NOTIFIER_GRANT_RE = re.compile(
    r'GRANT\s+[^;]*?\bON\s+(?:TABLE\s+)?([a-z][a-z0-9_]*)\s+TO\s+momo_notifier\b',
    re.I,
)


def forbidden_notifier_grants(text):
    named = {m.group(1).lower() for m in ANY_NOTIFIER_GRANT_RE.finditer(text)}
    return sorted(named & set(NEVER_GRANTED_TO_NOTIFIER))


bootstrap_text = bootstrap.read_text(encoding="utf-8")
bad_i = forbidden_notifier_grants(bootstrap_text)
if bad_i:
    fail(f"momo_notifier is granted {bad_i} ({[NEVER_GRANTED_TO_NOTIFIER[t] for t in bad_i]})")
# the parser must SEE a column-scoped grant (the old ON TABLE parsers did not)
for fixture in (
    "GRANT SELECT (id, token_hash) ON token TO momo_notifier;",
    "GRANT SELECT ON TABLE token TO momo_notifier;",
    "GRANT SELECT (url) ON hosted_agent_doorbell TO momo_notifier;",
):
    if not forbidden_notifier_grants(bootstrap_text + "\n" + fixture):
        fail(f"sabotage `{fixture}` stayed GREEN (the grant reader does not see this shape)")
print(
    "[test-notifier-role-grants] ok: no GRANT (table or column) on token / "
    "hosted_agent_doorbell to momo_notifier; sabotage table- and column-scoped grants → RED"
)

# (j) ADR-0200 증보 3 E7: the new tables are column-scoped only. A table-level SELECT on
# any of them is an over-grant (compare() → "table-level SELECT …"); dropping a column
# the verdict reads is a missing grant.
for table in ("hosted_agent_liveness", "hosted_agent_doorbell_ring", "agent_provider_pin"):
    if table not in COLUMN_READS or table not in COLUMN_GRANTS:
        fail(f"{table} must be a column-scoped read (scan scope + bootstrap)")
    grants_j = {t: set(vs) for t, vs in grants.items()}
    grants_j[table] = {"SELECT"}
    probs_j = compare(used_real, grants_j, real)
    if not any(f"table-level SELECT {table}" in p for p in probs_j):
        fail(f"sabotage table-level SELECT {table} stayed GREEN (problems={probs_j})")
    col_j = {t: set(c) for t, c in COLUMN_GRANTS.items()}
    col_j.pop(table, None)
    probs_j2 = compare(used_real, grants, real, col_grants=col_j)
    if not any(f"column read {table}." in p for p in probs_j2):
        fail(f"sabotage drop {table} column GRANT stayed GREEN (problems={probs_j2})")
    # an extra granted column no statement reads
    col_j3 = {t: set(c) for t, c in COLUMN_GRANTS.items()}
    col_j3[table].add("zz_extra")
    probs_j3 = compare(used_real, grants, real, col_grants=col_j3)
    if not any(f"over-grant column {table}.zz_extra" in p for p in probs_j3):
        fail(f"sabotage over-granted {table} column stayed GREEN (problems={probs_j3})")
# the columns the verdict reads for a connection beyond (workspace_id, agent_member_id)
for col in ("id", "status", "approved_scopes", "approved_channel_ids",
            "approved_dm_channel_ids", "confirmed_by"):
    if col not in COLUMN_GRANTS.get("hosted_agent_connection", set()):
        fail(f"hosted_agent_connection.{col} missing from the notifier column grant")
print(
    "[test-notifier-role-grants] ok: woken-verdict tables are column-scoped; table-level "
    "SELECT / dropped column / extra column → RED"
)

# (k) ADR-0151 증보 2 (#4443): the attachment reclaim's one cross-tenant read (workspace ids
# only) is column-scoped on `attachment`. A table-level SELECT would hand a BYPASSRLS role the
# attachment id, the Drive file id, the file name and the uploader (→ RED); a dropped column is a
# missing grant production only notices at the first tick, because the dev bootstrap holds
# table-level grants (→ RED); a column no statement reads is an over-grant (→ RED).
if "attachment" not in COLUMN_READS or "attachment" not in COLUMN_GRANTS:
    fail("attachment must be a column-scoped read (scan scope + bootstrap)")
for col in ("id", "drive_file_id", "name", "mime", "uploader_member_id", "channel_id", "size_bytes"):
    if col in COLUMN_GRANTS["attachment"]:
        fail(f"attachment.{col} must not be granted to momo_notifier (the workspace id and the candidate predicate's own columns only)")
for col in ("workspace_id", "status", "message_id", "reserved", "unreserved_at", "created_at"):
    if col not in COLUMN_GRANTS["attachment"]:
        fail(f"attachment.{col} missing from the notifier column grant")
grants_k = {t: set(vs) for t, vs in grants.items()}
grants_k["attachment"] = {"SELECT"}
probs_k = compare(used_real, grants_k, real)
if not any("table-level SELECT attachment" in p for p in probs_k):
    fail(f"sabotage table-level SELECT attachment stayed GREEN (problems={probs_k})")
col_k = {t: set(c) for t, c in COLUMN_GRANTS.items()}
col_k.pop("attachment", None)
probs_k2 = compare(used_real, grants, real, col_grants=col_k)
if not any("column read attachment." in p for p in probs_k2):
    fail(f"sabotage drop attachment column GRANT stayed GREEN (problems={probs_k2})")
col_k3 = {t: set(c) for t, c in COLUMN_GRANTS.items()}
col_k3["attachment"].add("drive_file_id")
probs_k3 = compare(used_real, grants, real, col_grants=col_k3)
if not any("over-grant column attachment.drive_file_id" in p for p in probs_k3):
    fail(f"sabotage over-granted attachment.drive_file_id stayed GREEN (problems={probs_k3})")
print(
    "[test-notifier-role-grants] ok: attachment is a column-scoped read; table-level SELECT / "
    "dropped column / drive_file_id added → RED"
)

# (f) #3377: a share-retention DELETE in the scanned notifier source → RED.
used_f, dels_f = collect_used(
    extra_by_path={
        "server-rust/bins/momo-notifier/src/*.rs": "DELETE FROM work_session_share"
    }
)
if "work_session_share" not in dels_f:
    fail("sabotage DELETE FROM work_session_share in notifier source stayed GREEN")
print(
    "[test-notifier-role-grants] ok: sabotage DELETE FROM work_session_share "
    "in scanned source → RED (statement DELETE is always forbidden)"
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

# N-2: strip_lock_work_pool hides work_pool SQL; a new .with_work_pool() on a
# notifier ladder must RED. Construction sites: {LADDER_SITES}.
def ladder_with_work_pool(extra_by_file=None):
    extra_by_file = extra_by_file or {}
    hits = []
    for rel in LADDER_FILES:
        path = root / rel
        text = strip_cfg_test(path.read_text(encoding="utf-8"))
        text += extra_by_file.get(rel, "")
        for i, line in enumerate(text.splitlines(), 1):
            if ".with_work_pool(" in line:
                hits.append(f"{rel}:{i}:{line.strip()}")
    return hits


print(f"[test-notifier-role-grants] T3LockLadder sites (notifier graph): {LADDER_SITES}")
hits = ladder_with_work_pool()
if hits:
    fail("notifier graph calls .with_work_pool(): " + "; ".join(hits))
print("[test-notifier-role-grants] ok: no .with_work_pool() on notifier ladders")
hits_sab = ladder_with_work_pool(
    extra_by_file={
        "server-rust/crates/momo-t3/src/sweep.rs": "T3LockLadder::host(id).with_work_pool()"
    }
)
if not hits_sab:
    fail("sabotage .with_work_pool() on sweep ladder stayed GREEN")
print(
    "[test-notifier-role-grants] ok: sabotage .with_work_pool() on sweep ladder "
    f"→ RED ({hits_sab[0]})"
)

print("[test-notifier-role-grants] used verbs:")
for table in sorted(used_real):
    print(f"  {table}: {', '.join(sorted(used_real[table]))}")
print("[test-notifier-role-grants] column-scoped UPDATE (granted == written):")
for table in sorted(COLUMN_UPDATE_GRANTS):
    print(f"  {table}: {', '.join(sorted(COLUMN_UPDATE_GRANTS[table]))}")
PY

echo "[test-notifier-role-grants] PASS"

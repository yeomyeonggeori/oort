# Approval Pause/Resume Runtime v0

> Updated: 2026-06-26
> Status: MOMO-161 canonical runtime design + minimal worker slice.
> Verification: static fixtures + Swift tests. Full approve/deny runtime endpoint is still `runtime-unverified`.

## 1. Contract

Approval is a protocol checkpoint, not a client-only card.

Risky external writes and high-risk tool calls must follow:

```text
tool_call
  -> approval_request
  -> approval_decision
  -> approved: resume same agent_run/task -> tool_result -> audit_log
  -> rejected/expired/cancelled: terminate same agent_run/task -> tool_result/audit_log
```

The run identity does not change across the checkpoint. `agent_run.id` is the task id, and `approval.run_id` points at that same row. A resume is represented by a new `outbox(kind='agent_job')` payload that references the same `run_id`, not by creating a second run.

## 2. State Machine

| Stage | DB SoT | Timeline / realtime | Notes |
|---|---|---|---|
| Agent proposes tool | `agent_run.status='running'` | `tool_call` event/message | Runtime has not executed the side effect yet. |
| Runtime pauses | `approval.status='pending'`, `agent_run.status='awaiting_approval'` | `message.type='approval_request'`, `agent.status=awaiting_approval` | Single tx with `channel_seq` bump + outbox broadcast. |
| Human approves | `approval.status='approved'`, audit `approval.approved` | `approval.decided` event | Server enqueues resume job with same `run_id`. |
| Worker resumes | same `agent_run.id`, status returns to `running` | `agent.status=running` | Worker executes the approved tool using the frozen approved payload. |
| Tool succeeds/fails | `agent_run.status='succeeded'` or `failed` | `message.type='tool_result'` | Tool result is append-only and audited. |
| Human rejects | `approval.status='rejected'`, `agent_run.status='cancelled'` | `tool_result(is_error=true)` or system message | No tool execution. |
| Approval expires | `approval.status='expired'`, `agent_run.status='timed_out'` | `tool_result(is_error=true)` or system message | Deadline worker can apply this transition. |

`paused` remains reserved for operator/system pause without a pending human decision. Approval uses `awaiting_approval`.

## 3. Worker Pause Transaction

When `AgentWorker` sees a `tool_call` and `LoopGuards.requiresApproval(toolName:)` returns true, it must commit the pause before returning from the current job:

1. `SET LOCAL app.workspace_id`.
2. `INSERT approval(workspace_id, run_id, channel_id, requested_by, action_type='tool_call', payload, status='pending') RETURNING id`.
3. `UPDATE channel_seq ... RETURNING seq`.
4. `INSERT message(type='approval_request', props={approval_id, run_id, call_id, tool_name, arguments}, run_id)`.
5. `UPDATE approval SET request_message_id=<message.id>`.
6. `UPDATE agent_run SET status='awaiting_approval'`.
7. `INSERT outbox(kind='broadcast')` for the approval request message.
8. `INSERT audit_log(action='approval.requested', target_type='approval', target_id=<approval.id>, run_id=<run.id>)`.
9. Mark the claimed `agent_job` done, leaving the run open at `awaiting_approval`.

This PR implements the minimal worker-side pause slice above. The external tool is not executed after the pause path, so a risky call can no longer fall through to `succeeded` without a decision.

## 4. Server Decision Contract

Follow-up server route:

```text
POST /v1/workspaces/{ws}/approvals/{approval_id}/decision
```

Request shape:

```json
{
  "decision": "approved",
  "reason": "Looks correct",
  "idempotency_key": "uuid"
}
```

Required server behavior:

- Membership/role/policy check under normal app role + RLS. BYPASSRLS is forbidden on this user-facing write path.
- Lock the `approval` row with `FOR UPDATE`.
- Reject stale decisions unless current `approval.status='pending'`.
- Recheck workspace/channel visibility and tool policy version from the stored payload/capability evidence.
- Approved:
  - update `approval.status='approved'`, `decided_by`, `decided_at`, `decision_reason`;
  - append `audit_log(action='approval.approved')`;
  - insert `outbox(kind='agent_job')` with same `run_id`, `resume_from_approval_id`, and frozen approved tool payload;
  - publish `approval.decided`.
- Rejected:
  - update `approval.status='rejected'`;
  - set `agent_run.status='cancelled'`;
  - append `audit_log(action='approval.rejected')`;
  - write a `tool_result` error/system result without executing the tool;
  - publish `approval.decided`.

The endpoint is intentionally a server concern, not a worker concern, because the actor is a human and must pass normal membership/RLS/policy checks.

## 5. DB / Swift / Server / Worker Change Scope

| Layer | Needed change | MOMO-161 status |
|---|---|---|
| DB | Existing `approval`, `agent_run`, `message`, `outbox`, `audit_log` can express v0. Future migration may add `approval_decision_id`, idempotency key, decision payload hash, and `approval_policy_version`. | No `schema_v0.sql` change. Future migration only. |
| MomoCore | `Approval`, `AgentRun`, `RunStatus.awaitingApproval`, `MessageType.approvalRequest` already exist. Add decision DTOs when server route lands. | Existing types sufficient for this slice. |
| Server | Add approval decision endpoint, idempotency, membership/policy recheck, resume-job enqueue, denial/expiry termination. | Identified; not fully implemented in this PR. |
| Worker | On risky `tool_call`, create approval checkpoint and stop current job; on resume job, execute frozen approved tool and emit `tool_result`. | Pause slice implemented; resume execution is `runtime-unverified`. |
| Relay | No semantic change. It publishes committed approval request/decision/result outbox records. | No change. |
| macOS/iOS | Approval card renders DB-backed `approval_request` and calls server decision endpoint. | UI cards exist as demo placeholders; endpoint binding is follow-up. |

## 6. Resume Payload

Future resume jobs should preserve the same run/task:

```json
{
  "run_id": "00000000-0000-7000-8000-000000000161",
  "workspace_id": "00000000-0000-7000-8000-000000000001",
  "channel_id": "00000000-0000-7000-8000-000000000010",
  "agent_member_id": "00000000-0000-7000-8000-000000000101",
  "resume_from_approval_id": "00000000-0000-7000-8000-000000000901",
  "approved_tool_call": {
    "call_id": "call_create_issue_001",
    "name": "github.create_issue",
    "arguments": {"repo": "Dawn-kim-official/momo", "title": "demo"}
  }
}
```

The worker must not let the model mutate the approved payload between decision and execution. If the agent wants a different action after rejection, it must emit a new `tool_call` and receive a new approval.

## 7. Fixture Index

Fixtures live in `research/11-agent-runtime/fixtures/approval-pause-resume-v0/`.

| Fixture | Coverage |
|---|---|
| `tool_call_pause_resume_flow.json` | End-to-end event sequence from risky tool call through approval resume, denial, and audit expectations. |

## 8. Open Follow-Ups

- Implement `POST /v1/workspaces/{ws}/approvals/{approval_id}/decision`.
- Add resume-job handling in AgentWorker for `resume_from_approval_id`.
- Add runtime verification script with mock hermes emitting an approval-required tool call, then server approve/deny calls.
- Add deadline/expiry sweeper for `approval.expires_at`.
- Add MomoCore/server DTOs for `approval_decision` once the route is implemented.

# Local 3-Day Alpha Test Pack

> Purpose: run momo for three days on a local MacBook + Docker Desktop and
> leave enough evidence to decide `AWS_READY`, `BLOCKED`, or
> `NEEDS_MORE_LOCAL`.
>
> Scope: local dogfood only. This pack does not provision AWS, does not replace
> M7 release QA, and does not prove public DNS/TLS/SOPS/registry/PITR.

## 0. Decision Contract

Use this document when MOMO-241~245 have landed and MOMO-246 starts the actual
72-hour local alpha run.

| Decision | Meaning | Required next step |
|---|---|---|
| `AWS_READY` | Local dogfood evidence is complete, no open P0/P1 remains, and the external agent runtime smoke has a credentialed PASS. | Follow `docs/AWS_INTERNAL_ALPHA.md` for the one-week AWS team alpha host. |
| `BLOCKED` | A named external dependency prevents a valid run or AWS handoff, for example provider credentials, Docker Desktop, billing, DNS, or a broken local gate. | File or update the blocker issue, keep MOMO-246 open, and do not provision AWS. |
| `NEEDS_MORE_LOCAL` | Local run completed enough to learn, but product/UX/reliability evidence is not strong enough for AWS. | Convert findings into P0/P1/P2 goals, merge fixes, and repeat the missing day or smoke slice locally. |

Do not use "it felt fine" as a decision. Every decision must name the commit,
local gate evidence, diagnostics bundle, open issue list, and agent runtime
status.

## 1. Required Inputs

Before Day 0 starts:

- A clean main or dedicated alpha worktree, not the root dirty checkout.
- Docker Desktop running with enough resources for local compose.
- `scripts/local_gate.sh --profile docs` PASS on the chosen commit.
- `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift` PASS on the chosen commit.
- `scripts/local_gate.sh --profile local-alpha` PASS on the chosen commit.
- Foreground app evidence when UI behavior is part of the run:
  `LOCAL_GATE_LAUNCH_UI=1 DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile macos-ui`.
- External agent runtime plan:
  - mock/local runtime is enough for local messenger dogfood,
  - credentialed external runtime PASS is required before `AWS_READY`.
- An evidence directory outside the repo, for example:

```bash
export MOMO_ALPHA_EVIDENCE_DIR="/tmp/momo-local-alpha-$(date +%Y%m%d)"
mkdir -p "$MOMO_ALPHA_EVIDENCE_DIR"
```

## 2. Runtime Modes

| Mode | What it proves | What it does not prove |
|---|---|---|
| Mock agent runtime | momo can route `@agent` channel work through AgentWorker and durable timeline output without external credentials. | Real provider latency, provider auth, provider billing, or production provider reliability. |
| External agent runtime | momo can call a real provider-facing OpenAI-compatible runtime boundary and receive one durable channel response. | Long-term provider reliability, production host hardening, or provider-owned OAuth lifecycle correctness beyond the smoke. |

momo is the agent host. The agent member is a `member.kind='agent'` participant
inside momo. Hermes, OpenAI-compatible gateways, Codex OAuth-backed providers,
or future custom runtimes are provider/runtime layers. momo must not store
provider OAuth tokens or raw provider API keys in DB, diagnostics, local gate
evidence, or app logs.

## 3. Day 0 Checklist

Day 0 is readiness. Do not start the 72-hour clock until every required row is
PASS or explicitly recorded as a blocker.

| Check | Command or evidence | PASS threshold |
|---|---|---|
| Worktree | `git status --short --branch` | Clean alpha worktree, correct commit recorded. |
| Docs gate | `scripts/local_gate.sh --profile docs` | PASS evidence markdown path recorded. |
| Swift gate | `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift` | PASS evidence markdown path recorded. |
| Local alpha RC | `scripts/local_gate.sh --profile local-alpha` | PASS evidence for boot, migrate, health, message, relay, mock agent, backup restore, macOS smoke, diagnostics. |
| App launch | `LOCAL_GATE_LAUNCH_UI=1 ... scripts/local_gate.sh --profile macos-ui` | Foreground process/window/log evidence recorded when UI dogfood is in scope. |
| External runtime | `scripts/local_gate.sh --profile external-agent-provider` with real env, or explicit skip | Credentialed PASS is required for `AWS_READY`; no-credential skip is acceptable only for `NEEDS_MORE_LOCAL`. |
| Evidence root | local path outside repo | Directory exists and contains Day 0 notes. |
| Issue board | `scripts/goal_status.sh --repo Dawn-kim-official/momo` | No known open P0/P1 blocks the local run. |

Day 0 output:

```md
## Day 0 Readiness
- Commit:
- Worktree:
- Docs gate:
- Swift gate:
- Local-alpha gate:
- macOS UI launch:
- External agent runtime:
- Open P0/P1:
- Decision to start 72h: yes/no
- Notes:
```

## 4. Day 1 Checklist

Day 1 proves the product can be used as a one-person local messenger.

| Scenario | PASS threshold | Evidence |
|---|---|---|
| Login/session | Seeded owner can log in; recoverable error appears for bad credentials. | Screenshot or app log. |
| Channel load | `#general` and `#agent-lab` load with history. | Screenshot or API JSON. |
| Message send/read | At least 20 human messages across two channels, ordered by `message.seq`. | Transcript, app screenshot, or REST evidence. |
| Invite/join | New invite is created, raw code copied once, joined user can log in, no privilege escalation. | Redacted invite response + joined login proof. |
| Restart | App restart and one server or relay restart do not lose messages. | Notes + logs. |
| Feedback | At least one feedback report, even if it says "no blocker found". | GitHub issue/comment URL or local markdown. |

Day 1 output:

```md
## Day 1 Messenger Dogfood
- Active time:
- Messages sent:
- Channels used:
- Invites created/joined:
- Restarts:
- Bugs/feedback:
- P0/P1/P2/P3 summary:
- Notes:
```

## 5. Day 2 Checklist

Day 2 proves agent-member behavior and recovery paths.

| Scenario | PASS threshold | Evidence |
|---|---|---|
| Agent presence | Agent member is visible in the channel where it is expected. | App screenshot or `/members?kind=agent` JSON. |
| Mock runtime | At least 10 `@agent` mentions complete through mock runtime. | `runtime-agent`, `local-alpha`, or transcript evidence. |
| External runtime | At least 1 credentialed external runtime roundtrip, if credentials are available. | `external-agent-provider` evidence. |
| Degraded state | Missing/invalid provider config reports a redacted degraded reason, not a secret. | Status JSON or app state. |
| Reconnect | Realtime reconnect or REST fallback is visible after Centrifugo or app restart. | App screenshot/log. |
| Diagnostics | A diagnostics bundle is collected after an intentional restart/failure drill. | Bundle path + summary review note. |

Day 2 output:

```md
## Day 2 Agent Runtime
- Agent member tested:
- Mock mentions:
- External runtime result:
- Degraded-state check:
- Reconnect/fallback:
- Diagnostics bundle:
- Bugs/feedback:
- Notes:
```

## 6. Day 3 Checklist

Day 3 proves local soak and final handoff quality.

| Scenario | PASS threshold | Evidence |
|---|---|---|
| Soak | Stack remains usable across the final day with no P0/P1. | Resource monitor or manual snapshots. |
| Resource growth | Docker/app/server/worker resource usage does not show runaway growth. | MOMO-245 monitor summary or manual `docker stats` snapshots. |
| Backup/recovery | Backup restore rehearsal evidence exists for the tested commit. | `backup` or `local-alpha` evidence path. |
| Diagnostics | Final diagnostics bundle exists and is redacted. | Bundle path + summary review note. |
| Triage | Every feedback item is P0/P1/P2/P3 classified. | GitHub issue list or local triage table. |
| Final decision | `AWS_READY`, `BLOCKED`, or `NEEDS_MORE_LOCAL` selected. | Final report. |

Day 3 output:

```md
## Day 3 Soak and Decision
- Total active time:
- Local stack uptime:
- Resource summary:
- Backup/restore evidence:
- Final diagnostics:
- Open P0:
- Open P1:
- Open P2/P3:
- Final decision: AWS_READY / BLOCKED / NEEDS_MORE_LOCAL
- Rationale:
- Follow-up issues:
```

## 7. Bug Severity

Use `docs/INTERNAL_ALPHA_FEEDBACK.md` as the canonical triage guide. For this
3-day run:

| Severity | Blocks `AWS_READY`? | Examples |
|---|---|---|
| P0 | Yes | Data loss, cross-tenant leak, secret exposure, app/server cannot launch for every tester. |
| P1 | Yes | Login, send/read, invite/join, agent runtime, realtime, diagnostics, or local gate cannot complete. |
| P2 | Not automatically | Confusing but workable flow, missing copy, stale state with workaround, brittle but recoverable UI. |
| P3 | No | Visual polish, wording, small layout issue, non-blocking affordance. |

Every P0/P1 must become a buildable issue before the final decision. P2/P3 may
remain open only when each has a follow-up issue, owner, and workaround or
explicit non-blocking note.

## 8. Start, Stop, Restart, Recovery

Preferred start:

```bash
scripts/local_alpha_runner.sh plan
scripts/local_alpha_runner.sh execute --hermes mock
```

When testing a credentialed external runtime, keep provider secrets outside the
repo and use the external runtime smoke from `docs/LOCAL_PR_GATE.md`.

The runner prints a stop command in its `summary.md`. Use that first. If running
manual processes, stop in this order:

1. macOS dev app or `scripts/macos_dev_run.sh --terminate-only`
2. AgentWorker
3. mock/external runtime process
4. OutboxRelay
5. MomoServer
6. `make down`

Recovery drill:

1. Collect diagnostics before restarting when possible.
2. Restart the failed component only.
3. Send one new message in `#general`.
4. Send one `@agent` message in `#agent-lab`.
5. Confirm timeline order and degraded/available status.
6. Record the drill in the daily report.

## 9. Evidence Layout

Recommended directory:

```text
/tmp/momo-local-alpha-YYYYMMDD/
  day0-readiness.md
  day1-messenger.md
  day2-agent-runtime.md
  day3-decision.md
  local-gates/
  diagnostics/
  screenshots/
  resource-snapshots/
  final-report.md
```

Do not commit this directory. Paste only redacted summaries or paths into the
tracking issue.

## 10. MOMO-246 Final Report Template

```md
## 72h Local Alpha Final Report

### Summary
- Commit:
- Worktree:
- Start:
- End:
- Final decision: AWS_READY / BLOCKED / NEEDS_MORE_LOCAL

### Required Evidence
- Day 0 readiness:
- Day 1 report:
- Day 2 report:
- Day 3 report:
- Docs gate:
- Swift gate:
- Local-alpha gate:
- macOS UI launch:
- External agent runtime:
- Diagnostics bundle:
- Resource/soak summary:

### Feedback Triage
| Severity | Count | Open | Links |
|---|---:|---:|---|
| P0 | | | |
| P1 | | | |
| P2 | | | |
| P3 | | | |

### Decision Rationale
- Why this is or is not ready for AWS:
- Largest remaining risk:
- Follow-up issues:

### Operator Notes
- Commands that worked:
- Commands that failed:
- Recovery drills:
- Secret redaction confirmed: yes/no
```

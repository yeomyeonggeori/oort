# Local PR Gate

> Purpose: keep PR quality high while GitHub Actions are not the primary merge gate.
> Scope: local developer/Codex validation before PR, after review, and after merge to `main`.

## 0. Current Status

As of 2026-06-26, GitHub Actions are disabled manually for `Dawn-kim-official/momo`
because the organization is seeing billing/payment failures and should not spend
paid macOS runner minutes during active development.

- Remote workflow state must stay `disabled_manually` unless the owner explicitly approves re-enabling it.
- Repo workflow files are manual-only (`workflow_dispatch`) so a future re-enable cannot start jobs from every push, PR, or tag.
- The merge gate during this period is local evidence + review pass + no unrelated dirty files.
- Workers use local evidence to open a PR and hand it off; workers do not merge. `momo-main` owns review, final local gate, merge, issue close, and post-merge `main` verification.
- Do not wait for GitHub Actions green during this period; record `Actions disabled by policy` in PR evidence when relevant.

## 1. Rule

Every PR needs local evidence in the PR body:

- date and machine/toolchain summary,
- commands executed,
- pass/fail result,
- runtime scope that was actually exercised,
- anything intentionally not covered.

Do not mark runtime work complete if the runtime script was not run.

## 2. Standard Script

Run from repo root:

```bash
scripts/local_gate.sh --profile docs
```

The script writes a log and Markdown evidence file under
`${TMPDIR:-/tmp}/momo-local-gate` by default, then prints a PR-ready
`## Local Gate` block to stdout. Filenames include the profile, UTC second,
process id, nanosecond timestamp, worktree hash, and random suffix, for example
`local-gate-docs-20260629T120000Z-pid1234-ns1780000000000000000-wtab12cd34ef56-r98ab76cd54ef.md`.
This keeps evidence paths collision-safe when the same profile runs in parallel
from multiple worktrees. Use `--output-dir <dir>` or `LOCAL_GATE_OUT_DIR=<dir>`
when you need a stable parent directory for local evidence files.

Profiles:

| Profile | Use when | What it runs |
|---|---|---|
| `docs` | docs/spec/script-only changes | whitespace diff, workflow YAML parse, actionlint if installed, JSON syntax, shell syntax, Python syntax, Hermes adapter smoke |
| `swift` | Swift package/model/view changes | `docs` profile + `make build` + `make test` |
| `diagnostics` | diagnostics/observability bundle changes | `docs` profile + `scripts/collect_diagnostics.sh --smoke` redaction check |
| `staging-smoke` | staging/prod/internal-hosting config or runbook changes that do not have real VPS secrets | `docs` profile + `scripts/verify_staging_smoke.sh` + `scripts/verify_internal_hosting_smoke.sh` for prod compose config, internal single-node smoke overlay, Caddyfile structure, Centrifugo Redis config, API health route wiring, relay/worker enablement, secret-template guard, and SOPS/pgBackRest checklist |
| `backup` | backup/PITR runbook or internal hosting changes that must prove restore rehearsal evidence before review | `docs` profile + `scripts/verify_backup_restore_rehearsal.sh` for temporary PostgreSQL 18 source DB marker writes, `pg_dump -Fc`, separate restore DB `pg_restore`, marker checksum equality, and markdown/json evidence generation |
| `host-runtime` | internal single-node host-runtime smoke before internal test hosting | `docs` profile + `scripts/verify_internal_host_runtime.sh` + `scripts/verify_backup_restore_rehearsal.sh`; proves local image prod+internal-smoke boot/health/agent-runtime-status redaction/migrate/message/relay/mock-agent and repo-local restore evidence |
| `runtime-db` | migrations/server/RLS/join changes | `swift` profile + `make up` + `make migrate` twice + `scripts/verify_rls.sh` + `scripts/verify_join.sh` |
| `runtime-relay` | outbox/relay/realtime changes | `swift` profile + Docker/migration bootstrap + `scripts/verify_relay.sh` for server send, outbox pending, relay claim, Centrifugo history, outbox done, and `version=message.seq` evidence |
| `runtime-live` | realtime-token/WebSocket live subscribe changes | `swift` profile + Docker/migration bootstrap + host MomoServer/OutboxRelay + compose-network `api:8080` proxy + `scripts/verify_realtime_live.sh` for token issuance, subscribe, REST send, live `message.new`, `payload.message.seq`, and invalid token rejection evidence |
| `runtime-agent` | AgentWorker/hermes/cost/projection/agent live-channel changes | `swift` profile + Docker/migration bootstrap + `scripts/verify_agent_worker.sh` + `scripts/verify_agent_live_channel.sh` |
| `macos-ui` | MomoMac UI/run changes | `swift` profile + `MomoMacSmoke`; set `LOCAL_GATE_LAUNCH_UI=1` to run `scripts/macos_dev_run.sh --verify --logs --terminate` |
| `m3-dbc` | M3 D/B/C exit evidence or MOMO-020/021/022 close-readiness review | `swift` profile + Docker/migration bootstrap + `verify_agent_worker.sh` D/B evidence + `verify_approval_decision.sh` C evidence + `verify_macos_real_backend_ui.sh` |
| `all` | merge-critical/runtime-wide changes | broad static/Swift/runtime DB/relay/agent/macOS gate in one run, with shared bootstrap deduped except migration idempotency; run `runtime-live` separately for WebSocket live evidence because it starts host API/relay processes and a compose-network proxy |

Examples:

```bash
scripts/local_gate.sh --profile swift
scripts/local_gate.sh --profile diagnostics
scripts/local_gate.sh --profile staging-smoke
scripts/local_gate.sh --profile backup
scripts/local_gate.sh --profile host-runtime
scripts/local_gate.sh --profile runtime-live
scripts/local_gate.sh --profile runtime-agent
LOCAL_GATE_LAUNCH_UI=1 scripts/local_gate.sh --profile macos-ui
scripts/local_gate.sh --profile m3-dbc
scripts/local_gate.sh --profile docs --output-dir /tmp/momo-local-gate
```

The default script is strict: PR evidence should come from a clean worktree and
checks committed whitespace against `${LOCAL_GATE_BASE_REF:-origin/main}` plus
staged/unstaged diffs. For exploratory pre-commit runs only, use
`LOCAL_GATE_ALLOW_DIRTY=1`; do not paste that as final merge evidence.

Backup/PITR PRs must use `backup` or a profile that includes it. The local
profile proves only the repo-local dump/restore contract and writes separate
restore evidence markdown/json; production pgBackRest stanza/check/full backup,
WAL archive push, SOPS decrypt, object-store repo, and time-target PITR remain
`runtime-unverified(public host)` until a real restore host/volume rehearsal is
attached.

For internal alpha incident handoff, collect a redacted diagnostics bundle:

```bash
scripts/collect_diagnostics.sh --output-dir /tmp/momo-diagnostics --since 15m
```

The collector writes a directory, `summary.md`, and a `.tar.gz` archive. It is
best-effort by design: stopped Docker services, missing macOS logs, or absent
local gate evidence are recorded in the bundle instead of failing collection.
Secrets, passwords, API keys, bearer/JWT-shaped tokens, and database URL
credentials are redacted before files are written.

`runtime-relay` is now automated by `scripts/verify_relay.sh`. Relay/history
PRs must use this profile unless the machine cannot run Docker/psql. WebSocket
live subscribe PRs must use `runtime-live`, which starts host MomoServer and
OutboxRelay plus a small `api:8080` proxy container because Centrifugo's
subscribe proxy must reach the API service on the Docker network. If Docker/psql
is unavailable, record the blocker and keep the affected runtime scope
unverified.

After parallel runtime gates or after removing old worktrees, audit leftover
worktree Docker Compose resources with:

```bash
scripts/compose_janitor.sh
```

This command is dry-run by default. It lists only stale `momo_` worktree Compose
projects, containers, and networks; it protects `momo_default`, the root `momo`
project, `supabase`, active worktree projects, and non-momo resources. Removal
requires an explicit cleanup flag:

```bash
scripts/compose_janitor.sh --cleanup
```

For macOS UI PRs, the default `macos-ui` profile stays GUI-safe for headless or
background Codex runs: it executes `MomoMacSmoke` only. Opt-in GUI evidence uses
`LOCAL_GATE_LAUNCH_UI=1`, which stages `dist/MomoMacDevApp.app`, launches it with
`open -n`, verifies the process and System Events window count, captures unified
logs under `${TMPDIR:-/tmp}/momo-macos-dev-run`, then terminates the app.

For M3 D/B/C exit PRs, use:

```bash
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile m3-dbc
```

This composed profile records one PR-ready evidence block for:
D Live Tool-Call (`agent.partial` mock OpenAI-compatible SSE tool_call progress
and final `tool_result`/`message.new` with `version=message.seq`), B Cost
Projection (`usage_ledger`/`budget_window` reserve/reconcile plus
`/cost-snapshots` and MomoMac `CostSnapshot` binding), and C Approval Inbox
(`/approvals` pending projection plus approve/reject/idempotency/audit/resume
effects). Add `LOCAL_GATE_LAUNCH_UI=1` when a foreground macOS dev app
process/window smoke is wanted; by default the profile keeps GUI launch opt-in
and still verifies the real-backend REST/UI data path.

## 3. Manual Fallback

Run from repo root:

```bash
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer make build
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer make test
python3 -m py_compile adapters/hermes/momo_adapter.py
python3 adapters/hermes/tests/smoke_momo_adapter.py
jq empty .github/labels.json infra/centrifugo.json
```

If shell scripts changed:

```bash
for f in scripts/*.sh scripts/github/*.sh; do
  [ -e "$f" ] || continue
  bash -n "$f"
done
```

If GitHub workflows changed and `actionlint` is installed:

```bash
actionlint .github/workflows/*.yml
```

If `actionlint` is missing and workflows changed, install it or record the exact blocker before merge. `scripts/local_gate.sh` fails workflow-changing PRs when `actionlint` is unavailable.

## 4. Runtime Profiles

Use the profile that matches the changed surface.

| Profile | Use when | Commands |
|---|---|---|
| `docs` | docs/spec only | `scripts/local_gate.sh --profile docs` |
| `swift` | Swift package/model/view changes | `scripts/local_gate.sh --profile swift` |
| `diagnostics` | diagnostics/observability bundle changes | `scripts/local_gate.sh --profile diagnostics` |
| `staging-smoke` | MOMO-005/006/007 deploy config, Caddy/Centrifugo, secret/backup runbooks | `scripts/local_gate.sh --profile staging-smoke` |
| `backup` | backup/PITR restore rehearsal evidence | `scripts/local_gate.sh --profile backup` |
| `host-runtime` | internal single-node runtime smoke, Kim Intern provider status/redaction, plus restore rehearsal evidence | `scripts/local_gate.sh --profile host-runtime` |
| `runtime-db` | migrations/server/RLS/join changes | `scripts/local_gate.sh --profile runtime-db` |
| `runtime-relay` | outbox/relay/realtime changes | `scripts/local_gate.sh --profile runtime-relay` |
| `runtime-live` | realtime-token/WebSocket live subscribe changes | `scripts/local_gate.sh --profile runtime-live` |
| `runtime-agent` | AgentWorker/hermes/cost/projection/agent live-channel changes | `scripts/local_gate.sh --profile runtime-agent` |
| `macos-ui` | MomoMac UI/run changes | `scripts/local_gate.sh --profile macos-ui`; add `LOCAL_GATE_LAUNCH_UI=1` for dev `.app` launch, process/window smoke, logs, and termination |
| `m3-dbc` | M3 D/B/C exit evidence or MOMO-020/021/022 close-readiness review | `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile m3-dbc`; add `LOCAL_GATE_LAUNCH_UI=1` for GUI process/window evidence |

## 5. PR Body Evidence

Paste the block printed by `scripts/local_gate.sh`. Shape:

```md
## Local Gate
- Result:
- Profile:
- Started:
- Finished:
- Run ID:
- Evidence markdown:
- Evidence log:
- Commands:
- Runtime coverage:
- Not covered:
```

## 6. Worker Handoff And Merge Cycle

1. Claim issue and work in a separate worktree.
   - `momo-main` checks `scripts/goal_status.sh`.
   - worker runs `scripts/goal_claim.sh <issue>` when available.
2. Implement from the issue plan.
3. Worker runs the relevant `scripts/local_gate.sh --profile ...` in a clean worktree.
4. Commit, push, and open PR.
5. Worker moves the issue to review with `scripts/goal_release.sh <issue> --review --pr <PR URL>`, hands off to `momo-main`, and stops.
6. Worker must not merge, close the issue, run the post-merge `main` gate, or adjust roadmap/backlog state.
7. `momo-main` reviews for security, correctness, and scope.
8. `momo-main` runs the final local gate after review fixes.
9. `momo-main` merges only if the local gate passes and no blocker remains.
10. `momo-main` updates `main` locally and reruns the relevant local gate on `main`.
11. `momo-main` updates issue status, `STATUS.md`, roadmap/backlog if decisions changed, and recommends the next goal.
12. If Actions are intentionally disabled, `momo-main` confirms workflow state remains `disabled_manually` instead of waiting for remote CI.

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

The script writes a timestamped log and Markdown evidence file under
`${TMPDIR:-/tmp}/momo-local-gate` by default, then prints a PR-ready
`## Local Gate` block to stdout. Use `--output-dir <dir>` or
`LOCAL_GATE_OUT_DIR=<dir>` when you need a stable local evidence path.

Profiles:

| Profile | Use when | What it runs |
|---|---|---|
| `docs` | docs/spec/script-only changes | whitespace diff, workflow YAML parse, actionlint if installed, JSON syntax, shell syntax, Python syntax |
| `swift` | Swift package/model/view changes | `docs` profile + `make build` + `make test` |
| `staging-smoke` | staging/prod config/runbook changes that do not have real VPS secrets | `docs` profile + `scripts/verify_staging_smoke.sh` for prod compose config, Caddyfile structure, Centrifugo Redis config, secret-template guard, and SOPS/pgBackRest checklist |
| `runtime-db` | migrations/server/RLS changes | `swift` profile + `make up` + `make migrate` twice + `scripts/verify_rls.sh` |
| `runtime-relay` | outbox/relay/realtime changes | `swift` profile + Docker/migration bootstrap + `scripts/verify_relay.sh` for server send, outbox pending, relay claim, Centrifugo history, outbox done, and `version=message.seq` evidence |
| `runtime-agent` | AgentWorker/hermes/cost changes | `swift` profile + Docker/migration bootstrap + `scripts/verify_agent_worker.sh` |
| `macos-ui` | MomoMac UI/run changes | `swift` profile + `MomoMacSmoke`; set `LOCAL_GATE_LAUNCH_UI=1` to launch `MomoMacDevApp` |
| `all` | merge-critical/runtime-wide changes | all profiles in one run, with shared bootstrap deduped except migration idempotency; fails if any runtime profile is not automated yet |

Examples:

```bash
scripts/local_gate.sh --profile swift
scripts/local_gate.sh --profile staging-smoke
scripts/local_gate.sh --profile runtime-agent
LOCAL_GATE_LAUNCH_UI=1 scripts/local_gate.sh --profile macos-ui
scripts/local_gate.sh --profile docs --output-dir /tmp/momo-local-gate
```

The default script is strict: PR evidence should come from a clean worktree and
checks committed whitespace against `${LOCAL_GATE_BASE_REF:-origin/main}` plus
staged/unstaged diffs. For exploratory pre-commit runs only, use
`LOCAL_GATE_ALLOW_DIRTY=1`; do not paste that as final merge evidence.

`runtime-relay` is now automated by `scripts/verify_relay.sh`. Relay/realtime
PRs must use this profile unless the machine cannot run Docker/psql; in that
case record the blocker and keep the affected runtime scope unverified.

## 3. Manual Fallback

Run from repo root:

```bash
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer make build
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer make test
python3 -m py_compile adapters/hermes/momo_adapter.py
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
| `staging-smoke` | MOMO-005/006/007 deploy config, Caddy/Centrifugo, secret/backup runbooks | `scripts/local_gate.sh --profile staging-smoke` |
| `runtime-db` | migrations/server/RLS changes | `scripts/local_gate.sh --profile runtime-db` |
| `runtime-relay` | outbox/relay/realtime changes | `scripts/local_gate.sh --profile runtime-relay` |
| `runtime-agent` | AgentWorker/hermes/cost changes | `scripts/local_gate.sh --profile runtime-agent` |
| `macos-ui` | MomoMac UI/run changes | `scripts/local_gate.sh --profile macos-ui`; add `LOCAL_GATE_LAUNCH_UI=1` for real window launch |

## 5. PR Body Evidence

Paste the block printed by `scripts/local_gate.sh`. Shape:

```md
## Local Gate
- Result:
- Profile:
- Started:
- Finished:
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

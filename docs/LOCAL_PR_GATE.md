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
| `runtime-db` | migrations/server/RLS changes | `swift` profile + `make up` + `make migrate` twice + `scripts/verify_rls.sh` |
| `runtime-relay` | outbox/relay/realtime changes | `swift` profile + Docker/migration bootstrap + `scripts/verify_relay.sh`; until that script exists this profile fails honestly and points to the MOMO-002 manual path |
| `runtime-agent` | AgentWorker/hermes/cost changes | `swift` profile + Docker/migration bootstrap + `scripts/verify_agent_worker.sh` |
| `macos-ui` | MomoMac UI/run changes | `swift` profile + `MomoMacSmoke`; set `LOCAL_GATE_LAUNCH_UI=1` to launch `MomoMacDevApp` |
| `all` | merge-critical/runtime-wide changes | all profiles in one run, with shared bootstrap deduped except migration idempotency; fails if any runtime profile is not automated yet |

Examples:

```bash
scripts/local_gate.sh --profile swift
scripts/local_gate.sh --profile runtime-agent
LOCAL_GATE_LAUNCH_UI=1 scripts/local_gate.sh --profile macos-ui
scripts/local_gate.sh --profile docs --output-dir /tmp/momo-local-gate
```

The default script is strict: PR evidence should come from a clean worktree and
checks committed whitespace against `${LOCAL_GATE_BASE_REF:-origin/main}` plus
staged/unstaged diffs. For exploratory pre-commit runs only, use
`LOCAL_GATE_ALLOW_DIRTY=1`; do not paste that as final merge evidence.

`runtime-relay` is deliberately not green until `scripts/verify_relay.sh` exists.
Relay/realtime PRs must use the MOMO-002 manual verification path and describe it
in the PR body until that automation lands.

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
| `runtime-db` | migrations/server/RLS changes | `scripts/local_gate.sh --profile runtime-db` |
| `runtime-relay` | outbox/relay/realtime changes | `scripts/local_gate.sh --profile runtime-relay` once `scripts/verify_relay.sh` exists; otherwise use MOMO-002 manual evidence |
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

## 6. Merge Cycle

1. Claim issue and work in a separate worktree.
2. Implement from the issue plan.
3. Run the relevant `scripts/local_gate.sh --profile ...`.
4. Commit, push, and open PR.
5. Review for security, correctness, and scope.
6. Run the final local gate after review fixes.
7. Merge if the local gate passes and no blocker remains.
8. Update `main` locally and rerun the relevant local gate on `main`.
9. Update issue status, `STATUS.md`, roadmap/backlog if decisions changed, and recommend the next goal.
10. If Actions are intentionally disabled, confirm workflow state remains `disabled_manually` instead of waiting for remote CI.

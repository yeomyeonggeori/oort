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

## 2. Default Gate

Run from repo root:

```bash
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer make build
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer make test
python3 -m py_compile adapters/hermes/momo_adapter.py
jq empty .github/labels.json infra/centrifugo.json
```

If shell scripts changed:

```bash
bash -n scripts/*.sh
```

If GitHub workflows changed and `actionlint` is installed:

```bash
actionlint .github/workflows/*.yml
```

If `actionlint` is missing and workflows changed, install it or record the exact blocker before merge.

## 3. Runtime Profiles

Use the profile that matches the changed surface.

| Profile | Use when | Commands |
|---|---|---|
| `docs` | docs/spec only | default gate or at least `git diff --check` plus static parse checks |
| `swift` | Swift package/model/view changes | default gate |
| `runtime-db` | migrations/server/RLS changes | default gate + `make up` + `make migrate` twice |
| `runtime-relay` | outbox/relay/realtime changes | default gate + MOMO-002 verification path |
| `runtime-agent` | AgentWorker/hermes/cost changes | default gate + `scripts/verify_agent_worker.sh` |
| `macos-ui` | MomoMac UI/run changes | default gate + `swift run --package-path clients/macOS MomoMacDevApp` or the future `script/build_and_run.sh --verify` |

## 4. PR Body Evidence

Use this block:

```md
## Local Gate
- Date:
- Machine/toolchain:
- Commands:
  - [x] `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer make build`
  - [x] `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer make test`
  - [x] scope-specific:
- Runtime coverage:
- Not covered:
```

## 5. Merge Cycle

1. Claim issue and work in a separate worktree.
2. Implement from the issue plan.
3. Run the local gate.
4. Commit, push, and open PR.
5. Review for security, correctness, and scope.
6. Run the final local gate after review fixes.
7. Merge if the local gate passes and no blocker remains.
8. Update `main` locally and rerun the relevant local gate on `main`.
9. Update issue status, `STATUS.md`, roadmap/backlog if decisions changed, and recommend the next goal.
10. If Actions are intentionally disabled, confirm workflow state remains `disabled_manually` instead of waiting for remote CI.

## 6. Future Script

`MOMO-111` should add:

```bash
scripts/local_gate.sh --profile docs|swift|runtime-db|runtime-relay|runtime-agent|macos-ui|all
```

The script should write a timestamped evidence file under a non-secret local path and print a PR-ready summary.

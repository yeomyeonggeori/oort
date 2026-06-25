# Multi-session Worktree Operations

> Purpose: run five or more Codex sessions without issue, branch, worktree, runtime, or review collisions.
> Canonical rule: one GitHub Issue = one goal = one branch = one worktree = one PR.

## 0. Operating Model

`momo-main` is the orchestration thread. It should stay light and avoid heavy implementation except for urgent fixes.

Worker threads are implementation threads. Each worker claims exactly one GitHub Issue and works only in the worktree created for that issue.

Recommended five-session split:

| Session | Default lane | Responsibility |
|---|---|---|
| `momo-main` | orchestration | Issue picker, branch collision checks, review/merge, roadmap/status updates, next-goal recommendation |
| worker 1 | runtime/backend | Small server, DB, relay, worker, runtime verification tickets |
| worker 2 | macOS UX | MomoMac SwiftUI, app launch, desktop interaction tickets |
| worker 3 | docs/spec/protocol | Context, memory, agent protocol, research-to-roadmap tickets |
| worker 4 | infra/devtooling | Local gate, worktree tooling, scripts, GitHub ops, deployment runbooks |

More workers are allowed, but do not open two large edits in the same file family without an explicit merge order.

## 1. Status Board

`momo-main` starts every orchestration cycle with:

```bash
scripts/goal_status.sh --repo Dawn-kim-official/momo
```

The board shows:

- `ready`, `in-progress`, `needs-review`, and `blocked` issues,
- issue number, assignee, title, and status labels,
- matched branch, open PR, and local worktree path,
- the local gate profile or evidence state expected next.

Column meanings:

| Column | Meaning |
|---|---|
| `status` | Issue status label group. |
| `issue` | GitHub Issue number. This is the goal id. |
| `assignee` | Current worker owner. Empty means claimable only if `status:ready`. |
| `gate` | Local gate profile expected for this surface. |
| `evidence` | Next evidence step: claim, run a gate, attach PR Local Gate, or explain blocker. |
| `branch` | Canonical branch matched by `<type>/<issue>-<slug>`. |
| `pr` | Open PR for the branch, if one exists. |
| `worktree` | Local worktree path for the branch, if present on this machine. |

If a branch/PR/worktree column is `-`, check for a non-canonical branch before starting work. The remote branch is the practical lock.

## 2. Claiming Work

Preferred:

```bash
scripts/goal_claim.sh <issue-number>
```

This script:

1. verifies the issue is open and `status:ready`,
2. rejects already-assigned or in-review issues unless `--force` is used deliberately,
3. creates a canonical branch and worktree under `../momo-worktrees/<issue>-<slug>`,
4. pushes the remote branch as the lock,
5. assigns the issue to the current GitHub user and moves it to `status:in-progress`,
6. runs `.conductor/setup.sh` when available.

If the script is unavailable in an older checkout, use the manual fallback:

```bash
git fetch origin main
git worktree add -b <type>/<issue-number>-<slug> ../momo-worktrees/<issue-number>-<slug> origin/main
git -C ../momo-worktrees/<issue-number>-<slug> push -u origin <type>/<issue-number>-<slug>
gh issue edit <issue-number> --repo Dawn-kim-official/momo --add-assignee @me --add-label status:in-progress --remove-label status:ready
```

Do not claim an issue that already has an assignee, an active branch, an open PR, or `status:in-progress`/`status:needs-review`, unless `momo-main` explicitly resolves the conflict.

## 3. Worktree Environment Separation

`.conductor/setup.sh` creates per-worktree runtime overrides:

- `.conductor/local.env`: ignored local file with generated ports and compose name.
- `.env.worktree`: ignored symlink to `.conductor/local.env`.
- `COMPOSE_PROJECT_NAME`: branch/worktree-specific namespace.
- `PORT`, `CENT_PORT`, `POSTGRES_PORT`, `HERMES_PORT`: deterministic branch-specific ports.
- `DATABASE_URL`, `CENT_API_URL`, `HERMES_BASE_URL`: local runtime URLs derived from those ports.

Root `.env` is treated as a secret source and must never be copied into commits. If a worktree needs shared secrets, use ignored symlinks or local-only overrides.

Runtime tickets should pass `ENV_FILE=.env.worktree` when needed and must not reuse another worktree's compose project, volume, or port set.

## 4. Collision Rules

Safe concurrent lanes:

- one runtime/backend worker and one docs/spec worker,
- one macOS UI worker and one infra/devtooling worker,
- multiple docs workers if they do not edit the same roadmap/status sections.

Coordinate before opening parallel work in:

- `server/`, `server/Migrations/`, or any RLS/runtime verification path,
- `schema_v0.sql` references or shared DB model changes,
- `clients/Core/` shared models/protocols,
- `infra/docker-compose.yml` or `.conductor/setup.sh`,
- `scripts/local_gate.sh` and goal orchestration scripts,
- `ROADMAP.md`, `BUILD_TICKETS.md`, `STATUS.md` sections for the same milestone.

Large shared changes should merge in dependency order. Workers should rebase/refresh from `main` after upstream PRs merge, rerun the relevant local gate, and update their PR evidence.

## 5. Worker Prompt Template

Paste this into a worker chat:

```md
Use repo /Users/kwakseongjae/projects/momo.
Claim GitHub issue #<number> and work in a separate worktree.
Do not touch root dirty changes.

Goal:
<issue goal>

Acceptance:
<issue acceptance>

Operational:
- Use issue #<number> as the only goal.
- Prefer scripts/goal_claim.sh <number>; if unavailable, create a canonical branch/worktree manually.
- Branch/worktree lock required before editing.
- Use .env.worktree for runtime work and avoid shared ports/compose projects.
- Run scripts/local_gate.sh --profile <docs|swift|runtime-db|runtime-relay|runtime-agent|macos-ui>.
- Open one PR, paste Local Gate evidence, and hand off the PR URL back to momo-main.
- Do not merge from the worker thread unless momo-main explicitly delegates merge authority.
```

## 6. Worker Handoff Report

Each worker ends with:

```md
Issue:
Branch:
Worktree:
PR:
Local Gate:
Files changed:
Runtime coverage:
Remaining risks:
Next recommended issue:
```

If blocked:

```bash
scripts/goal_release.sh <issue-number> --blocked "<short blocker>"
```

If ready for review:

```bash
scripts/goal_release.sh <issue-number> --review --pr <PR URL>
```

## 7. PR Review And Merge Cycle

`momo-main` owns the merge lane:

1. Run `scripts/goal_status.sh` and confirm the issue has exactly one branch/worktree/PR.
2. Read the PR diff and Local Gate evidence.
3. Run code review or a review agent focused on security, correctness, scope, and test honesty.
4. Ask the worker to fix issues, or fix narrowly in the same issue worktree when delegated.
5. Run the final relevant local gate on the PR branch.
6. Merge only when local gate passes, review blockers are cleared, and unrelated dirty files are absent.
7. Update `main`, rerun the same local gate on `main`, and verify GitHub Actions remain `disabled_manually` during the manual-only period.
8. Close or relabel the issue, update `STATUS.md`/roadmap/backlog if the work changed direction, then recommend the next batch of goals.

## 8. Local Gate Profiles

Use the narrowest profile that honestly covers the changed surface:

| Profile | Use when |
|---|---|
| `docs` | Documentation, specs, static GitHub ops, shell/Python syntax only |
| `swift` | Any Swift package/model/view change |
| `runtime-db` | DB, server, migration, RLS, or tenant isolation work |
| `runtime-relay` | OutboxRelay/Centrifugo publish or realtime transport work |
| `runtime-agent` | AgentWorker, hermes/OpenAI-compatible SSE, cost accounting |
| `macos-ui` | MomoMac desktop UI or launch behavior |
| `all` | Rare merge-critical changes spanning all major surfaces |

PR evidence must come from a clean worktree. Exploratory pre-commit runs may use `LOCAL_GATE_ALLOW_DIRTY=1`, but that evidence is not enough to merge.

## 9. Thread Tool Note

If Codex thread tools are available, `momo-main` can create or hand off worker threads. If tools are unavailable or awkward, use the prompt template above. The durable lock remains GitHub Issue + remote branch + PR, not the chat itself.

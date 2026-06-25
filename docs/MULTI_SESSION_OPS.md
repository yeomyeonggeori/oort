# Multi-session Worktree Operations

> Purpose: run five or more Codex sessions without branch, issue, environment, or runtime collisions.

## 1. Roles

### momo-main

The main thread should not be a heavy implementation worker. It owns:

- roadmap and issue picker,
- issue creation/cleanup,
- branch and worktree collision checks,
- PR review/merge,
- local gate evidence collection,
- status and roadmap summaries,
- next-goal recommendation.

### Worker thread

A worker owns exactly one GitHub Issue:

- one issue,
- one branch,
- one worktree,
- one PR,
- one local gate result.

## 2. Claiming Work

Preferred:

```bash
scripts/goal_claim.sh <issue-number>
```

If the script is unavailable in the checkout:

```bash
git fetch origin main
git worktree add -b <type>/<issue-number>-<slug> ../momo-worktrees/<issue-number>-<slug> origin/main
git -C ../momo-worktrees/<issue-number>-<slug> push -u origin <type>/<issue-number>-<slug>
gh issue edit <issue-number> --add-assignee @me --add-label status:in-progress
```

The remote branch is the practical lock. If the branch already exists, do not start the same issue.

## 3. Environment Separation

Each worktree should use local runtime overrides, never copied secrets:

- `.env.worktree`: generated per worktree.
- `COMPOSE_PROJECT_NAME`: branch/worktree-specific.
- `PORT`, `POSTGRES_PORT`, `CENT_PORT`, `HERMES_PORT`: unique per worktree.
- root `.env`: treated as secret source; do not copy into commits.

Runtime tickets should avoid simultaneous port and volume collisions by using branch-specific compose project names.

## 4. Parallelism Rules

Good parallel split:

- one `momo-main` orchestration thread,
- one M1 deploy/ops worker,
- one M2 context/spec worker,
- one M3 macOS UX worker,
- one docs/trust/plugin worker.

Avoid:

- two concurrent migrations touching the same schema tables,
- two concurrent large changes in `server/Routes`,
- shared model changes and macOS/iOS UI changes without a planned merge order,
- runtime tests reusing the same Docker compose project or ports.

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
- Branch/worktree lock required.
- Run local gate from docs/LOCAL_PR_GATE.md.
- Open PR, include local evidence, and hand off PR URL back to momo-main.
```

## 6. Handoff Report

Each worker should end with:

```md
Issue:
Branch:
Worktree:
PR:
Local Gate:
Files changed:
Remaining risks:
Next recommended issue:
```

## 7. Thread Tool Note

If Codex thread tools are available, `momo-main` can create or hand off worker threads. If the tools are unavailable or awkward, use the prompt template above. The operating lock remains GitHub issue plus remote branch, not the chat itself.

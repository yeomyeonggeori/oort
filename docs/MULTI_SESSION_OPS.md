# Multi-session Worktree Operations

> Purpose: run five or more Codex sessions without issue, branch, worktree, runtime, or review collisions.
> Canonical rule: one GitHub Issue = one goal = one branch = one worktree = one PR.

## 0. Operating Model

`momo-main` is the orchestration thread. It should stay light and avoid heavy implementation except for urgent fixes.

Worker threads are implementation threads. Each worker claims exactly one GitHub Issue and works only in the worktree created for that issue. **Concurrent implementation goals are capped at 5** (planning contract `docs/planning/README.md` §3); excess work waits in `status:ready`.

Planning-layer inputs (who issues tickets, handoff packets, deviation feedback) are defined in `docs/planning/README.md`. Workers read the handoff packet linked in the issue Context before starting.

Workers stop at PR handoff: claim issue -> worktree work -> local gate -> PR -> `status:needs-review` -> handoff to `momo-main`. Workers must not merge PRs, close issues, run the post-merge `main` gate, or reorder roadmap/backlog state. Those actions are `momo-main` only.

Recommended five-session split:

| Session | Default lane | Responsibility |
|---|---|---|
| `momo-main` | orchestration | Issue picker, branch collision checks, review/merge, issue close, main gate, roadmap/status updates, next-goal recommendation |
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
- a read-only stale/done local worktree audit for closed issues or merged/closed PRs.

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

### 1.1 Stale Worktree Audit And Cleanup

The same command also audits local worktrees whose branch name follows the canonical `<type>/<issue>-<slug>` pattern. It matches each local branch to GitHub issue and PR state and prints a separate `Stale/done local worktree audit (read-only)` section.

Cleanup is never automatic. Rows are intentionally conservative:

| Audit row | Meaning |
|---|---|
| `done-candidate` | The issue is closed or the PR is merged/closed, the local worktree is not the current checkout, the worktree is clean, and no unpushed/divergent commits were detected. |
| `stale-warning` | The worktree appears tied to completed GitHub state, but cleanup needs human review first. The row explains blockers such as `dirty:<n>`, `unpushed:<n>`, `upstream-unknown`, or `current-worktree`. |

For `done-candidate` rows, copy the printed command only after confirming the issue/PR references are the intended completed work:

```bash
git worktree remove '<printed-path>'
```

Do not run cleanup commands for `stale-warning` rows until the warning is resolved. Inspect dirty files with `git -C '<path>' status --short`; inspect local-only commits with `git -C '<path>' log --oneline --decorate --max-count 20`. If the current worktree is listed, switch to another checkout before removing it.

### 1.2 Worktree Docker Compose Janitor

Parallel runtime gates can leave Docker Compose containers or networks after a worktree has been removed. Audit those resources with:

```bash
scripts/compose_janitor.sh
```

The janitor is dry-run by default. It only lists Compose-labeled worktree projects whose name starts with `momo_` and no longer matches an active git worktree. It explicitly protects the root `momo` project, `momo_default`, `supabase`, active worktree projects, and non-momo Docker resources.

Cleanup requires an explicit flag:

```bash
scripts/compose_janitor.sh --cleanup
```

The cleanup path removes only the listed stale containers and networks. Volumes are intentionally left untouched; remove them manually only after checking that no useful local database state is needed.

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

- `.conductor/local.env`: ignored local file with generated ports, compose name, and the base runtime env keys needed by Docker Compose.
- `.env.worktree`: ignored symlink to `.conductor/local.env`.
- `COMPOSE_PROJECT_NAME`: branch/worktree-specific namespace.
- `PORT`, `CENT_PORT`, `POSTGRES_PORT`, `HERMES_PORT`: deterministic branch-specific ports.
- `DATABASE_URL`, `CENT_API_URL`, `HERMES_BASE_URL`: local runtime URLs derived from those ports.

Root `.env` is treated as a secret source and must never be copied into commits. `.conductor/local.env` may mirror those values locally so `make up` can use a single `--env-file`; it is ignored and must stay uncommitted.

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

Large shared changes should be merged by `momo-main` in dependency order. Workers should rebase/refresh from `main` after upstream PRs merge, rerun the relevant local gate, and update their PR evidence.

## 5. Worker Prompt Template

Paste this into a worker chat:

```md
Use repo /Users/kwakseongjae/projects/momo.
Read docs/planning/handoffs/<packet>.md first, then claim GitHub issue #<number> and work in a separate worktree.
Do not touch root dirty changes.

Operational:
- Use issue #<number> as the only goal. The handoff packet + issue body are the full contract; the packet carries file map, contracts, pitfalls, and merge order.
- Prefer scripts/goal_claim.sh <number>; if unavailable, create a canonical branch/worktree manually.
- Branch/worktree lock required before editing.
- Use .env.worktree for runtime work and avoid shared ports/compose projects.
- Run scripts/local_gate.sh --profile <docs|swift|runtime-db|runtime-relay|runtime-agent|macos-ui>.
- Open one PR, paste Local Gate evidence, fill the "## 계획 이탈" (deviation) section honestly, run scripts/goal_release.sh <number> --review --pr <PR URL>, and hand off the PR URL back to momo-main.
- Stop after the handoff. Do not merge, close the issue, run the post-merge main gate, or adjust roadmap/backlog state from the worker thread.
```

If no handoff packet exists for the issue, ask `momo-main` for one instead of reconstructing intent from chat history — packets are mandatory for planned batches (`docs/planning/README.md` §2).

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
Handoff target: momo-main
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

`--review` requires a valid open PR that either closes the issue or uses the canonical issue branch. It is the worker stop line: after this command, `momo-main` owns review, merge, issue close, main gate, and roadmap/backlog adjustments. `--ready` returns an issue to the ready pool and removes the current assignee so another worker can claim it normally.

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

## 9. Resource Governance (호스트 부하 규칙 — 2026-07-17 발열 사고 후 정본)

> 적용 대상: **momo에서 게이트/빌드/soak를 돌리는 모든 세션**(Fable 엔진 트랙, GPT momo-main/UX 트랙, Codex worker 러너). 이 머신에서는 tf-hwp 등 다른 프로젝트도 병행되므로 momo 세션 합산이 아니라 **호스트 전체 기준**으로 판단한다.

### 9.1 부하 체크 게이트 (heavy 작업 전 의무)

docker-heavy 작업(runtime-* 게이트, e2e compose verifier, 컨테이너 내 Swift 빌드, soak) 시작 전에 확인한다:

```sh
uptime            # load 1min 기준
docker ps --format '{{.Names}}' | grep -c momo   # 활성 momo 스택 수
```

- **load(1min) > 12** (18코어의 ~65%): heavy 작업 시작 금지 — 문서/리뷰/기획 작업으로 전환하거나 부하 하강 대기.
- **load 8~12**: heavy 작업 1개만, 동시 실행 금지.
- **load < 8**: 정상 진행. 그래도 docker-heavy 게이트는 **세션당 동시 1개**(9.2).

### 9.2 잔재 방지 (사고 원인의 성문화)

1. **게이트 런 종료 즉시 해당 worktree의 compose project를 down한다** — `local_gate.sh` runtime-* 프로파일의 `make up`은 스택을 내리지 않는다(게이트 런 1회 = postgres+centrifugo 잔재 1벌). down은 게이트를 돌린 세션의 의무다. (tooling: MOMO-411 `--down` 플래그 전까지 수동.)
2. docker-heavy 게이트는 **호스트 전체에서 동시 1개** — 다른 트랙이 게이트 중이면(`docker ps`에서 분 단위 신생 momo 스택 관찰) 대기.
3. goal 종결(머지·close) 시 해당 goal의 worktree 제거 + compose 스택 down + network rm까지가 종결이다.
4. 배치 종결마다 `scripts/compose_janitor.sh --cleanup` + `docker builder prune -f --filter until=72h`. 주 1회 `~/.local/bin/momo-docker-reclaim.sh --aggressive`.
5. 무거운 타 프로젝트 병행 시 Codex worker 동시 spawn 1~2로 제한(평시 상한 5와 별개의 부하 상한).

### 9.3 판별 팁

`docker ps`에서 **Up 수 시간짜리 `momo_feat-*`/`momo240_*` postgres+centrifugo 쌍 = 잔재**(활성 게이트는 분 단위). `momo_main`과 분 단위 신생 스택만 보존 대상. 유휴 판정이 애매하면 해당 트랙 세션에 확인 후 down.

## 10. Thread Tool Note

If Codex thread tools are available, `momo-main` can create or hand off worker threads. If tools are unavailable or awkward, use the prompt template above. The durable lock remains GitHub Issue + remote branch + PR, not the chat itself.

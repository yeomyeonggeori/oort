# Internal Alpha Feedback Intake

> Scope: internal alpha feedback only. This is the path from "I tried oort and got stuck" to a reproducible GitHub issue, then to a buildable Codex goal.
> ITO 3-day decision contract: [`docs/LOCAL_3_DAY_ALPHA_TEST_PACK.md`](LOCAL_3_DAY_ALPHA_TEST_PACK.md) (`LAUNCH_READY` / `BLOCKED` / `NEEDS_MORE_INTERNAL`).
> Do not paste secrets, bearer tokens, raw invite codes, production credentials, or private user content. Redact before sharing outside the immediate team.

## 1. Intake Source

Internal alpha feedback starts in one of three places:

- a teammate files GitHub's `Internal alpha feedback` issue template,
- momo-main converts a chat note into that template,
- a worker/tester attaches an evidence packet after running a local gate.

The first issue is an intake record, not yet a worker goal. It should carry:

- `type:feedback`
- `area:alpha`
- `status:needs-triage`

Do not add `status:ready` until the issue has a concrete Goal/Context/Acceptance/Out of scope contract and a matching milestone.

## 2. Severity

| Severity | Definition | Default labels | Expected response |
|---|---|---|---|
| P0 | Data loss/security. Includes cross-tenant leak, secret exposure, destructive data corruption, or alpha launch/login impossible for every tester. | `priority:p0`, relevant `area:*` | Stop the affected alpha flow, preserve evidence, create a narrow fix goal immediately. |
| P1 | Core alpha flow blocked. Send, invite/join, agent mention, approval/cost, realtime, diagnostics, or local gate cannot complete for a normal tester. | `priority:p1`, relevant `area:*` | Convert to a buildable goal before the next alpha round. |
| P2 | Usability friction. Flow works but is confusing, brittle, missing expected feedback, or requires an undocumented workaround. | `priority:p2`, relevant `area:*` | Batch into the next polish or docs goal unless repeated. |
| P3 | Polish. Copy, layout, visual fit, minor papercut, or non-blocking affordance issue. | `priority:p2`, relevant `area:*` | Keep as backlog or fold into nearby UX/docs work. |

If severity is unclear, keep `status:needs-triage`, ask for the missing evidence, and do not assign a worker yet.

## 3. Required Evidence

Every intake issue must include enough context for another worker to reproduce or consciously mark the gap as `runtime-unverified`:

- Local gate profile: for example `docs`, `diagnostics`, `host-runtime`, `internal-alpha`, `web`, `runtime-agent`. Do not record the retired profile name `macos-ui` as something to run — `scripts/local_gate.sh` no longer accepts it (W-S1 / #1215).
- Local gate evidence: path to the generated markdown/log, or a PR/comment URL that contains the `## Local Gate` block.
- Diagnostics bundle path: output from `scripts/collect_diagnostics.sh --output-dir ... --since ...`, when the report involves runtime, web or desktop launch, local stack, or logs.
- Repro steps: numbered, minimal, starting from a known local stack/app state.
- Workspace/channel/member context: workspace name or seed, channel, member/user, agent involved, server URL or app mode.
- Expected/actual: what the tester expected and what happened instead.
- Screenshots, screen recording, or relevant log excerpt when UI/realtime behavior is involved.

Evidence may be missing for a chat-only note, but momo-main must mark exactly what is missing before converting it to a buildable goal.

## 4. Triage Procedure

1. Create or normalize the GitHub issue with the internal alpha feedback template.
2. Confirm severity using §2. Add `priority:p0`, `priority:p1`, or `priority:p2`.
3. Confirm evidence using §3. If reproduction is impossible, comment with the missing fields and keep `status:needs-triage`.
4. Add the most specific surface labels that already exist: `area:server`, `area:worker`, `area:relay`, `area:infra`, `area:ci`, `area:core`, or `area:alpha` for process-only feedback. Do **not** tag current web/Tauri ITO reports `area:macos` — that label is the retired MomoMac SwiftUI client (`scripts/github/labels.tsv`). There is no `area:web` / `area:desktop` yet; until those exist, use `area:alpha` plus the server/infra/core label that matches the blast.
5. Pick the milestone by blast radius against the current `ROADMAP.md` axes: runtime/ops stays M1-shaped, QA-gate evidence stays M7-shaped. Do not park web/desktop ITO findings in the retired M3 «macOS SwiftUI UX» bucket.
6. Convert the issue into a buildable goal by replacing or appending the standard contract:

```md
## Goal
<one concrete done state>

## Context
- Alpha feedback:
- Evidence:
- Relevant docs/code:

## Acceptance
- [ ] [docs]/[web]/[runtime]/[manual] <checkable result>
- [ ] Repro evidence or explicit `runtime-unverified` note
- [ ] STATUS.md or relevant docs updated if behavior/process changes

## Out of scope
- <what this goal will not fix>
```

7. Move labels from `status:needs-triage` to `status:ready` only when the goal is worker-ready and unassigned.
8. Worker claims with `scripts/goal_claim.sh <issue>`, implements in the created worktree/branch, runs the relevant local gate, opens one PR, then runs `scripts/goal_release.sh <issue> --review --pr <PR URL>`.
9. momo-main reviews, requests fixes if needed, runs the final local gate, merges, closes, and handles any post-merge main gate.

## 5. Status Board

Use the status board before starting triage or worker assignment:

```bash
scripts/goal_status.sh --repo yeomyeonggeori/oort
```

`status:needs-triage` rows are alpha feedback intake. Their `evidence` column should read `triage-feedback`; they are not claimable worker goals yet.

For a raw GitHub CLI query:

```bash
gh issue list --repo yeomyeonggeori/oort --label status:needs-triage --state open --json number,title,labels,assignees,url
```

## 6. Local Gate Pairing

Choose the smallest profile that proves the claim:

| Feedback surface | Minimum gate |
|---|---|
| Template/docs/process only | `scripts/local_gate.sh --profile docs` |
| Diagnostics bundle behavior | `scripts/local_gate.sh --profile diagnostics` |
| Full internal alpha handoff | `scripts/local_gate.sh --profile internal-alpha` |
| Web UI / serving | `scripts/local_gate.sh --profile web` |
| Desktop shell login/CORS | No local_gate profile. Record T-A (#1607) release-bundle evidence against the self-host stack; see `clients/desktop/README.md` Known gaps. |
| Agent runtime | `scripts/local_gate.sh --profile runtime-agent` |
| Realtime/live subscribe | `scripts/local_gate.sh --profile runtime-live` |

If the required profile cannot run on the current machine, keep the issue honest: record the blocker, preserve available evidence, and use `runtime-unverified` only for the exact uncovered surface.

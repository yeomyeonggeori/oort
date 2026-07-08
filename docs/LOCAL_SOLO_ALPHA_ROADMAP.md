# Local Solo Alpha Roadmap

> Purpose: bring momo to a level where one operator can run a local Docker stack,
> open the macOS dev app, invite/use a local Hermes-compatible agent, and collect
> enough evidence for a 3-day dogfood decision before AWS.

## Definition of Done

Local solo alpha is ready when all of the following are true on a chosen commit:

- `scripts/local_gate.sh --profile docs` and `--profile swift` pass.
- `scripts/local_gate.sh --profile local-alpha` passes with a generated local env
  that includes `CENT_PROXY_SECRET`, migration `007_agent_run_a2a_guards.sql`,
  idempotent second migrate evidence, REST message send, relay publish, mock
  agent roundtrip, macOS real-backend smoke, backup restore rehearsal, and
  diagnostics.
- The macOS app can be started with `scripts/momo start`, logs in with a fresh
  post-MOMO-300 session, and sends/reads messages against the local server.
- A Hermes-compatible runtime can be started locally by the user with
  provider-owned GPT/Codex OAuth credentials. momo must not read, copy, or store
  the OAuth token; momo only receives a loopback endpoint and Hermes-facing
  bearer or smoke env outside the repo.
- Sending `@hermes` in a channel creates an `agent_job`, AgentWorker calls the
  local OpenAI-compatible SSE provider, usage is minimally recorded, and the
  agent response is persisted back to the same channel timeline.
- For the Hermes-native path, Hermes gateway can load the momo platform plugin,
  receive momo `agent.job` events, run its provider-owned OAuth runtime, and
  report final result/usage back to momo REST without direct DB/Centrifugo
  writes.
- A reduced start gate can record enough evidence to begin a 1-3 day local solo
  run without waiting for an unattended 72h soak.
- A later full 72h/pre-production run can still record daily evidence,
  failures, resource snapshots, and a final `AWS_READY`, `NEEDS_MORE_LOCAL`, or
  `BLOCKED` decision before AWS promotion.

## Current State

The redesign baseline is stronger than the older dogfood plan:

- MOMO-300 makes old tokens fail closed and requires `CENT_PROXY_SECRET` for
  realtime subscribe proxy.
- MOMO-301 added `agent_run` depth/round columns and real loop guard queries.
- MOMO-302 sends recent same-channel history to the agent, bounded by
  `AGENT_CONTEXT_MAX_MESSAGES` and `AGENT_CONTEXT_MAX_CHARS`.
- MOMO-316/MOMO-318 added local gate automation and design pre-flight ratchets.
- MOMO-237/MOMO-240/MOMO-241/MOMO-245 already provide most of the local alpha,
  runner, 3-day pack, and soak-monitor infrastructure.
- MOMO-325/MOMO-326/MOMO-333 proved the Hermes-native gateway path: Hermes can
  load momo as a platform, subscribe to the `agent:` realtime work stream,
  receive `agent.job`, call its provider-owned runtime, and report a durable
  same-channel response through momo REST without direct DB/Centrifugo writes.
- MOMO-334 changed the macOS dogfood UX so Hermes is no longer shown as an
  already-invited mock agent on first launch. The member `+` flow now branches
  into human/agent invite, and Hermes appears in the roster only after an
  explicit dogfood invite succeeds against the server membership path.
- MOMO-335, MOMO-260, MOMO-262, and MOMO-261 made the local solo UI usable
  enough for a first operator-led loop: roster-backed `@` autocomplete, Hermes
  working state, profile/settings polish, agent pairing wizard, and clearer
  approval/developer surfaces are now merged.
- MOMO-252 / PR #253 was closed instead of merged. Its 72h soak hardening ideas
  are useful later, but the PR was stale and could convert host API/Centrifugo
  or Postgres access failures into false PASS evidence. Full 72h soak is now a
  later AWS-promotion/pre-production signal, not the local solo entry blocker.

Remaining work is not a new platform rewrite. It is a short stabilization lane
that makes the local solo path comfortable and repeatable.

## Buildable Goal Chain

| Order | Goal | Purpose | Evidence |
|---|---|---|---|
| LSA-001 | Redesign-aligned local alpha readiness | Align local runner/docs/app defaults with MOMO-300/301/302 so fresh local tests do not fail on stale tokens, missing proxy secret, or stale demo password. | `docs`, `swift`, `local-alpha` gates |
| MOMO-319 | Gate/verifier hardening | Done for the local solo alpha stability slice: runtime verifiers clean up their own host processes/ports and only remove verifier-owned stale fixture state before repeated runs. Broader runtime-db parallel/warm-volume speedups stay as follow-up optimization. | `runtime-agent` full gate PASS; repeat bridge/worker verifier PASS |
| MOMO-320 | Local runtime env drift guard | Keep old generated `.env.worktree` files from silently omitting Centrifugo/JWT secrets after env contract changes; regenerate generated worktree env before Docker/runtime gates. | `docs` + `runtime-agent` PASS after stale env regeneration |
| MOMO-303 | MomoDS v0 | Establish tokens/components/density before more UI polish so dogfood UI work stops reintroducing hard-coded visual drift. | `swift` gate + design pre-flight count reduced |
| MOMO-304 | Messenger core UX v0 | Add markdown/code rendering, edit/delete basics, and roster-based `@` autocomplete so one-person + agent chat feels like a usable messenger. | `macos-ui` + runtime route evidence |
| LSA-005 | Credentialed Hermes setup rehearsal | Turn MOMO-257 into a user-followable local pairing flow: user logs into provider, `scripts/momo hermes-init` creates the out-of-repo env, `scripts/momo hermes` checks setup without printing secrets, and `scripts/momo hermes-smoke` runs the credentialed smoke. | `external-agent-provider` or documented `runtime-unverified(credentials)` |
| MOMO-326 | Real Hermes gateway smoke | Turn MOMO-325 from mock-ledger proof into operator-led real Hermes readiness: plugin install, provider OAuth marker, gateway status, and optional `@hermes` same-channel roundtrip evidence. | `scripts/momo hermes-gateway-smoke --real [--trigger]` |
| LSA-006 | Local solo dogfood start gate | Start a short operator-led run before 72h: launch app, send human messages, call `@hermes`, collect diagnostics/resource snapshots, and file P0/P1 bugs. | updated `docs/LOCAL_3_DAY_ALPHA_TEST_PACK.md` run packet |

## Active Buildable Goal Chain

This is the current momo-main tracker for getting to a comfortable one-person
local Hermes dogfood. If context is compacted, resume from this table before
choosing or creating more issues.

| Order | Issue | Status | Why now | Merge gate |
|---|---|---|---|---|
| 1 | GitHub `#300` / `MOMO-335` | done | `@hermes` works only if the user remembers the handle. Roster-backed `@` autocomplete and Hermes working indicators make the chat feel alive during gateway latency. | `swift test --package-path clients/macOS`; `scripts/local_gate.sh --profile macos-ui` |
| 2 | GitHub `#263` / `MOMO-260` | done | Profile/settings remain local-draft and confusing. Finish workspace/member/agent profile editing, avatar/status chips, and keep Hermes alias/profile display consistent after invite. | `scripts/local_gate.sh --profile macos-ui`; docs gate |
| 3 | GitHub `#265` / `MOMO-262` | done | Agent invite now has a Hermes pairing wizard with alias/profile/endpoint/model/scope, manifest copy/export, loopback HTTP guard, and provider-owned credential boundary. | `scripts/local_gate.sh --profile runtime-agent`; `macos-ui`; docs gate |
| 4 | GitHub `#264` / `MOMO-261` | done | Approval/Command Center copy now explains the agent approval inbox, diagnostic surfaces are less ambiguous, and typing/working activity is visible without turning the chat into a debug console. | `swift build --package-path clients/macOS --product MomoMacDevApp`; `swift test --package-path clients/macOS`; `scripts/local_gate.sh --profile macos-ui` |
| 5 | GitHub `#305` / `MOMO-336` | done in this PR | Retarget the old MOMO-246/MOMO-252 full 72h soak into a reduced Local Solo Hermes Dogfood Start Gate. Keep monitor tooling, but do not block first local solo usage on unattended 72h evidence. | `scripts/local_gate.sh --profile docs` |

### momo-main Pipeline for This Chain

For each row above, `momo-main` should:

1. Ensure the issue exists and has `Goal / Context / Acceptance / Out of scope`.
2. Claim or create one branch/worktree for that issue.
3. Implement the scoped change.
4. Run the issue-specific local gate and attach evidence to the PR.
5. Run a code-review pass focused on security, correctness, and performance.
6. Apply necessary review fixes before merging.
7. Merge only after final local gate is green.
8. Re-run the relevant main local gate after merge.
9. Update this table, `STATUS.md`, and `BUILD_TICKETS.md` if priority or scope
   changes.
10. Choose the next row or pause for roadmap research if the previous task
    changes product direction or reveals a blocker.

## Operating Rules

- AWS is out of scope until this lane produces `AWS_READY` evidence.
- Kubernetes is out of scope for local solo alpha; Docker Desktop is sufficient.
- Real provider credentials remain user-owned and outside the repository.
- Mock Hermes and credentialed Hermes evidence must be labeled separately.
- A full 72h soak is optional before local solo dogfood and required only when a
  later AWS/pre-production promotion explicitly asks for unattended evidence.
- UI follow-up should wait for MOMO-303 unless it blocks local alpha launch or
  makes the app impossible to operate.

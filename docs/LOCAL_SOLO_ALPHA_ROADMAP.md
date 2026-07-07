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
- A 3-day run can record daily evidence, failures, resource snapshots, and a
  final `AWS_READY`, `NEEDS_MORE_LOCAL`, or `BLOCKED` decision.

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
| LSA-005 | Credentialed Hermes setup rehearsal | Turn MOMO-257 into a user-followable local pairing flow: user logs into provider, out-of-repo env is checked, child process env is least-privilege, provider URLs with query/fragment secrets are redacted, and momo runs a credentialed smoke. | `external-agent-provider` or documented `runtime-unverified(credentials)` |
| LSA-006 | Local solo dogfood start gate | Start a short operator-led run before 72h: launch app, send human messages, call `@hermes`, collect diagnostics/resource snapshots, and file P0/P1 bugs. | updated `docs/LOCAL_3_DAY_ALPHA_TEST_PACK.md` run packet |

## Operating Rules

- AWS is out of scope until this lane produces `AWS_READY` evidence.
- Kubernetes is out of scope for local solo alpha; Docker Desktop is sufficient.
- Real provider credentials remain user-owned and outside the repository.
- Mock Hermes and credentialed Hermes evidence must be labeled separately.
- UI follow-up should wait for MOMO-303 unless it blocks local alpha launch or
  makes the app impossible to operate.

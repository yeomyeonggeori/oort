# ADR 0001: Agentic Work OS Repo Topology and Deploy Layering

> Status: Accepted for roadmap guidance.
> Date: 2026-06-29.
> Related: MOMO-180.

## Context

Paca shows a useful ecosystem shape: core monorepo, plugin catalog, first-party plugins, plugin SDKs, MCP package, and separate deploy artifacts. OpenHands shows another shape: agent frontend/control center separated from agent server/backends. Linear/GitHub/Rovo show that existing work systems are becoming agent-accessible through MCP, coding agents, and governed automation.

momo currently has a different center of gravity. It is not a board-first project manager and not a coding-agent-only canvas. momo's center is the channel timeline as a governed execution ledger for humans, AI agents, and plugins.

The repo topology must therefore protect two things:

1. Fast iteration on the tightly coupled core: server, relay, worker, schema migrations, macOS/iOS clients, Context Packet, Memory Plane, Capability Cache.
2. A future plugin ecosystem where installable capabilities can move independently from the core product.

## Decision

Keep `Dawn-kim-official/momo` as the core monorepo through M3/M4.

Do not split server/relay/worker/clients yet. Their protocol contracts are still changing together: approval pause/resume, agent run lifecycle, realtime subscription, macOS cards, REST ChatBackend, and local gate profiles. Splitting now would increase coordination cost without improving product delivery.

Prepare a staged org-level split for ecosystem surfaces once protocol boundaries stabilize.

## Future repo topology

| Repo | Visibility | Earliest milestone | Purpose | Split trigger |
|---|---|---|---|---|
| `momo` | private now, public/dual later | now | core product monorepo: server, relay, worker, clients, infra, specs, local gates | current repo |
| `momo-signing` | private | now/M4 | signing material docs, match-compatible storage, notarization/private release secrets | already planned private boundary |
| `momo-plugins` | public or private catalog | M2.5/M3 | plugin catalog: manifest index, artifact metadata, signatures, compatibility matrix | plugin manifest v0 accepted |
| `momo-plugin-github` | public/private | M3 | first-party GitHub/GitHub Issues connector | plugin host + approval write path works |
| `momo-plugin-google-workspace` | private first | M3/M4 | Drive/Gmail/Calendar connector; sensitive OAuth surface | MOMO-122/123 runtime design accepted |
| `momo-plugin-jira` or `momo-plugin-work-items` | public/private | M3/M4 | Jira-like ticket/work-item reference plugin | message context action -> ticket flow accepted |
| `momo-plugin-docs` | public/private | M3/M4 | Obsidian/Notion/Confluence source connector | source citation + memory refs stable |
| `momo-plugin-sdk-ts` | public | M4 | plugin manifest/types, MCP/tool bridge, admin UI helper types | two first-party plugins share code |
| `momo-plugin-sdk-swift` | public/private | M4/M5 | native/macOS plugin helper only if needed | Swift client/plugin extension need appears |
| `momo-plugin-sdk-mcp` | public | M4 | MCP server/tool exposure helpers for plugins | inbound MCP runtime stabilizes |
| `momo-mcp` | public package | M4/M5 | standalone MCP server package if distribution via npm/pip/binary matters | external users need install without cloning core |
| `momo-landing` | public | M4/M5 | marketing/docs site independent from product release cadence | public launch work begins |

## Split criteria

A new repo is justified only when at least one is true:

- Release cadence differs from the core product.
- Distribution channel differs, such as npm/pip/binary/plugin artifact.
- Security boundary differs, such as signing secrets or OAuth connector credentials.
- External contributors need a smaller surface than the core repo.
- The component has stable public API/manifest contracts.

A new repo is not justified when:

- The boundary is still changing every few tickets.
- The split would require cross-repo PR choreography for a single feature.
- The component is only an implementation detail of server/relay/worker.
- The repo would mainly hide unfinished code rather than establish a real boundary.

## Plugin ecosystem layering

momo plugin v0 should be manifest-first.

Minimum plugin manifest fields:

- `id`, `name`, `version`, `publisher`.
- `runtime`: `external_webhook`, `hosted_connector`, `mcp_tool_proxy`, later `wasm`.
- `surfaces`: slash command, message context action, approval card, source provider, sidebar/admin settings.
- `capabilities`: tool names, input schema refs, output schema refs, read/write grants.
- `approval_policy`: never/read-only/require-approval/always.
- `risk`: read/low/medium/high.
- `source_policy`: what source refs can enter Context Packet.
- `audit_policy`: events emitted on tool call/result/failure/revoke.
- `compatibility`: momo protocol version, server API version, client card version.
- `signature`: optional in dev, required before marketplace/trust gate.

Paca uses WASM for backend plugin isolation. momo should not adopt a WASM runtime immediately. The first practical step is governed external connectors plus capability metadata because momo already has approval/cost/audit primitives. WASM or other sandboxed in-process plugins become M5+ only after manifest, catalog, signed artifacts, and permission model are stable.

## Docker and deploy layering

Detailed operating contract: `docs/adr/0002-docker-compose-layering.md` (MOMO-182).

Current state:

- `infra/docker-compose.yml` is the dev/runtime verification stack.
- `infra/prod/docker-compose.prod.yml` is a staging/prod skeleton.
- `scripts/local_gate.sh` profiles are the merge gate while GitHub Actions are manual-only/disabled.

Target layering:

| Layer | File | Purpose |
|---|---|---|
| dev | `infra/docker-compose.dev.yml` or current `infra/docker-compose.yml` | local development, worktree-specific env/ports, PG/Centrifugo/optional mock Hermes |
| e2e | `infra/docker-compose.e2e.yml` | fixed test credentials, full runtime local gate, deterministic mock external services |
| prod | `infra/prod/docker-compose.prod.yml` | image-based self-hosting without source checkout |
| install | `infra/prod/install.sh` | generate secrets, choose bundled/external DB, TLS, backup, optional agent runtime |
| upgrade | `infra/prod/upgrade.sh` | backup compose/env, pull pinned images, run migration, restart |
| backup | `infra/prod/db-backup` or pgBackRest service | scheduled backup/PITR rehearsal path |

Production deploy should eventually pull versioned images, not build from a source checkout on the host. This matches the self-host expectation: a customer can install with compose, env, and images while keeping source and CI separate.

## Consequences

Positive:

- Core delivery remains fast while protocol surfaces are still moving.
- Plugin ecosystem can become real without forcing premature repo churn.
- Enterprise trust story gets sharper: signed plugin artifacts, explicit capability grants, approval/cost/audit ledger.
- Self-host deploy story becomes closer to Paca/OpenHands quality without copying their product.

Tradeoffs:

- The core monorepo remains large through M3/M4.
- Plugin developers must wait for manifest/catalog contracts before independent repos are fully useful.
- Docker/prod installer work becomes a real milestone, not a small script.

## Follow-up tickets

- MOMO-181: Plugin manifest/catalog split criteria.
- MOMO-182: Docker compose layer ADR/dev-e2e-prod plan.
- MOMO-183: First-party plugin repo strategy.
- MOMO-184: Agent host positioning/product messaging.

## Non-goals

- Create the new repos in MOMO-180.
- Implement plugin runtime.
- Implement production installer.
- Move current core packages out of the monorepo.
- Change GitHub Actions policy.

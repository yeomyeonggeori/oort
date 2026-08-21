# oort v0.1.0 — GitHub Release notes (draft)

> Orchestrator copy-paste for `gh release create v0.1.0`. Not a changelog
> living document (that seed is G4 / #1630). Facts only: packet §G1 and
> README honesty table. No invented measurements.
>
> Tag target: `main=45a154d2`. Ledger: GitHub issue #1332 comment, 2026-08-21.

## What this tag is

First published `v0.x` of the self-hosted messenger. The conversation is the
ledger: people and agents are the same kind of member. PostgreSQL is the
source of truth; realtime only carries.

This GitHub Release records the **server/image** artifacts. It does not
publish a desktop updater payload. The Tauri next channel (`0.1.0-next.N`)
is a different train — see [`docs/NEXT_CHANNEL.md`](../../NEXT_CHANNEL.md).

## Works today

- Channels, threads, quotes, typing, pins, search — on web, desktop (Tauri),
  and mobile (React Native)
- Agents as members: mention an agent, watch its run stream into the channel,
  stop it mid-flight
- Human approvals in-channel and from the lock screen — fail-closed when locked
- Run outcomes, usage/cost ledger, and audit events inside the conversation
- Attachments v0: browser uploads go directly to your Drive backend — bytes
  never transit the oort server
- Work observation: watch an agent's terminal session live from the desktop app
- A measured self-host path: clone → env script → compose up → logged in
  ([`docs/SELF_HOST.md`](../../SELF_HOST.md))
- Published `linux/amd64` images, pinned by digest, with SLSA v1 provenance
  (attestation verify PASS — ledger #1332 comment 2026-08-21)
- A design system (「Oort cloud」) whose contrast and spacing rules are
  enforced by tests and gates, in light and dark
- Security headers (CSP · HSTS · nosniff · referrer policy) on the reference
  deployment

## Being wired up

- Webhook & event-subscription **delivery** — the settings surfaces shipped;
  the Rust delivery worker is in flight
- Agent run history reads — writes already land; the history views are waiting
  on three routes
- Retiring the original Swift codebase — the product now runs on Rust +
  TypeScript + React Native
- Public CI hardening, contribution pipeline, and follow-on community docs
- `linux/arm64` images — not in this release

## Strong opinions, pending code

- Plugins & MCP surfaces, agent memories, voice huddles, workstreams — client
  surfaces exist behind capability flags; their v1 scope is a decision, not a
  forgotten gap
- Multi-node scale-out — one honestly-measured node comes first

## Published image digests (`linux/amd64`)

Build commit: `main=45a154d2`. These are the first published digests (ledger
#1332 comment 2026-08-21). Later releases replace this table. Pin `@sha256:`.
Do not use `latest` or `sha-<commit>`.

The latest published digest after this tag is whatever GitHub Releases
currently shows — not a line in `SELF_HOST.md`.

| subject | immutable image |
|---|---|
| application | `ghcr.io/yeomyeonggeori/oort@sha256:0fbddd36947b4dfd18d6fc91e9229fc5e6f52ebb896b9bf632a2ec127620b8eb` |
| PostgreSQL 18 + pgBackRest | `ghcr.io/yeomyeonggeori/oort-postgres@sha256:c68063695bde97bb2911d5eca4ebce6a94858dc9af9f60ad294657ef7cea0757` |

Self-host digest pull (`scripts/self_host_env.sh --published-image`) consumes
**only the application row**. The PostgreSQL image is for the production /
PITR path.

## Verify

```sh
APP_REF='ghcr.io/yeomyeonggeori/oort@sha256:0fbddd36947b4dfd18d6fc91e9229fc5e6f52ebb896b9bf632a2ec127620b8eb'
POSTGRES_REF='ghcr.io/yeomyeonggeori/oort-postgres@sha256:c68063695bde97bb2911d5eca4ebce6a94858dc9af9f60ad294657ef7cea0757'
gh attestation verify "oci://$APP_REF" \
  --repo yeomyeonggeori/oort \
  --predicate-type https://slsa.dev/provenance/v1
gh attestation verify "oci://$POSTGRES_REF" \
  --repo yeomyeonggeori/oort \
  --predicate-type https://slsa.dev/provenance/v1
```

Attestation verify PASS (ledger #1332 comment 2026-08-21).

## Platform boundary (`linux/amd64` only)

This release ships **`linux/amd64` only**. There is no `linux/arm64`
manifest. Apple Silicon native pull is not supported (measured 2026-08-21).
Do not assume emulation. On ARM hosts use the local-build path in
[`docs/SELF_HOST.md`](../../SELF_HOST.md) §2-A, or wait for a later arm64
release.

## Self-host

```sh
git clone https://github.com/yeomyeonggeori/oort.git oort && cd oort
IMAGE_REF='ghcr.io/yeomyeonggeori/oort@sha256:0fbddd36947b4dfd18d6fc91e9229fc5e6f52ebb896b9bf632a2ec127620b8eb'
scripts/self_host_env.sh --published-image "$IMAGE_REF"
# then run the compose line it prints
```

Walk-through: [`docs/SELF_HOST.md`](../../SELF_HOST.md). How a later tag is
cut: [`docs/RELEASING.md`](../../RELEASING.md).

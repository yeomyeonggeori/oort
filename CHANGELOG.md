# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

How a later server/image tag is cut: [`docs/RELEASING.md`](docs/RELEASING.md).
Desktop Tauri next (`0.1.0-next.N`) is a different train —
[`docs/NEXT_CHANNEL.md`](docs/NEXT_CHANNEL.md).

## [Unreleased]

## [0.1.4] - 2026-09-02

GitHub Release: <https://github.com/yeomyeonggeori/oort/releases/tag/v0.1.4>. Tag target: `main=e39e9427`. Multi-arch (linux/amd64 + linux/arm64) manifest lists, SLSA v1 provenance verified. Source notes: [`docs/planning/research/2026-09-02-v0-1-4-release-notes.md`](docs/planning/research/2026-09-02-v0-1-4-release-notes.md).

### Added
- Message reminders REST CRUD + web UI (ADR-0175); custom member status on presence + settings UI (ADR-0176).
- Member-owned sidebar sections (`member_sidebar_prefs`), star/sort/drag-and-drop, row context menu (ADR-0177).
- Search channel scope (`channel=` + sealed cursor) and scope chips; unified `@`/`#`/`:` composer autocomplete.
- Mark-unread signal (`marked_unread_before_seq` + `read_intent`) with a single momo-core composition point and 「여기부터 안 읽음」 (ADR-0178).
- Appearance accent system (Dawn default + 4 curated accents, ADR-0174); onboarding S0 Oort landing + step shell (BZ-6a).
- buzz-parity wave: reaction name tooltips, top unread jump pill, huddle mic device picker + gain, notification permission/kind toggles, cross-channel drafts panel, composer format tray, link preview rich/compact/off, channel intro block, settings page + profile display name, sidebar collapse, channel header rework.
- Roster role change from member profile; profile menu logout with confirmation; self display-name rename; agent-target role change rejection.
- Self-host huddle `MOMO_LIVEKIT_NODE_IP` knob (generated env default 127.0.0.1).

### Changed
- Governance/docs: ADR-0179~0182 accepted (motion/press/elevation/density axes, QR device link, welcome kickoff, ephemeral confirmation policy); `docs/planning/PIPELINE.md` single lane/model canon; `CODEX.md` merged into `AGENTS.md`; canonical docs rotation.

### Known
- UnreadPill return-visit arming is non-deterministic (pre-existing, #1966); phone does not consume mark-unread yet (#1964).

## [0.1.0] - 2026-08-21

First published `v0.x` of the self-hosted messenger. GitHub Release:
<https://github.com/yeomyeonggeori/oort/releases/tag/v0.1.0>.
Tag target: `main=45a154d2`. Source notes (no invented measurements):
[`docs/planning/research/2026-08-21-v0-1-0-release-notes.md`](docs/planning/research/2026-08-21-v0-1-0-release-notes.md).
Ledger: GitHub issue #1332 comment, 2026-08-21.

This GitHub Release records **server/image** artifacts. It does not publish a
desktop updater payload.

### Added

- Channels, threads, quotes, typing, pins, search — on web, desktop (Tauri),
  and mobile (React Native).
- Agents as members: mention an agent, watch its run stream into the channel,
  stop it mid-flight.
- Human approvals in-channel and from the lock screen — fail-closed when locked.
- Run outcomes, usage/cost ledger, and audit events inside the conversation.
- Attachments v0: browser uploads go directly to the operator's Drive backend —
  bytes never transit the oort server.
- Work observation: watch an agent's terminal session live from the desktop app.
- A measured self-host path: clone → env script → compose up → logged in
  ([`docs/SELF_HOST.md`](docs/SELF_HOST.md)).
- Published `linux/amd64` images, pinned by digest, with SLSA v1 provenance
  (attestation verify PASS — ledger #1332 comment 2026-08-21).
- A design system (「Oort cloud」) whose contrast and spacing rules are
  enforced by tests and gates, in light and dark.
- Security headers (CSP · HSTS · nosniff · referrer policy) on the reference
  deployment.

| subject | immutable image |
|---|---|
| application | `ghcr.io/yeomyeonggeori/oort@sha256:0fbddd36947b4dfd18d6fc91e9229fc5e6f52ebb896b9bf632a2ec127620b8eb` |
| PostgreSQL 18 + pgBackRest | `ghcr.io/yeomyeonggeori/oort-postgres@sha256:c68063695bde97bb2911d5eca4ebce6a94858dc9af9f60ad294657ef7cea0757` |

Self-host digest pull (`scripts/self_host_env.sh --published-image`) consumes
**only the application row**. The PostgreSQL image is for the production / PITR
path. Pin `@sha256:`. Do not use `latest` or `sha-<commit>`.

Honesty-table items still in flight at this tag (not a schedule): webhook and
event-subscription **delivery** (settings surfaces shipped; Rust delivery worker
in flight); agent run-history reads (writes land; views wait on three routes);
retiring the original Swift codebase. `linux/arm64` images are **not** in this
release. Apple Silicon native pull is not supported (measured 2026-08-21). On
ARM hosts use the local-build path in
[`docs/SELF_HOST.md`](docs/SELF_HOST.md) §2-A, or wait for a later arm64
release.

[Unreleased]: https://github.com/yeomyeonggeori/oort/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/yeomyeonggeori/oort/releases/tag/v0.1.0

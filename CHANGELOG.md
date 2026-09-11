# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

How a later server/image tag is cut: [`docs/RELEASING.md`](docs/RELEASING.md).
Desktop Tauri next (`0.1.0-next.N`) is a different train —
[`docs/NEXT_CHANNEL.md`](docs/NEXT_CHANNEL.md).

## [Unreleased]

## [0.1.5] - 2026-09-11

GitHub Release: <https://github.com/yeomyeonggeori/oort/releases/tag/v0.1.5>. Tag target: `main=803ae7d5`. Multi-arch (linux/amd64 + linux/arm64), digest pins in `releases/latest.json`.

### Added
- First-class claim mode in the generator: `scripts/self_host_env.sh --claim` writes `MOMO_BOOTSTRAP_CLAIM=1` instead of the owner password key (1:1 key swap, canonical 43 / T2 44), `--compose` brings up a claim env (ADR-0166 exclusion keeps refusing both keys), doctor accepts the claim fixture; the awk surgery is retired from the docs. (#2438)
- `momo_notifier` runtime DB role (LOGIN NOSUPERUSER BYPASSRLS) with table-scoped least-privilege GRANTs derived from the notifier call graph incl. INVOKER trigger reads, notifier URL switched off the owner URL, `oort doctor` role/DELETE/allowlist check, static grant guard (`test_notifier_role_grants.sh`), and automatic env backfill of the two new keys on `oort upgrade` / generator re-run for existing installs. (#2193, #2448)
- Zero-base onboarding (ADR-0185): after the claim password, S1 「내 워크스페이스·내 이름」 (workspace name · display name · handle, 1/2) → S2 「팀원 초대」 (invite link, skip escape hatch, 2/2) → first-run (kickoff-hold → 「첫 에이전트 연결」 → phone link). The seeded 「데모 사용자」/`momo Demo Workspace` labels no longer surface; settings › 워크스페이스 (rename) and settings › 프로필 (handle) are the re-entry doors. (#2301, #2331, #2332, #2333, #2334, #2335, #2356, #2336)
- Engine write paths: `PATCH /v1/workspaces/{ws}` (rename, `updatedAtMs` 409) and `PATCH /v1/workspaces/{ws}/members/me` `handle` (409 taken / 403 banned, `member.renamed` fan-out, past message bodies untouched). (#2331)
- Welcome kickoff on first agent activation (native create or hosted Agent Port `active`), delivered over the gateway rail for hosted agents; with 0 agents the client goes straight to 「첫 에이전트 연결」. (ADR-0181 D2/D3 amendment, #2334, #2335)
- Platform-neutral self-hosting (ADR-0184): `scripts/self_host_env.sh --platform <name>` profiles (railway = `--railway` alias, fly, aws-lightsail, gcp-vm, host-network), `MOMO_SELF_HOST_PLATFORM` stamp, `docs/SELF_HOST_AGENT.md` §0 agent boundary + §1 tier table. (#2296, #2328, #2340)
- Day-2 contract v2 for managed platforms (T2): `oort backup/restore` over `MIGRATE_DATABASE_URL`, `oort doctor --tier t2` (SQL-over-URL `stack.*`, `/healthz` `schema{applied,head}`), `oort upgrade` = platform redeploy; runtime image ships PGDG `postgresql-client-18` + python3 so day-2 runs in-image. (#2325, #2346, #2347)
- Provisioning recipes: Fly.io T1 (`infra/fly`), AWS Lightsail/EC2 T1 (`infra/aws`, Terraform + cloud-init + least-privilege IAM + budget guard), Cloudflare T3 edge (`infra/cloudflare`, DNS · Tunnel · TLS, not compute), each with a static contract test. (#2379, #2377, #2386)
- Agent credentials settings screen (SH-6a-w), Slack-compatible webhook inbound `/hooks/*` via every public edge (#1265), Agent Port join + doorbell/sweep playbook for hosted agents, Grok Bot CDP harness (`scripts/dev/grokbot_cdp`). (#2204, #2225, #2230, #2231)
- `gate:csp-deploy` evaluates rendered Caddyfiles (docker/caddy); Railway template contract wired into the docs profile; env-template table covers platform recipe dirs. (#2297)
- Committed release manifest `releases/latest.json` with generate/drift scripts.

### Changed
- Gate policy: `local_gate.sh --profile docs` now runs `check_release_manifest.sh`, the oort day-2/doctor harnesses (per-file `bash -n` + shellcheck, fail-closed syntax loop), and the PITR contract test; `GATED_DOCS` covers the SELF_HOST family en/ko (11 → 16 documents); hardening locks anchor uncommented lines inside the docs arm. (#1984, #2124, #2456)
- Self-host generated env defaults `MOMO_HOSTED_DELIVERY_ENABLED=true` (D9); `--local-build` upgrade rebuilds instead of pulling (D10); `MOMO_BUILD_SHA` stamped into the web bundle (D2). (#2261, #2269, #2277)
- `oort doctor` outbox verdict carries info/age; T2 origin picker skips loopback/tauri origins. (#2270, #2347)
- Hosted wizard blank-name fallbacks: fact row shows the handle, one missing-name constant, regenerate launch seeds the raw name. (#2327)
- `hostedRoutineLabel` with an empty handle uses a shortened member id segment (ADR-0162 D6 amendment). (#2395)
- Worker lane: Grok Build CLI grok-4.6 (Cursor CLI fallback) — `docs/planning/PIPELINE.md`. (#2357)

### Fixed
- `test_pgbackrest_pitr_contract.sh` was red on Colima because the fixture lived under macOS `TMPDIR` (not bind-mountable); fixture moved under the worktree, attach diagnostics surfaced. (#2157)
- Claim success now records the four first-run markers so kickoff-hold → first-agent → phone-link runs after self-host claim. (#2301)
- S2/S1 onboarding: session-restore hold ordering after claim, first-run markers written before optional stages, reload re-entry, product-Korean error copy with next steps, long-name wrapping in the stale-name banner. (#2333, #2332)
- Hosted-agent opener no longer lands in an undeliverable outbox row (gateway rail + advisory lock). (#2334)
- Wizard step-4 approval sentence with an empty agent name (bare particle). (#2327)

### Docs
- Zero-base E2E-B deviations D1–D4: single claim-mode install path, `--compose` claim behaviour, gateway address rule (loopback http accepted, non-loopback http = plaintextRemote) with the local-mock recipe, skip disappears after issuing an invite. (#2429)
- Second measured zero-base run (`docs/planning/research/2026-09-10-e2e-zero-base-run.md`, 11/11 PASS on db5cb8e9); this release's images were re-measured from the published digests before tagging.
- `docs/SELF_HOST_FIRST_DAY(.ko).md` rewritten for the zero-base first run; ADR-0166 §6 and ADR-0181 D2/D3 amendment sections; UX bible P5 annotation. (#2336)
- `docs/SELF_HOST_AGENT.md` §3.3 Grok Bot VM corrections from the measured E2E-A run (Docker preflight/fallbacks, doorbell human approval point, sweep delay copy, HAP-E6 acknowledge evidence). (#2326)
- Research: E2E-A/E2E-B measured runs (`docs/planning/research/2026-09-09-e2e-{a,b}-*.md`), platform-neutral inventory, ADR-0184/0185.

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
- Governance/docs: ADR-0179~0182 accepted (motion/press/elevation/density axes, QR device link, welcome kickoff, ephemeral confirmation policy); `docs/planning/PIPELINE.md` single lane/model canon; `AGENTS.md` merged into `AGENTS.md`; canonical docs rotation.

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

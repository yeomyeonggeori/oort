# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

How a later server/image tag is cut: [`docs/RELEASING.md`](docs/RELEASING.md).
Desktop Tauri next (`0.1.0-next.N`) is a different train —
[`docs/NEXT_CHANNEL.md`](docs/NEXT_CHANNEL.md).

## [Unreleased]

Two database migrations since 0.1.17 (116-117): 116 adds the subscription-agent fields and device registration (ADR-0193 D14-D17); 117 adds `personal_provider_link` for personal API keys (FORCE row-level security). No data is dropped.

### Added
- Web, desktop and phone: an "AI" entry at the top of the sidebar with a hub overview, one shared vocabulary for agents, subscriptions and keys, and the old entry points linked to it (#3394, #3398).
- Server: agents now report their brain (team key, personal subscription, personal key), who can call them, their owner and whether their host is online; a subscription-agent registration endpoint. Claude subscription agents are off by default (`MOMO_CLAUDE_SUBSCRIPTION_AGENTS_ENABLED`) until Anthropic confirms the terms (#3401).
- Web and desktop: team AI keys in the AI hub (#3403), "My AI accounts" (#3404), and a single "sign in, then register" step for Claude Code on desktop that passes the value through `headersHelper` instead of the command line (#3419).
- Server: personal API keys. Only an operator issues them, only an owner-only agent resolves them, and there is no fallback to the team key (#3415).
- Research spikes for the personal cloud workspace (ADR-0197): Linux host key custody (#3417) and a blind PTY relay that only forwards ciphertext (#3418). Neither is turned on in a running service.

### Changed
- Phone: consecutive messages from the same person group tighter (6 pt) without a per-row time; the time is in the long-press sheet (#3387).

## [0.1.17] - 2026-10-03

GitHub Release: <https://github.com/yeomyeonggeori/oort/releases/tag/v0.1.17>. Tag target: `main=4d623fe1`. Multi-arch (linux/amd64 + linux/arm64), digest pins in `releases/latest.json`; SLSA v1 provenance verified for the app and postgres images. **v0.1.16 was published but never deployed**: its `momo-notifier` ran the share retention sweep with a role that had no privilege on `work_session_share` and looped on `permission denied` (#3377); 0.1.17 contains everything in 0.1.16 plus the fix (#3378). Five database migrations since 0.1.15 (111-115): the schema goes from 110 to 115 on the api pre-deploy. 111 adds `member_avatar_media` (member profile photos: own-write only, composite FK, FORCE row-level security). 112 adds the `drive_reclaimed_at` marker for avatar Drive reclaim (rows are kept). 113 adds `work_session.origin` (`host` or `local_pty`) and `folder_label`, plus a trigger that refuses work-control creation on a shared local session. 114 adds `work_session_share` (shared summary S1, FORCE row-level security) and widens the `tool` CHECK. 115 adds `work_session.turn_started_at` and `notification_rule.work_complete_push` (default true). No data is dropped. There is no new migration for the fix: the api pre-deploy re-applies `bootstrap_runtime_roles.sql`. Rolling the app image back to 0.1.15 keeps schema 115: 0.1.15 does not read the new columns or tables, so only the new features turn off.

### Added
- Server: team work sharing (ADR-0190 D4, ADR-0194). Sharing a "My work" terminal pane to a channel posts a card in the home channel; only repo, branch, harness, status, phase, diff counts, PR URL and last activity (S1) reach the server, never terminal text, input or commit titles. The server refuses every input, run, read and terminate control on a shared pane. A "Team work" board and a read-only session detail (web, desktop, phone "Work" tab) show the same data.
- Web, desktop and phone: sidebar and notification rework. The rail is workspace-only (collapse with Cmd+B to destination icons), destinations sit under "Search and go", the message-search row is removed, the inbox ("Needs you") and the activity log are separate with a single source for the count, ink/amber pills and session status chips, desktop dock badge and OS notification kinds, opt-in browser notifications on web, and a phone tab badge.
- Server: "work finished" push (ADR-0120 appendix A). Sent only for a session you started, after a turn of 60 seconds or more, and only when you are not looking; it can be switched off in Settings.
- Server, web, desktop and phone: profile photos (ADR-0161 amendment). Upload, replace and delete in Settings; 4096 px and 5 MiB limits, 20 uploads per hour.
- Desktop: "My work" new-session start location (recent, folder, home; worktree off by default, ADR-0190 amendment D3-c), "Needs reply", lighter pane chrome, shortcut settings with rebinding and conflict detection, and a Cmd+K "collapse the explorer" command.

### Fixed
- Server: the notifier share retention sweep (30-day cleanup of shared summaries) now deletes through the `momo_app` (row-level security) pool instead of the BYPASSRLS notifier role; the delete URL is `MOMO_SHARE_RETENTION_DATABASE_URL`, falling back to `MOMO_HUDDLE_SWEEP_DATABASE_URL` (#3377, #3378).
- Server: minimal column-level SELECT grants for `momo_notifier` on `work_session_share`, avatar media, `workspace.avatar_media_id`, `huddle` and `huddle_participant`; every notifier loop backs off exponentially (up to 5 minutes) after consecutive failures; a conformance test runs the notifier jobs with the production role.

### Not in this release
- Desktop and phone app changes ship with the desktop DMG and iOS builds, not the image.
- The Drive reclaim job only runs on the Google Drive backend; oort-team uses the local backend (#3312).
- `oort://work` deep link (#2865), agent approval owner assignment (#3336), wider agent delegation settings (#3356).

## [0.1.15] - 2026-10-01

GitHub Release: <https://github.com/yeomyeonggeori/oort/releases/tag/v0.1.15>. Tag target: `main=a6e5cd1b`. Multi-arch (linux/amd64 + linux/arm64), digest pins in `releases/latest.json`; SLSA v1 provenance verified for the app and postgres images. Thirteen database migrations since 0.1.14 (098–110): the schema goes from 097 to 110 on the api pre-deploy. 098 adds `agent.model_source` (backfill: `hermes-agent` models read `instance_default`). **099 drops the legacy memory plane** (ADR-0129: the eight tables `memory_item`, `memory_source_ref`, `memory_visibility_grant`, `memory_lifecycle_event`, `memory_candidate`, `memory_extraction_cursor`, `workspace_memory_policy`, `context_packet`, their functions, and three `workspace.memory_external_provider_consent*` columns); it has no consumers and the data loss is intended (ADR-0196 D11); the `vector` extension stays. 100–110 add the team memory v2 `mem_*` tables, definer functions and the `mem_definer` and `momo_memory` roles; every new table has FORCE row-level security, writes go through definer functions only, and `message` gets one RESTRICTIVE lock-down policy. Rolling the app image back to 0.1.14 keeps schema 110: 0.1.14 does not read `mem_*`, but the tables 099 dropped do not come back (0.1.14 does not use them either).

### Added
- Server: team memory v2 (ADR-0196, supersedes ADR-0129). Channel and thread summaries with daily and weekly roll-ups are written through the team "Default AI" summary row; without a row the worker makes no model call and fails honestly (`not_configured`), with a daily per-workspace token cap. Decisions, facts and commitments are extracted in the same call and only appended; they are visible only to people who can read every source message (RLS), and person-to-person DMs are never summarized.
- Server: agent replies carry summaries and items as reference material and leave a receipt, filtered by the reply channel (a 1:1 DM uses the union of the requester's permissions). "Remember this" proposals become memory only when a person accepts (not guests).
- Server: a memory browser API (list, search, detail, sources, history, edit, forget). Forgetting is an immediate permanent delete and the same content is not extracted again. A nightly job merges duplicates, closes decision windows, decays, deletes by retention and groups topics; it never changes what a person confirmed, and its changes can be undone.
- Server: local embeddings (multilingual-e5-small int8) so rephrased queries still find memory; memory text never leaves the instance. With less than 1.5 GiB of worker memory only embeddings switch off and search falls back to keywords. Workspace admins can reset memory, and a team notice says what goes to which provider.
- Web and desktop: a "what you missed" summary card, a "N memories used" chip and inspector, proposal cards, the memory browser (`/memory`), a decision timeline with undo, and Settings › Memory (switch, team notice, reset).

### Changed
- Server: control v1 is retired and resume-agent checks compare hosts (#3183); the model-source contract (#3176); the session permission card shows auto-allow (#3181); remote work account wiring (#3180).

### Not in this release
- Phone screens (summary card, chip, proposal card) ship with the iOS build, not the image.
- runtime-unverified: real summary model calls and nightly consolidation quality, embedding memory and latency on x86, on-device rendering.
- Follow-ups: #3189, #3201, #3211, #3225, #3234, #3236, #3243.

## [0.1.14] - 2026-09-29

GitHub Release: <https://github.com/yeomyeonggeori/oort/releases/tag/v0.1.14>. Tag target: `main=41d91d68`. Multi-arch (linux/amd64 + linux/arm64), digest pins in `releases/latest.json`; SLSA v1 provenance verified for the app and postgres images. Six database migrations since 0.1.13 (092–097): the schema goes from 091 to 097 on the api pre-deploy. They add six tables (`work_permission_request`, `provider_default_ai`, `member_device_key`, `human_control_nonce`, `session_refresh_key`, `refresh_proof_nonce`), each with FORCE row-level security and one policy, nullable signature columns on `work_control`, and `action_signature.alg` (existing rows read `ed25519`); there is no data backfill. Rolling the app image back to 0.1.13 keeps schema 097: 0.1.13 does not read the new tables or columns, its writes satisfy the rewritten checks, and its migrate runner skips the six ledger rows it does not know.

### Added
- Server: the owner decides a work session's permission requests. A member host relays an ACP permission request as a `work_permission_request` row; `POST …/work-sessions/{session}/permission-decisions` lets the session owner pick allow-once or reject-once exactly once, and the decision travels to the host as a `permission` control in the same transaction. The host's closed preview of the request is stored with its SHA-256, served only to the owner at `GET …/permission-requests/{request}`, and only its hash is broadcast. (#3000, #3118, ADR-0188 D5)
- Web and desktop: the work tab's A pane shows ACP plan and tool-call cards and a permission card wired to the decision route. (#2779, #3013)
- Server: "Default AI" team rows. `GET/PUT /v1/provider/default-ai` (operator only) store which team link position and model id answer for team agents and for channel summaries; the row holds no key material and a personal subscription can never be a team row. "Check connection" now returns the provider's model ids. (#3009, ADR-0147 amendment 2026-09-28)
- Web and desktop: Settings › AI connections has a "Default AI" table by function, separating personal rows (kept on this device) from the operator's team rows (saved on the server), with a fallback sentence per row; a new local terminal session follows the personal default. (#2881, #3042, #3010)
- Server: a person's device signing keys (ADR-0146 amendment 2026-09-28, R2). `…/device-keys` registers, lists, endorses and revokes P-256 keys bound to the sign-in lineage; ending a lineage revokes its keys. Signed human instructions (`momo.human.control.v1`–`v3`) are verified with a one-time nonce and kept as provenance, and `…/device-keys/signing-context` gives clients the instance id. Requiring signatures stays off: `MOMO_HUMAN_CONTROL_SIGNATURE_REQUIRED` and `MOMO_HOST_REGISTER_SIGNATURE_REQUIRED` default to false, and without `MOMO_INSTANCE_ID` the signing context answers 503 `instance_id_unconfigured`. (#3021, #3022, #3023, #3027, #3068, #3097, #3118, #3119)
- Server: refresh tokens can be sender-constrained. A native client binds a separate refresh key to its lineage and proves it on each refresh; a proven re-presentation of a spent token recovers the lineage instead of logging out. `MOMO_REFRESH_PROOF_MODE` defaults to `observe`, where an unproven refresh behaves as before. (#3079)
- Web: a browser tab says an instruction or an allow needs the phone or desktop app, and signature errors read by reason. (#3029)

### Changed
- Security: re-presenting a spent refresh token more than 30 seconds after it was used ends the whole lineage for QR-linked (phone) sessions; password sign-ins keep the previous behavior unless `MOMO_REFRESH_REUSE_SWEEP_ALL_SESSIONS=true`. A re-presentation inside the grace window gets the same pair again. (#3022, #3074)
- Web: refresh-token rotation is coordinated across tabs and windows with a lock, a re-read and storage propagation, so a late tab no longer spends an earlier tab's token. (#3067)
- Server: a chain hop's stored key is bound to its origin — changing the origin without a new key is 409. Notification rules accept a partial `PATCH`. (#3040, #3012)
- Server: the provider egress guard moved into the `momo-egress` crate, and the worker's DNS precheck is bounded; the b26_1 usage summary window uses the database clock. (#2976, #2950)

### Fixed
- Server: one lock order for session rows, so linking a QR device no longer deadlocks against a lineage revocation. (#3107)
- Server image: the web stage copies the `docs/api` contract JSON (goldens and signing vectors) that web tests import, with a guard for any other out-of-tree import. (#3037, #3123)
- Web and desktop: open work surfaces keep a grace period when the host drops, the phone re-reads notification rules right before writing, and Settings screens were tidied. (#2893, #3064)

### Not in this release
- The server image carries the permission bridge, default AI rows, device-key and signed-instruction routes, refresh proofs (api) and the web bundle's permission cards, default AI table and browser guidance. The Secure Enclave keys, Touch ID/Face ID signing, the `momo-workd` root pinning and signature ratchet, refresh proofs from native clients and background refresh completion ship in desktop and iOS builds (#3025, #3026, #3028, #3063, #3076, #3078, #3084, #3088, #3098, #3103, #3106, #3117), not in the image. No desktop or iOS build is part of this release.
- Signature requirements are not switched on for `oort-team`; `MOMO_INSTANCE_ID` is not set there yet.
- runtime-unverified: signed instructions and permission decisions from a real phone or Mac against the team instance, a real refresh proof, and default AI rows answering through a real provider.

## [0.1.13] - 2026-09-27

GitHub Release: <https://github.com/yeomyeonggeori/oort/releases/tag/v0.1.13>. Tag target: `main=168ee323`. Multi-arch (linux/amd64 + linux/arm64), digest pins in `releases/latest.json`; SLSA v1 provenance verified for the app and postgres images. No database migration since 0.1.12: the schema stays at 091 and upgrading swaps the images only, so rolling back to 0.1.12 needs no schema change.

### Added
- Server: "Check connection" calls the provider. `POST /v1/provider/link/test` sends one read-only GET per enabled hop (`/models`, or `/key` for OpenRouter) through the provider egress guard, and reports `ok`, `rejected`, `unreachable`, `rate_limited` or `unknown` with only the numbers the provider disclosed (model count, rate limits, OpenRouter credit). Response bodies and keys never leave the new `momo-provider-probe` crate. A checking operator gets 429 with `Retry-After` past six checks a minute, and a re-check of the same link within 20 seconds reuses the last result. (#2972, ADR-0147 amendment 2026-09-27)
- Server: agents can suggest the AI connection card. A hosted agent calls `oort_card_suggest` and a team agent calls `card_suggest`; the card is one message for the person who asked, with no approval, no run transition and no new table. New team agents get `card_suggest` in their profile by default, with a directive to suggest the card when someone asks to connect; an explicit tool list, including an empty one, is kept, and existing agents are unchanged. (#2959, #2985, ADR-0186 amendment 2026-09-27)
- Web and desktop: `/연결` in the composer and ⌘K "Open AI connection card" open a card at the end of the channel that only you see — subscription sign-in, the team key and a connection check. Text that looks like a key is not sent and not kept as a draft. An agent's suggested card renders for the person it is for; an operator sees one line with "View team connection", other members see one line. (#2957, #2961, #2977)
- Web and desktop: Settings › AI connections' team connection uses the same key form as the card, shows the result of "Save and check", and before "Disconnect" names the team agents that answer with that key. The check result gives a reason and what to do for each server reason, and a line of provider numbers. (#2971, #2984)
- Web and desktop: the work tab — "My work" (desktop) and "Team work" in the sidebar, the terminal grid across the whole route with a session list panel, and pane states (running, waiting for me, done) that reach the inbox and OS notifications. (#2927, #2951, #2958)
- Server, web and desktop: this Mac can be registered as a code-execution host from Settings; registering or revoking a host notifies the owner's devices in the same transaction. (#2954, ADR-0188)

### Changed
- `POST …/agents` without `enabledTools` now writes `["card_suggest"]` to the new agent's profile; OpenAPI `AgentProfileInput` requires only `instructions`. (#2985)

### Fixed
- Security: a subscription (owner-only) agent without a hosted connection row no longer runs on the team key — a mention, work request or welcome ends in the "the connection is down" line, and the worker refuses owner-only runs before calling a model. (#2940)
- Security: agent-to-agent calls refuse owner-only agents twice over, a turn without a key never calls a model, display names in refusal lines stay inert, and the server refuses creating a new provider link from `auth.json`. (#2922: #2897, #2900, #2911)
- Web and desktop: Settings › AI connections "My account · this Mac" shows the local CLI status, focus rings no longer appear after mouse use and a modifier key, and returning from the AI connection screen no longer loops. (#2953)

### Not in this release
- The server image carries the connection check, card suggestion tools, directive and default profile, owner-only isolation and host register/revoke notices (api, agent-worker), and the web bundle's connection card, suggested-card rendering, team connection settings and work tab. The desktop local git read (#2925) and `momo-workd` sidecar (#2954) ship in desktop builds, and the phone `/연결` card (#2987) in iOS builds, not in the image.
- LiveKit on the team instance (#2759): huddles still do not run on `oort-team`.
- runtime-unverified: a connection check against the real provider APIs (mock shapes only), a live agent runtime suggesting the card (mock-provider E2E only), TestFlight install.

## [0.1.12] - 2026-09-27

GitHub Release: <https://github.com/yeomyeonggeori/oort/releases/tag/v0.1.12>. Tag target: `main=6373ff48`. Multi-arch (linux/amd64 + linux/arm64), digest pins in `releases/latest.json`; SLSA v1 provenance verified for the app and postgres images. Two database migrations since 0.1.11: `090_notification_rule_dnd_until.sql` adds nullable deadline and "value before do-not-disturb" columns to `notification_rule` and `member.presence_dnd_until` (existing rows stay NULL, so nothing changes until someone sets a deadline); `091_hosted_dm_approval.sql` adds `hosted_agent_connection.approved_dm_channel_ids` (default empty, under the table's existing FORCE RLS policy) and the `hosted_connection_channel_ids` function (SECURITY INVOKER, fixed search_path). Both are forward-only and additive; rolling the images back to 0.1.11 leaves them in place, and 0.1.11 can still clear do-not-disturb and notification pause because 090 has no deadline CHECK.

### Added
- Server: notification pause can carry a deadline, and do-not-disturb and notification pause move together — turning do-not-disturb on also pauses notifications in the same transaction, and turning it off restores what was there before. The deadline is compared when a push is decided, and the roster carries an active deadline (`dndUntilMs`). The deadline picker UI is a follow-up (#2899). (#2850, #2901, ADR-0124 amendment 2)
- Server: a hosted agent's 1:1 DM opens. The DM between an agent's owner and that agent opens automatically, but only on a connection the owner confirmed or consented to; another member's DM with the agent opens only when the owner approves that DM. A subscription agent answers only its owner's DM, and group DMs stay closed. If an admin who is not the owner confirms the connection, its DMs close and the other-member approvals are cleared. (#2915, ADR-0162 amendment 2)
- Web and desktop: Settings › agent credentials lists the agent's 1:1 conversations — the owner's is always open, only the owner can open or close another member's (with one more confirmation), and admins see it read-only. (#2915)
- Web, desktop and phone: the DM composer hint follows the server's delivery state; "talk to it directly" appears only in a DM that is open to the agent. (#2915, #2891)

### Not in this release
- The server image carries the do-not-disturb deadline and bundle (api, notifier, migration 090), hosted 1:1 DM delivery and approval (api, agent-worker, migration 091) and the web bundle's 1:1 conversation list and DM hint. The phone hint ships in iOS builds, not in the image.
- Personal-subscription isolation hardening, inert display names in more refusal lines and refusing new `auth.json` provider links on the server (#2922: #2897, #2900, #2911) landed after the build commit and ship in a later release.
- The do-not-disturb deadline picker (#2899) and LiveKit on the team instance (#2759): huddles still do not run on `oort-team`.
- runtime-unverified: an owner-approved hosted DM against a live agent runtime on a team instance, a do-not-disturb deadline expiring on a real phone push, TestFlight install.

## [0.1.11] - 2026-09-27

GitHub Release: <https://github.com/yeomyeonggeori/oort/releases/tag/v0.1.11>. Tag target: `main=21aead09`. Multi-arch (linux/amd64 + linux/arm64), digest pins in `releases/latest.json`; SLSA v1 provenance verified for the app and postgres images. No database migration since 0.1.10: the schema stays at 089 and upgrading swaps the images only.

### Added
- Server: provider links speak the Anthropic Messages wire, so a Claude API key can run a team agent. Presets for OpenAI, Anthropic, xAI (Grok) and OpenRouter; keys are scrubbed from errors, logs and debug output. (#2872, ADR-0147, ADR-0004)
- Server: when a hosted agent cannot answer — hosted delivery off, link disconnected, channel not approved, or a 1:1 DM — the person who called it gets one line with the reason and the way to fix it (10-minute cooldown). An agent's display name can no longer inject a markdown link. (#2871)
- Web and desktop: Settings › AI connections is reorganised into "My account · this Mac" and "Team connections · this server", with a side panel; pasting an `auth.json` no longer creates a new connection. AI connections can be reopened from settings and the agent screen, and subscription agents are on by default in builds. (#2877, #2870)
- Desktop: Claude Code and Codex sign in through a modal that runs the official CLI in a hidden PTY. (#2816)
- Phone: the profile shows presence, a status message and notification pause. (#2848)

### Changed
- Security: provider egress refuses private, loopback, link-local and metadata targets even over https — when a link is saved, and again at connect time against the resolved addresses (DNS rebinding) — and does not follow redirects. The OAuth token refresh path goes through the same guard. A deployment that used a private-range https host as a provider must set `AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK=1` and list the host in `AGENT_PROVIDER_LOCAL_HOSTS`; the guarded client ignores `HTTP(S)_PROXY`. (#2852, #2894)
- Web: the work surface opens only while a host is online. (#2780)
- Web and phone: notification pause wording is the same everywhere. (#2848)
- Desktop: the terminal defaults to a dark theme. (#2849)
- Server: a test pins that the team agent path never reaches a person's own subscription credentials. (#2882)

### Not in this release
- The server image carries the Anthropic wire and presets, the provider egress guard and the "why the agent did not answer" notice (api, agent-worker), and the web bundle's AI connections settings and work-surface gate. The CLI sign-in modal and terminal theme ship in desktop builds and the phone profile in iOS builds, not in the image.
- Do-not-disturb deadlines and the notification pause bundle (#2850, migration 090) landed after the build commit and ship in a later release.
- Approving a hosted agent in a 1:1 DM (#2915) is in progress.
- LiveKit on the team instance (#2759): huddles still do not run on `oort-team`.
- runtime-unverified: an Anthropic-wire team agent against the live API on a team instance, the CLI sign-in modal in a signed DMG, TestFlight install.

## [0.1.10] - 2026-09-26

GitHub Release: <https://github.com/yeomyeonggeori/oort/releases/tag/v0.1.10>. Tag target: `main=824b909e`. Multi-arch (linux/amd64 + linux/arm64), digest pins in `releases/latest.json`; SLSA v1 provenance verified for the app and postgres images. One database migration since 0.1.9: `089_agent_invocation_scope.sql` adds `agent.invocation_scope` (default `workspace`, so every existing agent keeps its behaviour) and `agent.subscription_harness`, their CHECK constraints, and a trigger that refuses to reopen an owner-only agent. It is forward-only; rolling the images back to 0.1.9 leaves the added columns in place.

### Added
- Server: an agent that joins through a personal subscription (Claude Code or Codex on the owner's Mac) answers only its owner. The server enforces it on every delivery path; anyone else, or the owner while their Mac is offline, gets one short notice from the agent. `MOMO_SUBSCRIPTION_AGENTS_ENABLED=false` turns the subscription path off (unset means on). (#2830, ADR-0193)
- Huddles: the notifier sweeps ghost participants by comparing each active huddle with the LiveKit room. It runs only when LiveKit is configured and `MOMO_HUDDLE_SWEEP_DATABASE_URL` points at the RLS-bound app role. (#2802)
- Web and desktop: onboarding 2.0 — the Kometto guide and progress dots, one welcome step, sign-in and invite acceptance on one screen each, the claim screen on the new frame, 「Whose AI should think?」 AI connection, and a first-conversation band with the phone-link card in the channel instead of a full-screen step. (#2828, #2831, #2832, #2835, #2836, #2829)
- Web and desktop: design system 2.0 — dawn-sky tokens from one core source with a contrast test over every combination, filled pills, round icons, cards and glass, and the desktop shell's gradient floor with a floating content pane. (#2735, #2738, #2740)
- Desktop: a local terminal — split-grid layout per session, xterm panes over a Tauri PTY, the ⌃` dock and a shortcut table; local harness detection for `claude` and `codex`. (#2801, #2824, #2838, #2827)
- Phone: the design system 2.0 shell, home and conversation screens, with a centred pill tab bar and a light + menu. (#2739, #2742, #2800, #2825)

### Changed
- Brand: the C2-04 Bubble mark is the canonical SVG on web, desktop and phone (#2731), and the app icon is the I4 front close-up of Kometto on iOS, macOS Dock and the web app. (#2733, #2797)
- Phone: the welcome screen is split from the sign-in form, and the notification permission is asked only after a one-button explanation. (#2833)

### Fixed
- Huddles: a connected huddle is no longer cut off when its join token's lifetime ends. (#2798)
- Web: the header menu's Escape handling no longer races, and the shell, channel-header and composer gates run again. (#2746)
- Web: the terminal dock folds away where the work surface does not apply, with surface-neutral copy and an explained empty state. (#2795)
- Desktop: huddles ask for the microphone in the signed DMG (usage description and audio-input entitlement). (#2804)
- Phone: realtime waits a grace period before showing "reconnecting", reconnects at once on foreground, and replaces an expired token before connecting. (#2755)

### Not in this release
- The server image carries the owner-only invocation (api and migration 089), the huddle ghost sweep (notifier) and the web bundle (onboarding 2.0, design system 2.0, terminal dock). The phone entries ship in iOS builds and the desktop shell (PTY, harness detection, microphone entitlement) in desktop builds, not in the image.
- LiveKit on the team instance (#2759): huddles still do not run on `oort-team`, so the ghost sweep stays off there.
- runtime-unverified: owner-only invocation against a real subscription agent on a team instance, the ghost sweep against a live LiveKit room, TestFlight install.

## [0.1.9] - 2026-09-26

GitHub Release: <https://github.com/yeomyeonggeori/oort/releases/tag/v0.1.9>. Tag target: `main=eb09f568`. Multi-arch (linux/amd64 + linux/arm64), digest pins in `releases/latest.json`; SLSA v1 provenance verified for the app and postgres images. One database migration since 0.1.8: `088_push_session_lineage.sql` adds two nullable columns and one partial index, and invalidates every live push registration made before it (a phone that is still signed in registers again on its next launch). It is forward-only; rolling the images back to 0.1.8 leaves the added columns in place.

### Added
- Web and desktop: attachments show an image thumbnail in the send tray before sending, images in the timeline open in a lightbox, and a PDF opens in a new window on web and in the default app on desktop. (#2710)
- Phone: the top avatar opens a profile sheet with theme, notifications and sign-out; the block at the bottom of the screen is gone. (#2722)

### Fixed
- Push: signing out or revoking a session invalidates that device's push registration, so a signed-out phone no longer receives the next person's alerts or badge count. The server ties each registration to its sign-in session (migration 088). (#2685)
- Phone: signing out deletes this phone's push registration and cannot race a token refresh. (#2692)
- Desktop: the window's traffic-light buttons and the panel collapse button sit on the same line. (#2708)
- Phone: on the connect screen the focused field and the sign-in button stay above the keyboard. (#2694)
- Phone: following a conversation settles at the end even after a long new row or rows not yet measured. (#2697)

### Not in this release
- The server image carries the push-registration lineage (api and migration 088) and the web bundle's attachment previews and desktop title-bar alignment. The phone entries ship in iOS builds and the desktop shell in desktop builds, not in the image.
- The C2-04 brand mark (#2731) and design system 2.0 (ADR-0189, #2721) landed after the build commit and ship in a later release.
- runtime-unverified: real-device push after sign-out and re-registration on the next phone launch, TestFlight install.

## [0.1.8] - 2026-09-25

GitHub Release: <https://github.com/yeomyeonggeori/oort/releases/tag/v0.1.8>. Tag target: `main=088da65b`. Multi-arch (linux/amd64 + linux/arm64), digest pins in `releases/latest.json`; SLSA v1 provenance verified for the app and postgres images. No database migration since 0.1.7: upgrading swaps the images only.

### Added
- Push notifications play the default sound for messages, mentions, approvals and work alerts. (#2672)
- Desktop: the top of the window drags the window, and files can be dropped into the app. (#2674)

### Fixed
- Phone: a long conversation no longer leaves the whole list blank. (#2654)
- Phone: opening a team room settles at the end instead of stopping short. (#2680)
- Phone: push-tap landing — a message is only called missing after the tail is re-read, and one already held lands at once. (#2645)
- Phone: the first subscription backfill starts after the head page instead of reading the room's whole history (a 3,000-row room: 62 reads → 2). (#2649)
- Phone: the launch screen shows only the boot background, without template text. (#2673)
- Phone: the app badge follows the unread total and clears with it. (#2675)
- Desktop: the OS notification permission check no longer errors — the capability grants the notification commands it needs. (#2683)

### Not in this release
- The server image carries the push sound (push-relay) and the web bundle's desktop drop guard. The phone entries ship in iOS builds and the desktop entries in desktop builds, not in the image.
- Dropping a device's push registration on logout or session revoke (#2685, #2692) landed after the build commit and ships in the next release.
- runtime-unverified: real-device APNs sound and badge, TestFlight install (M7-I evidence build).

## [0.1.7] - 2026-09-24

GitHub Release: <https://github.com/yeomyeonggeori/oort/releases/tag/v0.1.7>. Tag target: `main=1dd9ceea`. Multi-arch (linux/amd64 + linux/arm64), digest pins in `releases/latest.json`; SLSA v1 provenance verified for the app and postgres images. No database migration since 0.1.6: upgrading swaps the images only.

### Added
- Phone: approve or reject an approval card right in the timeline, and a result card after the decision; a one-time invite link is shown once and never stored. (#2585)
- Phone: unread badge and divider follow the same computed state as web; opening a conversation clears a desktop "mark unread" only after it has been drawn. (#2593)
- Phone: "jump to unread" and "jump to latest" pills with web copy, VoiceOver focus on landing, and a scroll machine that settles on movement instead of a clock. (#2594, #2614, #2622)
- Phone: tapping a push notification opens the message, thread reply or approval it points to and lands on it — also after a cold start or from the background; when that conversation is already open, the tail is re-read first so the screen never says a message is missing before it has arrived. (#2584)
- Railway team-instance template (T2): nine-service catalog, start commands that drop root, sealed APNs key handling, Centrifugo literals pinned to `infra/centrifugo.json`, a client-IP measurement gate before any claim link or invite is shared, and the local-storage upload route (`/__momo_stub/*`) on the Railway edge. (#2580, #2606)
- `momo-workd` skeleton for ADR-0188 remote work: dial-out registration, signed v2 heartbeat, control polling, ACP sessions under D6 isolation (not distributed yet). (#2579)
- Phone browser onboarding: inputs no longer trigger iOS focus zoom (16px floor on touch and narrow screens), no sideways drag during step transitions, and "지금은 건너뛰기" sits at the top of the agent step. (#2620)
- iOS TestFlight preparation: privacy usage strings, export-compliance flag, build-number scheme, a release archive script that refuses non-`main` commits, and the TestFlight runbook. (#2587)

### Fixed
- Self-hosted public origin (T1): attachment uploads work — the edge now routes `/__momo_stub/*` to the api (it answered 405 before), and every edge Caddyfile is checked for the same route. (#2625)
- iOS: the app ships an app icon — App Store Connect refused the first TestFlight upload without one, and the post-build check now fails an exported app that lacks it. The single opaque 1024 px icon is a placeholder until store submission. (#2646)

### Security
- Local-storage upload URLs are one-time and expire after an hour; a published attachment can no longer be overwritten by replaying its upload URL. (#2624)
- Local-storage upload PUT (`/__momo_stub/drive/uploads/{token}`): the token, session, size and type are judged before the body is read, and the body streams to disk — four concurrent anonymous 100 MiB PUTs now move server memory by +0.4 MiB instead of +1.2 GiB. A per-IP limit, `RATE_LIMIT_DRIVE_UPLOAD_PER_IP` (default 120 per minute), counts only refused capabilities, so a live upload URL is never throttled; an address over budget gets 429 on this route. A chunked body that runs past the declared size is now 400 (it used to be buffered up to 100 MiB, then 413). On boot the api clears unfinished upload sessions and partial files, so restoring a drive-volume snapshot cannot revive a live upload URL. (#2631)
- ADR-0188 R0: remote-host defences — the host owner decides, agents may only kill on member hosts, remote auto-approve and remote shell are refused, heartbeat v2. (#2576)
- ADR-0188 R0.1 + (A′): non-admins cannot register workspace-scoped hosts, app hosts are member-scoped only, member hosts receive only the owner's non-shell controls and everyone's kill, and agent-originated non-kill controls to member hosts are refused at decision, tool-request and executor time. (#2597)
- ADR-0188 R1.1: `momo-workd` hardening — credential redaction in outgoing events, Claude reads fenced to the working folder, owner-only spawn on member hosts, request-recorder proof that the host key never leaves the machine. (#2605)
- ADR-0188 R1.2: remote Codex runs sandboxed in a host-owned home — it never reads the owner's `~/.codex`, starts with no MCP servers and with 13 out-of-sandbox features turned off, and needs a one-time `codex login` into that home. A Claude session that does not start in the fixed permission mode is corrected before its first prompt, and refused if the agent does not confirm it. (#2621)
- ADR-0188 R1.3: remote agents receive only an allowlist of host environment variables (`PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TERM`, `TMPDIR`, `LANG`, `LC_*`), so API keys, proxy and CA settings in the host environment no longer reach them and they run on their logins only; remote Codex commands skip the owner's zsh start-up files, and the Codex process runs with a host-owned `HOME`, so the owner's skills layer is not loaded. (#2644)

### Not in this release
- The server image carries the server and web entries above. The phone entries ship in iOS builds, not in the image. `momo-workd` is in the source tree but not distributed, and remote work is not opened to the phone yet (rest of ADR-0188 R1; R1.4 is #2647).
- runtime-unverified: real-device APNs, TestFlight install and push-tap landing on a device (M7-I evidence build in progress).
- Known phone defects: a long first page with thread or approval rows can leave the list blank (#2586, fix in review in #2654), and a message sent from far up a long conversation can land out of view (#2658).

## [0.1.6] - 2026-09-23

GitHub Release: <https://github.com/yeomyeonggeori/oort/releases/tag/v0.1.6>. Tag target: `main=ab58a111`. Multi-arch (linux/amd64 + linux/arm64), digest pins in `releases/latest.json`; SLSA v1 provenance verified for the app and postgres images.

### Added
- Agent workspace actions (ADR-0186): the agent proposes, a human approves, the server executes. Agent Port tool `oort_action_propose`, `GET /v1/workspaces/{ws}/actions`, v1 action `invite.create` (admin approval); the one-time invite link travels only in the decision response, with `Cache-Control: no-store`. (#2508, #2509)
- Web: command registry and ⌘K command groups (#2524); action card catalog v1 — action row, `action_result`, one-time link (#2540).
- Linked devices list and revoke: `GET/DELETE /v1/auth/devices` (ADR-0180 D5) and web settings › 기기. (#2468, #2490)

### Changed
- Webhook master keys are split from `JWT_HMAC`: `WEBHOOK_INGRESS_MASTER_KEY` and `OUTBOUND_WEBHOOK_MASTER_KEY`, with an audit on the ingress budget (ADR-0004 amendment 4). **Upgrading:** both keys must be in the env or webhook-sender refuses to boot; run the generator with the current `JWT_HMAC` exported and it copies that value into both keys, so issued webhook and doorbell secrets survive. (#2523)
- Overlay layer order (scrim, surface, transient confirmation). (#2485)

### Security
- Refresh and revoke of a linked device are serialized. (#2537)
- PostgreSQL image: libssh2 `1.11.1-1+deb13u2` (CVE-2026-66032, CVE-2026-66033, CVE-2026-66034, CVE-2026-66035, CVE-2026-58050, CVE-2026-58051); package URLs moved to the permanent archives (snapshot.debian.org, apt-archive.postgresql.org). (#2573)

### Docs
- Goal A (ADR-0187): deploy gate grades M7-I/M7-S, bundle promotion, `STATUS.md` frozen. (#2566)
- Phone remote work design ADR-0188 Accepted. (#2575)

### Not in this release
- ADR-0188 R0 (remote-host defence, #2576) is on `track/engine`, not in this image.
- runtime-unverified: published-image E2E re-measure, the Railway team instance deploy and real-device APNs (#2205).
- The phone's empty list on long conversations (#2586) is a client defect outside this release.

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

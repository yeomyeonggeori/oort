---
title: Security
description: Where your data lives, how workspaces are kept apart and how secrets are handled. Only what is safe to publish is here.
status: done
checked: 2026-11-09
sources:
- README.md
- SECURITY.md
- docs/security/README.ko.md
- docs/architecture/overview.md
- server/Migrations/001_init.sql
- server-rust/crates/momo-db/src/tenant.rs
- infra/rust/sql/bootstrap_runtime_roles.sql
- server-rust/crates/momo-settings/src/crypto.rs
- server-rust/bins/momo-server/src/routes/agent_credentials.rs
- server-rust/crates/momo-webhook/src/crypto.rs
- server-rust/bins/momo-server/src/config.rs
- server-rust/crates/momo-push/src/dispatch.rs
- docs/adr/0004-codex-oauth-hermes-provider-boundary.md
- docs/adr/0120-push-notification-boundary.md
---

## The source of truth is your server

Messages, approvals, run state and the audit log live in the PostgreSQL database on your server. Data leaves only for places you choose.

| Outside service | What it receives |
|---|---|
| The AI backend you pick | The conversation context the work needs |
| A Google shared drive (only if you pick it) | Files |
| The push relay (only if you use it) | Ids and routing data only. Never message bodies, prompts, approval details or attachments |

Without the push relay you lose push notifications, and everything else in oort keeps working.

## Workspaces are kept apart

Tables that hold workspace data have PostgreSQL row-level security (RLS) turned on with both `ENABLE` and `FORCE`. The server sets the workspace id for each transaction, and the policies let it read and write only that workspace's rows. The database enforces this itself, not just conditions in the application code.

The API server connects as a role that cannot skip RLS (`momo_app`). The only roles that skip it are three for background work that has to sweep across workspaces: the relay, the agent worker and the notification sender.

## Handling secrets

- AI keys and Hermes keys are stored only as AES-256-GCM ciphertext, and the screen shows at most their last four characters.
- ChatGPT and Claude subscription logins are kept by Hermes in its own storage. oort does not create new subscription login links.
- Agent tokens are shown once, when issued, and the server keeps only a hash.
- The token in a Slack-compatible webhook address is also stored only as a hash.
- The server will not start if two root keys share a value. For example, the master key that seals AI keys must differ from the JWT secret and the webhook master key.

## Good to know

- oort is not end-to-end encrypted. The server, and whoever runs it, can read message content, because search and agents need it.
- oort has not had a third-party security audit or certification.
- If you find a security problem, report it as [`SECURITY.md`](https://github.com/yeomyeonggeori/oort/blob/main/SECURITY.md) describes, not in a public issue.

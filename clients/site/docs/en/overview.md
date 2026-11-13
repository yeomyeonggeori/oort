---
title: Overview
description: What oort is, what works today, and how to read the status marks in these docs.
status: done
checked: 2026-11-09
sources:
- README.md
- docs/architecture/overview.md
- docs/adr/0187-goal-a-team-daily-desktop-ios.md
- schema_v0.sql
- server-rust/bins/momo-server/src/routes/approvals.rs
- clients/site/values.json
---

oort is a team messenger you run on your own server. People and AI agents work side by side in the same channels. An agent is not a bot bolted on from outside: it is a member of the workspace, on the same roster as everyone else, and it sends messages through the same API.

## What makes it different

- When you call an agent, its work shows up right in the channel, and you can stop it partway.
- Anything that needs permission arrives in the conversation as an approval card. A person approves or declines it right there, and the decision stays in the conversation. Only people can approve.
- Messages, approvals, run state and the audit log live in the PostgreSQL database on your server.
- You choose the AI: an API key, a Hermes runtime on the same server, or an OpenAI-compatible backend. oort is not the AI provider; it hands out the work and keeps the record.

## What works today

- Channels, threads, DMs, reactions, emoticons and search, on the web, the Mac app and the iPhone app.
- The app speaks Korean and English. Some screens are still Korean only.
- The Mac and iPhone apps are still test builds for our own team. There is no public download or public hosted service yet.

## Reading the status marks

Every page starts with its status, the date it was checked, and its sources. A mark next to a heading covers only that part.

| Mark | Meaning |
|---|---|
| {done} | You can use it now |
| {partial} | Only part of it works, or it has not been checked end to end with a real client |
| {planned} | Not built yet |

Sources are file paths in this repository. Where the code and the docs disagree, these pages follow the code.

## Where to go next

- [Concepts](/docs/en/concepts/): how members, channels, agents and approvals fit together
- [Quick start](/docs/en/quickstart/): from installing to calling your first agent
- [Connecting agents](/docs/en/agents/): which agents connect, and how
- [Webhooks](/docs/en/webhooks/): sending and receiving events with other services
- [Security](/docs/en/security/): where your data lives and how workspaces are kept apart

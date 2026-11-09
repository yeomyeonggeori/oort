---
title: Quick start
description: Install the app, sign in to your team's server, connect a first agent and call it in a channel.
status: partial
checked: 2026-11-09
sources:
- clients/site/values.json
- clients/site/i18n/ko.json
- docs/onboarding-deeplink.md
- clients/web/src/features/welcome/firstRunGate.ts
- clients/web/src/features/welcome/firstAgent.ts
- packages/momo-core/src/features/hostedAgents/presets.ts
- packages/momo-core/src/features/agents/channelPlacement.ts
- docs/adr/0162-external-agent-reception-agent-port.md
- README.md
- docs/SELF_HOST.md
---

## 1. Get the app {done}

| Device | Where |
|---|---|
| Mac | From the [download page](/en/). There are builds for Apple Silicon and Intel, and they need macOS 14 or later. |
| iPhone | Install it from the TestFlight invite your team sends. |
| Web | Nothing to install. Open it in your browser. |

On a Mac, open the `.dmg` you downloaded and drag the oort icon onto the Applications folder.

## 2. Sign in to your team's server {done}

Use the server address or invite link your team gave you. Invite links look like `oort://join?server=…&code=…`, and if the Mac app is installed, clicking one opens it in the app.

## 3. Connect a first agent {partial}

Whoever creates a workspace sees the "첫 에이전트 연결" (connect your first agent) screen on their first visit, after the welcome channel. This screen is still in Korean only. Pick one agent to connect.

| Pick | How it connects | Status |
|---|---|---|
| Claude Code | Register the remote MCP server address (Agent Port) | {partial} |
| Codex | Add the remote server as an MCP connector (Agent Port) | {partial} |
| Grok bot | Issue a connection value and give it to the Grok bot (Agent Port) | {partial} |
| OpenAI-compatible | Add this server's AI key on the AI screen | {done} |

The server side of Agent Port is built, but it has not yet been checked end to end with a real client, so it is marked Partial. If you skipped this screen, you can do it later under AI › 외부 연결 (external connections). Each option is covered in [Connecting agents](/docs/en/agents/).

## 4. Add it to a channel and call it {done}

An agent answers only in channels it has been added to. Add the agent to a channel, then mention it there with `@handle`. Its work and results show up in the same channel.

## Running your own server {done}

You need Docker and git. Clone the repository and run the script below. It writes your settings file and prints your first sign-in details.

```sh
git clone https://github.com/yeomyeonggeori/oort.git oort && cd oort
scripts/self_host_env.sh
```

Run the compose command it prints and open the address it names. A public address and published images are covered in [`docs/SELF_HOST.md`](https://github.com/yeomyeonggeori/oort/blob/main/docs/SELF_HOST.md).

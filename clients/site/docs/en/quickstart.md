---
title: Quick start
description: Install the app, sign in to your team's server, connect a first agent and call it in a channel.
status: partial
checked: 2026-11-09
sources:
- clients/site/values.json
- clients/site/i18n/ko.json
- clients/desktop/src-tauri/tauri.conf.json
- docs/onboarding-deeplink.md
- clients/web/src/features/welcome/firstRunGate.ts
- clients/web/src/features/welcome/FirstAgentStage.tsx
- clients/web/src/features/welcome/AiConnectList.tsx
- packages/momo-core/src/features/onboarding/aiConnect.ts
- packages/momo-core/src/features/hostedAgents/presets.ts
- docs/adr/0198-agents-vs-harnesses-work-request-routing.md
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

After the welcome channel, newcomers see the "누구의 AI로 생각할까요?" (whose AI should it think with?) screen. This screen is still in Korean only. Connecting agents is an admin's job: anyone who is not an admin sees "에이전트 연결은 관리자가 해요." (an admin connects agents) instead of the list, and can start chatting right away.

The screen lists these options, in this order.

| Option | How to connect | Who can call it | Status |
|---|---|---|---|
| API 키 · 팀 에이전트 (API key, team agent) | Opens the AI screen to add an OpenAI-compatible API key | Anyone on the team | {done} |
| 그록봇 (Grok bot) | Issues an address and a connection value to hand to the Grok bot | The team | {partial} |
| Claude Code · 내 도구 (my tools) | Turns this Mac's signed-in CLI into a personal agent | Only you | {partial} |
| Codex · 내 도구 (my tools) | Turns this Mac's signed-in CLI into a personal agent | Only you | {partial} |

- The two "my tools" options appear only in the desktop app, and only when the server allows them. On the web, a single line says you can add Claude Code and Codex from your Mac in the desktop app.
- A "my tools" option can be picked only when its CLI is installed, signed in and shows as ready (준비됨).
- If you skip this screen, you can pick it up later on the AI screen.

The Grok bot connects through Agent Port, and "my tools" through the work host on your Mac. Each is covered in [Connecting agents](/docs/en/agents/).

## 4. Add it to a channel and call it {done}

An agent answers only in channels it has been added to. Add the agent to a channel, then mention it there with `@handle`. Its work and results show up in the same channel.

## Running your own server {done}

You need Docker and git. Clone the repository and run the script below. It writes your settings file and prints your first sign-in details.

```sh
git clone https://github.com/yeomyeonggeori/oort.git oort && cd oort
scripts/self_host_env.sh
```

Run the compose command it prints and open the address it names. A public address and published images are covered in [`docs/SELF_HOST.md`](https://github.com/yeomyeonggeori/oort/blob/main/docs/SELF_HOST.md).

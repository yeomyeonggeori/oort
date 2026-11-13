<p align="center"><b>English</b> · <a href="README.ko.md">한국어</a> · <a href="README.ja.md">日本語</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.zh-TW.md">繁體中文</a> · <a href="README.es.md">Español</a> · <a href="README.fr.md">Français</a></p>
<p align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/brand/mark/oort-mark-white.svg"><img src="docs/brand/mark/oort-mark-black.svg" width="64" alt="The oort mark: a ring with a speech-bubble tail and a satellite"></picture></p>
<h1 align="center">oort</h1>
<p align="center"><strong>A self-hosted messenger where agents are members, not bots.</strong></p>
<p align="center"><a href="docs/architecture/overview.md">Architecture</a> · <a href="docs/SELF_HOST.md">Self-host</a> · <a href="docs/adr/">Decisions (ADRs)</a> · <a href="SECURITY.md">Security</a> · <a href="CHANGELOG.md">Changelog</a> · <a href="LICENSE">Apache-2.0</a></p>

<p align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme/channel-en-dark.png"><img src="docs/assets/readme/channel-en-light.png" width="100%" alt="The oort web app showing a release channel: four people and the agent Kometto talk; Kometto has posted a staging summary and is now drafting the release notes, marked as working in the sidebar and above the message box"></picture><br><sub><em>People and an agent in one channel: Kometto answered, and its next job shows as working. Parts of the app are still in Korean only.</em></sub></p>

oort is a team messenger you run on your own server. People and AI agents share the same channels. An agent is a member of the workspace (`member.kind = agent`): it sits on the same roster with the same permissions as a person, instead of being a bot bolted on from outside. When an agent works, its run shows in the channel and you can stop it. When it wants to do something that needs permission, a person approves or declines it right in the conversation, and the decision stays there.

## What works today

The current release is [v0.1.46](https://github.com/yeomyeonggeori/oort/releases/tag/v0.1.46) (the server and web image). Every release is in the [changelog](CHANGELOG.md).

- Channels, threads, DMs, reactions, emoticons and search, on the web, the macOS desktop app and the iPhone app
- Agents as members: mention one, follow its run in the channel, stop it, and approve or decline what it asks to do
- Your own AI connections: API keys, a Hermes agent runtime on the same server, or a local OpenAI-compatible backend. oort orchestrates and records the work; it is not the AI provider
- Files on your server's own volume, or in a Google shared drive you own
- The app speaks Korean and English; parts of it are still Korean only

The desktop and iPhone apps are test builds for our own team. There is no public download and no public hosted instance yet: our team comes first ([goal A](docs/adr/0187-goal-a-team-daily-desktop-ios.md)), and public builds wait for the [store gate (M7)](docs/cicd/03-store-readiness-gate.md).

## Run it on your own server

You need Docker and git. The API, relay, worker, migrations and web app ship in one image.

```sh
git clone https://github.com/yeomyeonggeori/oort.git oort && cd oort
scripts/self_host_env.sh   # writes your env file and prints your first login
# then run the compose line it prints, and open the local address it names
```

Or hand the job to your agent. Paste this:

```text
On this machine, under this user's account only: read
https://raw.githubusercontent.com/yeomyeonggeori/oort/main/docs/SELF_HOST_AGENT.md
and follow its §0 contract to install oort.
Report done only when `scripts/oort doctor` is PASS.
```

Published images and a public address are covered in [`docs/SELF_HOST.md`](docs/SELF_HOST.md), Railway in [`infra/railway/README.md`](infra/railway/README.md).

## Your data and credentials

- **Your server is the source of truth.** Messages, approvals, run state and the audit log live in your PostgreSQL. Third parties appear only where you choose them: the AI backend you pick receives the work context it needs, a Google shared drive holds files only if you pick it over your server's volume, and the optional push relay, the only service we run for you, receives ids and routing data, never message bodies, prompts, approval details or attachments ([ADR-0120](docs/adr/0120-push-notification-boundary.md)).
- **Credentials stay sealed.** Subscription logins (ChatGPT/Codex, Claude) belong in your Hermes volume: oort refuses to create new subscription-token links, and older ones stay sealed until deleted. An API key or Hermes bearer you give oort is stored as AES-256-GCM ciphertext under its own master key, never as plaintext, and shown back as at most its last four characters ([ADR-0004](docs/adr/0004-codex-oauth-hermes-provider-boundary.md) · [evidence, in Korean](docs/security/README.ko.md#자격증명과-provider)).
- **Not end-to-end encrypted.** The server, and whoever runs it, can read message content: search and agents need it.
- **Not audited or certified.** No third-party security audit, penetration test, SOC 2 or ISO certification ([current limits, in Korean](docs/security/README.ko.md#현재-한계와-도입-시-확인할-점)). Report security issues privately as [SECURITY.md](SECURITY.md) describes.

## Read more

- [Architecture](docs/architecture/overview.md): one database and one write path (REST → PostgreSQL → outbox → relay → Centrifugo), and the rules that hold it together
- [Decisions (ADRs)](docs/adr/): why the code is the way it is
- [Self-hosting](docs/SELF_HOST.md) and the [security posture](SECURITY.md#security-posture)
- Build and test from source: `npm ci && npm --prefix clients/web ci && npm --prefix clients/mobile ci`, then `make build && make test` (Rust 1.88+). How changes are checked before they land: [development validation](docs/runbooks/development-validation.md)
- [Changelog](CHANGELOG.md) and [contributing](CONTRIBUTING.md)

## License

oort is licensed under [Apache-2.0](LICENSE) ([NOTICE](NOTICE)). Contributions use the Developer Certificate of Origin with no CLA ([CONTRIBUTING.md](CONTRIBUTING.md)), and we follow the [Contributor Covenant](CODE_OF_CONDUCT.md). Dependency attributions are in [`legal/THIRD_PARTY_NOTICES.md`](legal/THIRD_PARTY_NOTICES.md).

<sub>The repository keeps its working name, <b>momo</b>; the product is oort.</sub>

# Enterprise Trust, Local Gates, and macOS Build Plugin Strategy

> Updated: 2026-06-25
> Status: roadmap research plus operating model.

## 1. Trust Positioning

Do not claim "perfect security" or "Telegram-level secure" in broad terms. Telegram itself distinguishes Secret Chats from default cloud chats in its public FAQ: [Telegram FAQ](https://telegram.org/faq).

oort's stronger claim is:

> self-hostable agent execution ledger for teams that need data sovereignty, approval, cost control, audit, and optional local processing.

Key points:

- Self-hosting and intranet deployment.
- Postgres as source of truth with RLS FORCE and explicit tenant context.
- Agent/plugin execution recorded as timeline artifacts and audit events.
- Local LLM for privacy-sensitive context handling.
- Optional E2EE for high-risk DM/secret channels, with clear tradeoffs: agent search/context may be disabled unless the user explicitly decrypts for a task.

## 2. Enterprise Trust Roadmap

| Stage | Target | oort deliverable |
|---|---|---|
| Trust-0 | Secure SDLC | Threat model, secure coding checklist, dependency policy, secret scanning, local PR gate |
| Trust-1 | Supply chain | SBOM, SLSA-oriented provenance plan, license scan, reproducible release notes |
| Trust-2 | External validation | Vulnerability disclosure policy, external pentest, remediation evidence |
| Trust-3 | Customer trust | Security whitepaper, data flow diagrams, deployment hardening guide |
| Trust-4 | Formal programs | SOC 2 Type I then Type II, ISO 27001 mapping, CSA STAR; ISMS-P later for Korea-heavy enterprise/public sector |

Primary references:

- [NIST SSDF SP 800-218](https://csrc.nist.gov/pubs/sp/800/218/final)
- [AICPA SOC suite](https://www.aicpa-cima.com/resources/landing/system-and-organization-controls-soc-suite-of-services)
- [ISO/IEC 27001](https://www.iso.org/standard/27001)
- [CSA STAR](https://cloudsecurityalliance.org/star)

## 3. Mattermost License Caveat

Mattermost is useful as a self-hosted collaboration reference, but oort should not copy code.

- Running Mattermost commercially and copying/modifying/distributing Mattermost code are different legal questions.
- Mattermost has MIT-licensed compiled platform artifacts in parts of its distribution, but source builds and enterprise-only plugin code can involve AGPLv3, source-available, or commercial-license constraints.
- oort should use Mattermost only as API/UX/architecture reference and keep dependencies permissive.

References:

- [Mattermost LICENSE](https://raw.githubusercontent.com/mattermost/mattermost/master/LICENSE.txt)
- [Mattermost source available plugin guide](https://developers.mattermost.com/integrate/plugins/source-available-license/)

## 4. Multi-session Worktree Model

Target: run at least five Codex sessions without collisions.

Roles:

- `momo-main`: orchestration only. It picks issues, checks roadmap, coordinates PR review/merge, and summarizes state.
- Worker threads: exactly one GitHub Issue, one branch, one worktree, one PR.

Rules:

- Use GitHub Issue as the unit of lock.
- Use remote branch existence as the practical lock.
- Prefer `scripts/goal_claim.sh <issue>` when present; otherwise manually create `docs|feat|fix/<issue>-<slug>` from `origin/main`.
- Do not run two large changes in the same package family at the same time, especially `server/`, `infra/`, migrations, and shared models.
- Each worker reports: issue, branch, worktree path, validation commands, PR URL, remaining risks.

Detailed operating guide: `docs/MULTI_SESSION_OPS.md`.

## 5. Local PR Gate while GitHub Actions Are Not Primary

GitHub Actions may be intentionally ignored for a period, but quality gates should not disappear. A PR needs local evidence.

Minimum local gate:

```bash
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer make build
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer make test
python3 -m py_compile adapters/hermes/momo_adapter.py
jq empty .github/labels.json infra/centrifugo.json
```

Add scope-specific runtime checks:

- `scripts/verify_rls.sh`
- `scripts/verify_agent_worker.sh`
- `make up && make migrate` when runtime or migrations change

Detailed operating guide: `docs/LOCAL_PR_GATE.md`.

## 6. build-macos-apps Plugin Recommendation

Use the plugin actively for macOS development, but keep it scoped.

Good uses:

- SwiftPM package inspection, `swift build`, `swift test`, and narrow test triage.
- MomoMacDevApp build/run verification.
- SwiftPM GUI launch standardization through a project-local `script/build_and_run.sh`.
- Codex app Run button wiring through `.codex/environments/environment.toml`.
- Optional flags for `--verify`, `--logs`, `--telemetry`, and `--debug`.

Important caveat:

- A SwiftUI/AppKit SwiftPM GUI app should not rely on raw `swift run` as the only launch path. It can work for development, but a staged `.app` bundle gives proper bundle metadata, Dock activation, and process verification.

Recommended ticket:

- `MOMO-134`: add `script/build_and_run.sh` for `clients/macOS` SwiftPM GUI app, stage `dist/MomoMacDevApp.app`, wire Codex Run action, and use the plugin's SwiftPM/test-triage flow for local developer verification.

Do not use it for:

- iOS simulator workflows. Use iOS-specific tooling there.
- Store signing/notarization decisions before M4 packaging work.
- Claims about UI state unless the app is actually launched and inspected.

## 7. Immediate Roadmap Impact

- M1 gets local gate and multi-session operations before more parallel work.
- M2 gets Context Packet, Memory Plane, and Google Workspace connector design.
- M3 gets local LLM UX and agent protocol cards.
- M4/M5 inherit Foundation Models availability/fallback checks.
- M7 gets enterprise trust evidence as a formal gate input.

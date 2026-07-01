# ADR 0005: macOS Alpha Update Channel v0

> Status: Accepted for alpha skeleton.
> Date: 2026-07-01.
> Related: MOMO-235 / #226, ADR 0003, M4.

## Context

Internal alpha testers need a fast "there is a newer build" experience similar to Codex app updates: a visible update affordance in the app chrome, a predictable alpha channel, and a runbook that lets operators ship fixes without turning every tester into a build engineer.

The repo is not yet at full M4 distribution exit. `MomoMac.xcodeproj` exists as the release host, but Developer ID signing, notarization, DMG production, Sparkle appcast signing, and old-version-to-new-version update proof are not complete in this goal. The SwiftPM development app remains the primary local alpha surface and must not claim notarized distribution readiness.

## Decision

momo will use Sparkle 2 as the preferred macOS direct-distribution update engine for the alpha channel, with a manual download fallback until signed/notarized artifacts and appcast infrastructure exist.

The v0 implementation is a skeleton:

- `clients/macOS/Sources/MomoMac/MomoMacUpdateChannel.swift` defines the alpha/stable update-channel status model and a SwiftUI status surface.
- `MomoMacSessionRootView` exposes an `Updates` popover in the session bar for `MomoMacDevApp` and the Xcode host.
- The popover reads non-secret runtime hints from environment variables and clearly reports `signing-unverified` until the release chain is complete.
- Real Sparkle framework integration, Info.plist keys, appcast generation, and update installation remain M4 follow-up work.

This keeps the alpha user experience visible now without smuggling distribution secrets or unsigned update assumptions into the SwiftPM dev app.

## Channel Contract

| Channel | Audience | Engine | Artifact | Feed |
|---|---|---|---|---|
| `alpha` | Dawn/momo internal testers | Sparkle 2 preferred, manual fallback | Developer ID signed + notarized DMG once available | `appcast-alpha.xml` |
| `stable` | Post-gate public direct download | Sparkle 2 | Developer ID signed + notarized DMG | `appcast.xml` |

`alpha` is the default for development builds. It may use an authenticated or private appcast URL during internal testing, but the appcast and artifact URLs must be reachable by testers without putting credentials in the app bundle.

## Runtime Hints

The SwiftPM skeleton reads these optional, non-secret keys:

| Key | Meaning | Secret? |
|---|---|---|
| `MOMO_UPDATE_CHANNEL` | `alpha` or `stable`; defaults to `alpha`. | No |
| `MOMO_UPDATE_FEED_URL` | Candidate Sparkle appcast URL. | No, but private URLs should avoid embedded credentials. |
| `MOMO_UPDATE_PUBLIC_ED_KEY` | Sparkle EdDSA public key only. | No |
| `MOMO_UPDATE_AUTOMATIC_CHECKS` | UI hint for future automatic checks. | No |
| `MOMO_UPDATE_SIGNING_READY` | Operator evidence hint that Developer ID signing is ready. | No |
| `MOMO_UPDATE_NOTARIZATION_READY` | Operator evidence hint that notarization is ready. | No |
| `MOMO_UPDATE_DMG_READY` | Operator evidence hint that the DMG artifact path is ready. | No |

The app must never read or display Sparkle private keys, Apple API private keys, certificate exports, or notarization credentials.

## Secret Boundary

Allowed in git:

- secret names and placeholder env keys;
- public Sparkle EdDSA key placeholder;
- appcast schema/runbook text;
- scripts that refuse to run without externally supplied signing material.

Forbidden in git:

- Sparkle EdDSA private key;
- Apple `.p8`, `.p12`, `.cer`, provisioning profiles, keychain exports;
- notarization API key material;
- signed/notarized release artifacts or DMGs unless a later release-storage decision explicitly permits generated artifacts;
- appcast entries pointing at unnotarized release artifacts as if they were installable.

## Release Chain

An update is installable only when all of the following are true:

1. Xcode release host builds `MomoMac.app`.
2. Nested code and outer app are signed bottom-up with Developer ID Application, hardened runtime, and timestamp.
3. The app or DMG is submitted with `xcrun notarytool submit --wait`.
4. The accepted ticket is stapled and verified.
5. Gatekeeper assessment passes.
6. Sparkle appcast item is generated from the signed, notarized artifact.
7. An older signed/notarized app successfully updates to the new version.

Until then, the app surface must say `signing-unverified` or equivalent and the PR evidence must not claim real update verification.

## Consequences

Positive:

- Internal testers see where update checks will live before Sparkle is integrated.
- The app can surface missing update prerequisites without storing secrets.
- M4 can integrate Sparkle 2 without redesigning the app chrome.

Tradeoffs:

- The current button is a placeholder/checklist surface, not an updater.
- Sparkle 2 framework integration still has to happen in the Xcode host.
- Manual alpha download remains the fallback until two signed/notarized versions exist.

## Follow-Up

- Add Sparkle 2 to the Xcode app target.
- Set `SUFeedURL` and `SUPublicEDKey` in the release app Info.plist from non-secret configuration.
- Add an appcast generation helper that consumes only signed/notarized artifacts.
- Add a local/static gate for appcast XML and Sparkle public-key presence.
- Prove old-version-to-new-version update before closing M4 update exit.

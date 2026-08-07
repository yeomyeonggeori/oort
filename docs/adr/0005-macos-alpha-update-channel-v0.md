# ADR 0005: macOS Alpha Update Channel v0

> Status: Accepted for alpha skeleton; updated by MOMO-244 Dev Update Channel v0.
> Date: 2026-07-01.
> Related: MOMO-235 / #226, MOMO-244 / #244, ADR 0003, M4.

## Context

Internal alpha testers need a fast "there is a newer build" experience similar to Codex app updates: a visible update affordance in the app chrome, a predictable alpha channel, and a runbook that lets operators ship fixes without turning every tester into a build engineer.

The repo is not yet at full M4 distribution exit. `MomoMac.xcodeproj` exists as the release host, but Developer ID signing, notarization, DMG production, Sparkle appcast signing, and old-version-to-new-version update proof are not complete in this goal. The SwiftPM development app remains the primary local alpha surface and must not claim notarized distribution readiness.

## Decision

oort will use Sparkle 2 as the preferred macOS direct-distribution update engine for the alpha channel, with a local/file manifest fallback until signed/notarized artifacts and appcast infrastructure exist.

The v0 implementation has two layers:

- MOMO-235 established the visible `Updates` surface and the Sparkle/signing/notarization boundary.
- MOMO-244 upgrades that surface into a Dev Update Channel v0: local/file manifest metadata is read, current vs available version is compared, and the UI distinguishes `Up to date`, `Update available`, and `Update check failed`.
- `clients/macOS/Sources/MomoMac/MomoMacUpdateChannel.swift` defines the alpha/stable update-channel status model, manifest parser, version comparison, and SwiftUI status surface.
- `clients/macOS/Fixtures/update-manifest-alpha-v0.json` is the example operator manifest fixture.
- `MomoMacSessionRootView` exposes an `Updates` popover in the session bar for `MomoMacDevApp` and the Xcode host.
- The popover reads non-secret local manifest hints from environment variables and clearly keeps install/relaunch operator-assisted.
- Real Sparkle framework integration, Info.plist keys, appcast generation, and update installation remain M4 follow-up work.

This keeps the alpha user experience visible now without smuggling distribution secrets or unsigned update assumptions into the SwiftPM dev app.

## Channel Contract

| Channel | Audience | Engine | Artifact | Feed |
|---|---|---|---|---|
| `alpha` | Dawn/momo internal testers | Local/file manifest v0, Sparkle 2 later | Operator-assisted artifact now; Developer ID signed + notarized DMG once available | `update-manifest-alpha-v0.json` now, `appcast-alpha.xml` later |
| `stable` | Post-gate public direct download | Sparkle 2 | Developer ID signed + notarized DMG | `appcast.xml` |

`alpha` is the default for development builds. In v0 the manifest source must be a local path or `file://` URL; artifact URLs must be reachable by testers without putting credentials in the app bundle.

## Runtime Hints

The SwiftPM/Xcode-host surface reads these optional, non-secret keys:

| Key | Meaning | Secret? |
|---|---|---|
| `MOMO_UPDATE_CHANNEL` | `alpha` or `stable`; defaults to `alpha`. | No |
| `MOMO_CURRENT_VERSION` / `MOMO_APP_VERSION` | Current app version override for dev builds. | No |
| `MOMO_CURRENT_BUILD` / `MOMO_APP_BUILD` | Current app build override for dev builds. | No |
| `MOMO_UPDATE_MANIFEST_PATH` | Local JSON manifest path. | No |
| `MOMO_UPDATE_MANIFEST_URL` | `file://` JSON manifest URL. | No |
| `MOMO_UPDATE_PUBLIC_ED_KEY` | Future Sparkle EdDSA public-key hint only; private-looking values are flagged. | No |

The app must never read or display Sparkle private keys, Apple API private keys, certificate exports, or notarization credentials.

## Secret Boundary

Allowed in git:

- secret names and placeholder env keys;
- public Sparkle EdDSA key placeholder;
- local manifest fixture, appcast schema/runbook text;
- scripts that refuse to run without externally supplied signing material.

Forbidden in git:

- Sparkle EdDSA private key;
- Apple `.p8`, `.p12`, `.cer`, provisioning profiles, keychain exports;
- notarization API key material;
- signed/notarized release artifacts or DMGs unless a later release-storage decision explicitly permits generated artifacts;
- appcast entries or local manifests pointing at untrusted public release artifacts as if they were signed/notarized release proof.

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
- Internal testers can see a real "new build exists" CTA during dogfood without remembering terminal commands.
- The app can surface missing update prerequisites without storing secrets.
- M4 can integrate Sparkle 2 without redesigning the app chrome.

Tradeoffs:

- The current button is operator-assisted, not a fully unattended self-replace updater.
- Sparkle 2 framework integration still has to happen in the Xcode host.
- Local/file manifest distribution remains the fallback until two signed/notarized versions exist.

## Follow-Up

- Add Sparkle 2 to the Xcode app target.
- Set `SUFeedURL` and `SUPublicEDKey` in the release app Info.plist from non-secret configuration.
- Add an appcast generation helper that consumes only signed/notarized artifacts.
- Add a local/static gate for appcast XML and Sparkle public-key presence.
- Prove old-version-to-new-version update before closing M4 update exit.

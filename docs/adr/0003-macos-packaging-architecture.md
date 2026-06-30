# ADR 0003: macOS Packaging Architecture

> Status: Accepted for M4 planning.
> Date: 2026-06-30.
> Related: MOMO-208, MOMO-030 / #15, MOMO-031 / #16, MOMO-032 / #17, MOMO-134, M4.

## Context

`clients/macOS` is currently a SwiftPM package with a development GUI executable, `MomoMacDevApp`, and local gate coverage through `scripts/local_gate.sh --profile macos-ui`. That surface is good for fast Codex work: it can run from the package, point at worktree-scoped local services, and verify real-backend REST/UI smoke without Apple signing material.

M4 has a different goal. It must produce a distributable macOS application: an Xcode-built `.app`, Developer ID signing, hardened runtime, notarization through `notarytool`, a stapled DMG, and Sparkle 2 updates. Existing M4 issues #15, #16, and #17 are blocked until the source layout, app boundary, signing boundary, and local verification contract are fixed.

GitHub Actions are disabled/manual-only by policy during this phase, so M4 must be designed around local evidence first. CI/release jobs may later automate the same commands, but they are not the source of truth for the first packaging slice.

This ADR does not create the Xcode project, sign artifacts, notarize, build a DMG, configure Sparkle, or enter Apple account secrets.

## Decision

M4 will keep the SwiftPM development app and the release `.app` as separate but connected surfaces.

| Surface | Canonical path | Responsibility | Must not do |
|---|---|---|---|
| SwiftPM library | `clients/macOS/Sources/MomoMac` | Product UI, view models, backend adapters, testable app logic. | Do not own release signing, bundle identifiers, app icons, Info.plist, Sparkle keys, or Apple provisioning. |
| SwiftPM dev app | `clients/macOS/Sources/MomoMacDevApp` | Fast local GUI loop, fixture/live backend injection, local gate smoke, Codex iteration. | Do not become the shipping artifact or claim Gatekeeper/notarization readiness. |
| Xcode release app | future `clients/macOS/MomoMac.xcodeproj` | Thin macOS app host that imports local SwiftPM packages, owns `.app` bundle settings, app icon, Info.plist, entitlements, schemes, archive/export. | Do not fork product UI logic or duplicate MomoCore/MomoMac model/view code. |
| Release scripts | future `scripts/release_macos*.sh` or `scripts/package_macos*.sh` | Reproducible archive/export validation, codesign/notary/DMG/stapler/spctl checks, Sparkle appcast helper. | Do not commit secrets, `.p8`, `.p12`, certificates, provisioning profiles, or Sparkle private keys. |

The release Xcode project must be a thin host over the existing SwiftPM packages:

```text
clients/macOS/
|- Package.swift
|- Sources/
|  |- MomoMac/          # shared macOS product UI and app logic
|  `- MomoMacDevApp/    # development-only SwiftPM app entrypoint
`- MomoMac.xcodeproj    # M4 release host, created by #15
```

The Xcode app target owns distribution concerns:

- scheme `MomoMac`;
- bundle identifier `com.dawnkim.momo`;
- `CFBundleShortVersionString` and monotonically increasing `CFBundleVersion`;
- app icon and asset catalog;
- release `Info.plist`;
- entitlements;
- hardened runtime build setting;
- archive/export settings for Developer ID distribution.

`MomoMacDevApp` remains the fastest development loop even after the Xcode project exists. Release bugs found in the Xcode app should be fixed in `MomoMac` shared sources whenever possible, then verified by both the SwiftPM dev app gate and the Xcode/package gate.

## build-macos-apps Plugin Use

Use the build-macos-apps plugin for macOS-specific build, run, packaging, signing, and diagnostics work. Do not use it as a substitute for committed project files, local gate evidence, or human-owned Apple account setup.

| Task | Use plugin? | Rule |
|---|---|---|
| SwiftPM dev GUI run/debug | Yes | Use build/run/debug style workflows to launch or diagnose `MomoMacDevApp`; keep product fixes in `clients/macOS/Sources/MomoMac`. |
| Xcode project creation/review | Yes | Use macOS/Xcode guidance to inspect schemes, build settings, Info.plist, entitlements, and bundle shape after #15 creates the project. |
| Signing/Gatekeeper diagnosis | Yes | Use signing-entitlements guidance plus `codesign`, `spctl`, and `plutil` output to classify failures. Do not invent entitlements. |
| Notarization readiness/failure | Yes | Use packaging-notarization guidance to separate bundle/signing failures from Apple notary/trust-policy failures. |
| Apple account, certificates, `.p8`, `.p12`, Sparkle private key | No | Human/operator-owned. Codex may write runbooks and secret names, but must not request, store, print, or commit secret material. |
| CI/release workflow activation | No by default | GitHub Actions remain disabled/manual-only until owner approval and gate policy allow reactivation. |

Minimum plugin-backed evidence for packaging issues should say what artifact/settings were inspected, the signing/notarization state, the failure class, and the next validation command.

## Packaging Order

M4 implementation must keep this order. Later automation can wrap it, but must not reorder the trust chain.

1. Build/archive the Xcode `MomoMac` app target with local SwiftPM package dependencies.
2. Verify bundle shape: `MomoMac.app/Contents/Info.plist`, `Contents/MacOS/*`, embedded frameworks, helper tools, Sparkle artifacts if present, app icon, and entitlements file.
3. Sign nested code bottom-up with Developer ID Application, hardened runtime, timestamp, and the release entitlements.
4. Sign the outer `.app` last.
5. Verify the app signature with `codesign --verify --deep --strict --verbose=2`.
6. Create a DMG for drag-to-Applications distribution.
7. Submit the DMG or signed app container with `xcrun notarytool submit --wait`.
8. Staple the accepted ticket to the DMG and, where applicable, the app.
9. Validate stapling and Gatekeeper behavior with `xcrun stapler validate` and `spctl`.
10. Generate/update Sparkle appcast only from a signed, notarized release artifact.
11. Verify one old-version to new-version Sparkle update before calling M4 exit complete.

Direct macOS distribution and App Store distribution remain separate tracks. The M4 default is Developer ID notarized DMG plus Sparkle. Mac App Store is not part of M4 because sandboxing, review, and App Store update mechanics are different; Sparkle is not used for Mac App Store updates.

## Entitlements And Secret Boundary

The initial Developer ID app should start with the minimum distribution entitlements required by the product.

Expected first-pass entitlements:

- `com.apple.security.network.client = true` for API, Centrifugo, and agent/runtime network calls.
- Keychain access group only when the app actually persists auth/session tokens in Keychain.
- App Sandbox remains off for the initial Developer ID direct distribution unless a later ticket explicitly accepts the sandbox migration cost.

Do not add hardened runtime exceptions such as JIT, unsigned executable memory, library validation disablement, or DYLD environment variables unless a concrete dependency fails and the failure is reproduced. Distribution failures should be classified before expanding entitlements.

Secret and signing material boundaries:

- Apple Developer account, certificates, API keys, profiles, and Sparkle EdDSA private key are human/operator material.
- The repo may contain secret names, `.env.example` placeholders, runbook commands, and `.gitignore` protections.
- The repo must not contain `.p8`, `.p12`, `.cer`, `.mobileprovision`, keychain exports, or Sparkle private keys.
- A future private `momo-signing` boundary may hold signing runbooks or encrypted secret storage metadata, but not as part of this ADR.

## Local Verification Contract

While GitHub Actions are disabled/manual-only, M4 PRs must use local evidence.

Baseline for all docs/spec-only packaging changes:

```sh
scripts/local_gate.sh --profile docs
```

Expected gates by ticket:

| Ticket | Gate |
|---|---|
| MOMO-208 / #171 | `scripts/local_gate.sh --profile docs` |
| MOMO-030 / #15 | `scripts/local_gate.sh --profile docs` plus `xcodebuild build -scheme MomoMac -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO` when the Xcode project exists |
| MOMO-031 / #16 | #15 gate plus dry-run/static validation of release script; real signing/notary evidence is `signing-unverified` until Apple certs/API key are present |
| MOMO-032 / #17 | #16 gate plus Sparkle config/appcast script validation; real update evidence is manual/runtime until two signed notarized versions exist |

M4 exit remains stricter than per-ticket local gates: notarized DMG must pass Gatekeeper on another Mac and Sparkle must update once from an older signed/notarized version. Do not mark those as verified from static config alone.

## M4 Issue Split

Issue #15 / MOMO-030 should stay focused on app host creation:

- create `clients/macOS/MomoMac.xcodeproj`;
- add a thin `MomoMac` app target over local `MomoMac` and `MomoCore` SwiftPM packages;
- add app icon, Info.plist, release entitlements, bundle ID, hardened runtime setting, and scheme;
- prove unsigned local build with `CODE_SIGNING_ALLOWED=NO`;
- leave Developer ID signing, notary, DMG, and Sparkle out of scope.

Issue #16 / MOMO-031 should stay focused on trust packaging:

- add release packaging script/runbook for archive/export or built `.app` input;
- perform bottom-up codesign sequencing and validation;
- create DMG;
- submit with `notarytool --wait`;
- staple and validate;
- record `signing-unverified` when Apple material is unavailable;
- leave Sparkle update mechanics out of scope except ensuring Sparkle nested code would be included in bottom-up signing once #17 lands.

Issue #17 / MOMO-032 should stay focused on automatic updates:

- integrate Sparkle 2 into the Xcode app target;
- add `SUFeedURL` and `SUPublicEDKey` placeholders;
- document/generate EdDSA key handling as human-owned secret material;
- add appcast generation helper;
- require each update artifact to come from the #16 signed/notarized path;
- prove an old-version to new-version update when two local signed/notarized builds exist.

Recommended follow-up split if #15 stays too large:

| Proposed child | Scope | Blocks |
|---|---|---|
| M4-C1a project skeleton | `.xcodeproj`, scheme, local package references, `CODE_SIGNING_ALLOWED=NO` build | #15 |
| M4-C1b app metadata | Info.plist, bundle ID, versioning, asset catalog, entitlements file | #15 |
| M4-C1c packaging preflight | script or docs that inspect bundle shape and print missing release prerequisites | #16 |

## Consequences

Positive:

- Codex can continue fast UI/runtime iteration through SwiftPM without waiting on Apple account setup.
- The shipping app has a normal Apple/Xcode distribution surface.
- Signing, notarization, DMG, and Sparkle each have a narrow owner and gate.
- The build-macos-apps plugin has a clear role in diagnosis and verification instead of becoming an implicit release system.

Tradeoffs:

- There are two app entrypoints to keep honest: dev SwiftPM and release Xcode.
- Some M4 evidence remains manual or `signing-unverified` until certificates/API keys exist.
- The Xcode project introduces project-file review burden, but that burden is appropriate for distribution.

## Non-Goals

- Create `MomoMac.xcodeproj`.
- Add or change signing secrets.
- Notarize any artifact.
- Build a DMG.
- Integrate Sparkle.
- Reactivate GitHub Actions or trigger release workflows.

# macOS Alpha Update Channel Runbook

> Scope: internal alpha update-channel skeleton for MOMO-235 / #226.
> This is not a public release path and does not satisfy M4 Sparkle exit by itself.

## 0. Current State

The macOS app has an `Updates` popover in the session bar. In SwiftPM development builds it is a status/checklist surface, not a real installer. It defaults to the `alpha` channel and reports what is missing before Sparkle 2 can install updates.

The intended alpha experience is:

1. tester opens momo;
2. app shows an update affordance;
3. once Sparkle is wired, the alpha appcast announces a newer signed/notarized build;
4. tester installs the update from the app without rebuilding locally.

Until Sparkle is integrated, operators should announce the new build and link the signed/notarized DMG manually.

## 1. Local Placeholder Check

Run the dev app with non-secret update hints:

```sh
MOMO_UPDATE_CHANNEL=alpha \
MOMO_UPDATE_FEED_URL=https://updates.example.com/momo/alpha/appcast.xml \
MOMO_UPDATE_PUBLIC_ED_KEY=replace-with-public-ed25519-key \
swift run --package-path clients/macOS MomoMacDevApp
```

Open `Updates` in the session bar. Expected:

- channel: `Alpha`;
- engine: `Sparkle 2`;
- feed URL visible;
- EdDSA public key status configured;
- artifact trust still `signing-unverified` unless all artifact readiness hints are explicitly set.

Do not set or paste a Sparkle private key into any `MOMO_UPDATE_*` variable.

## 2. Operator Boundary

Human/operator-owned material:

| Material | Storage |
|---|---|
| Sparkle EdDSA private key | operator keychain/password manager or private signing repo |
| Developer ID Application cert/private key | Apple account/keychain/private signing storage |
| App Store Connect API `.p8` for notarytool | private signing storage |
| Notary profile credentials | local keychain or CI secret store, never git |
| Signed `.app`, `.dmg`, appcast upload credentials | release storage outside source tree |

Repo-owned material:

| Material | Path |
|---|---|
| Update-channel ADR | `docs/adr/0005-macos-alpha-update-channel-v0.md` |
| Alpha update runbook | `docs/MACOS_ALPHA_UPDATE_CHANNEL.md` |
| Placeholder UI/status model | `clients/macOS/Sources/MomoMac/MomoMacUpdateChannel.swift` |

## 3. Future Sparkle 2 Wiring

When the release app is ready for real updates:

1. Add Sparkle 2 to the Xcode `MomoMac` app target only.
2. Set release app Info.plist keys:
   - `SUFeedURL=https://updates.<domain>/momo/alpha/appcast.xml` for alpha builds;
   - `SUPublicEDKey=<Sparkle EdDSA public key>`;
   - automatic-check behavior according to the alpha policy.
3. Generate a Developer ID signed, hardened-runtime app.
4. Notarize and staple the app/DMG.
5. Generate the appcast from that notarized artifact.
6. Upload appcast and DMG to the alpha update host.
7. Verify one older signed/notarized build updates to the newer signed/notarized build.

The alpha appcast must not point at an unsigned or unnotarized artifact.

## 4. Appcast Boundary

Required appcast metadata for each alpha item:

- monotonically increasing `CFBundleVersion`;
- human-readable version;
- download URL for the signed/notarized DMG or archive;
- Sparkle EdDSA signature;
- release notes URL or short release notes;
- minimum macOS version matching the app target.

Recommended hosting boundary:

- `updates.<domain>/momo/alpha/appcast.xml` for alpha;
- `downloads.<domain>/momo/alpha/MomoMac-<version>.dmg` for artifacts;
- access controlled at the host/CDN layer if needed, not by embedding secrets in the app bundle.

## 5. Verification

Static/local skeleton gate:

```sh
swift test --package-path clients/macOS
scripts/local_gate.sh --profile docs
```

Optional Swift-wide gate:

```sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift
```

Real update gate, future M4:

```sh
xcodebuild build -scheme MomoMac -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO
# then operator-owned signing/notary/DMG/appcast commands from the M4 release runbook
```

Record real Sparkle update evidence only after an old signed/notarized build updates to a newer signed/notarized build.

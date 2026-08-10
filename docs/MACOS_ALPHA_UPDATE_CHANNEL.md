# macOS Alpha Update Channel Runbook

> Scope: internal alpha Dev Update Channel v0 for MOMO-244 / #244.
> This is not a public release path and does not satisfy M4 Sparkle exit by itself.

## 0. Current State

The macOS app has an `Updates` popover in the session bar. In SwiftPM development and unsigned Xcode-host builds, it reads a local JSON manifest from `MOMO_UPDATE_MANIFEST_PATH` or a `file://` URL in `MOMO_UPDATE_MANIFEST_URL`.

The v0 dogfood experience is:

1. operator creates or updates a local/file-hosted manifest;
2. tester opens oort and clicks `Updates`;
3. app shows current version, available version, channel, manifest state, and download target;
4. if the manifest announces a newer build, tester uses `Open Download`, follows the install/relaunch steps, then reopens oort.

This is operator-assisted. It does not self-replace the running app and does not claim notarized distribution readiness.

## 1. Local Manifest Check

Example fixture:

```sh
clients/macOS/Fixtures/update-manifest-alpha-v0.json
```

Run the dev app against that fixture:

```sh
MOMO_CURRENT_VERSION=0.4.4-alpha.1 \
MOMO_CURRENT_BUILD=230 \
MOMO_UPDATE_CHANNEL=alpha \
MOMO_UPDATE_MANIFEST_PATH="$PWD/clients/macOS/Fixtures/update-manifest-alpha-v0.json" \
swift run --package-path clients/macOS MomoMacDevApp
```

Open `Updates`. Expected:

- channel: `Alpha`;
- engine: `Local manifest`;
- current version/build and available version/build are visible;
- state is `Update available` when the manifest version/build is newer;
- `Open Download`, optional `Release Notes`, and relaunch steps are visible;
- invalid, missing, or non-file manifest sources show `Update check failed` with diagnostics.

To prove the latest state, set current version/build to match the fixture:

```sh
MOMO_CURRENT_VERSION=0.4.5-alpha.2 \
MOMO_CURRENT_BUILD=244 \
MOMO_UPDATE_MANIFEST_URL="file://$PWD/clients/macOS/Fixtures/update-manifest-alpha-v0.json" \
swift run --package-path clients/macOS MomoMacDevApp
```

Expected state: `Up to date`.

## 2. Manifest Contract

Manifest schema v0:

```json
{
  "schema_version": 1,
  "channel": "alpha",
  "version": "0.4.5-alpha.2",
  "build": "244",
  "released_at": "2026-07-01T09:00:00Z",
  "minimum_macos": "14.0",
  "summary": "Short operator-facing release summary.",
  "download_url": "file:///Users/Shared/momo-alpha/MomoMac-0.4.5-alpha.2.zip",
  "release_notes_url": "https://github.com/yeomyeonggeori/oort/releases/tag/macos-alpha-0.4.5-alpha.2",
  "restart_instructions": [
    "Open the downloaded alpha artifact.",
    "Replace the previous MomoMac app or rerun the operator-provided install command.",
    "Quit and relaunch momo, then reopen Updates to confirm the current build."
  ]
}
```

Rules:

- `schema_version` must be `1`.
- `channel` is `alpha` or `stable`; alpha is the default dogfood channel.
- `version`, `build`, `summary`, and `download_url` are required.
- Manifest source must be a local path or `file://` URL in v0.
- `download_url` may point to a local artifact or operator-owned internal download location.
- Do not embed secrets in manifest URLs, app config, release notes URLs, or download URLs.

## 3. Operator Boundary

Human/operator-owned material:

| Material | Storage |
|---|---|
| Alpha build artifact (`.app`, `.zip`, `.dmg`) | local shared folder, internal file server, or release storage outside source tree |
| Manifest used by dogfood testers | local shared folder or operator-owned internal file URL |
| Developer ID cert/private key | Apple account/keychain/private signing storage |
| Sparkle EdDSA private key | operator keychain/password manager or private signing repo |
| App Store Connect API `.p8` for notarytool | private signing storage |

Repo-owned material:

| Material | Path |
|---|---|
| Alpha update runbook | `docs/MACOS_ALPHA_UPDATE_CHANNEL.md` |
| Example manifest fixture | `clients/macOS/Fixtures/update-manifest-alpha-v0.json` |
| Dev update UI/status model | `clients/macOS/Sources/MomoMac/MomoMacUpdateChannel.swift` |
| Future Sparkle ADR | `docs/adr/0005-macos-alpha-update-channel-v0.md` |

## 4. Future Sparkle 2 Wiring

When the release app is ready for real automatic updates:

1. Add Sparkle 2 to the Xcode `MomoMac` app target only.
2. Set release app Info.plist keys such as `SUFeedURL` and `SUPublicEDKey`.
3. Generate a Developer ID signed, hardened-runtime app.
4. Notarize and staple the app/DMG.
5. Generate the appcast from that notarized artifact.
6. Upload appcast and DMG to the alpha update host.
7. Verify one older signed/notarized build updates to the newer signed/notarized build.

The v0 local manifest must not be presented as Sparkle, signing, notarization, or DMG proof.

## 5. Verification

Required for MOMO-244:

```sh
scripts/local_gate.sh --profile macos-ui
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile swift
```

Focused local check:

```sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer swift test --package-path clients/macOS
```

Record real Sparkle update evidence only after an old signed/notarized build updates to a newer signed/notarized build in the M4 release path.

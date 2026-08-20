# macOS Alpha Update Channel Runbook

> ## ⚠️ 이 문서는 **은퇴한 SwiftUI 데스크탑**의 업데이트 채널이다 (ITO-0 T-C / #1609)
>
> `clients/macOS`는 삭제됐다(W-S1 / #1215). 아래 Swift/Sparkle/`MomoMac.app` 절차와
> 삭제된 게이트 프로파일 `macos-ui`는 현행 제품 경로가 아니다. <!-- docs-cmd-ignore: 은퇴 스택 이름 호명 (#1609) -->
> 따라 가면 실패하지 않고 **없는 트리를 찾거나, 잘못된 스택을 가리킨다.**
>
> **현행 데스크탑 업데이트 채널(Tauri next):**
>
> | 하려는 것 | 갈 곳 |
> |---|---|
> | 채널 계약·발행·매니페스트 | [`docs/NEXT_CHANNEL.md`](NEXT_CHANNEL.md) |
> | 셸 업데이터 UI·실측·known gaps | [`clients/desktop/README.md`](../clients/desktop/README.md) (Identity / updater / Measured / Known gaps) |
> | 발행 스크립트 | `scripts/publish_next_build.sh` — 실발행은 성재 맥(T-D / #1281) |
> | ITO-3 I5 (자동업데이트 1왕복) | [`docs/LOCAL_3_DAY_ALPHA_TEST_PACK.md`](LOCAL_3_DAY_ALPHA_TEST_PACK.md) Day 3 |
>
> 본문은 MOMO-244 당시 원문이다. 고치지 않고 사문서로 둔다.

---

> Scope: internal alpha Dev Update Channel v0 for MOMO-244 / #244.
> This is not a public release path and does not satisfy M4 Sparkle exit by itself.
> **Retired surface — do not run the commands below on a current checkout.**

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

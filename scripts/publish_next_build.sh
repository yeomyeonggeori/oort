#!/usr/bin/env bash
# momo-next 채널 발행 (ADR-0133 P2, MOMO-606).
#
#   scripts/publish_next_build.sh --version 0.1.0-next.2 [--notes "..."] [--dry-run]
#   scripts/publish_next_build.sh --public --version 0.1.0 [--notes "..."] [--dry-run]
#
# 무엇이 다른가 (alpha 채널과의 관계)
#   alpha 채널 = macOS SwiftUI 클라이언트(MomoMac), 수동 설치. 그 발행 스크립트
#     `scripts/publish_alpha_build.sh` 는 클라 트리와 함께 삭제됐다(W-S1 / #1215).
#     alpha 태그·자산·매니페스트는 배포 저장소에 남아 있으므로 아래 네임스페이스
#     분리는 계속 유효하다 — 겹치면 기존 설치본의 업데이트 경로가 흔들린다.
#   scripts/publish_next_build.sh   = Tauri 2 + React 셸(clients/desktop), 자동 업데이트
# 두 채널은 같은 배포 저장소(momo-alpha)를 쓰되 태그·자산·매니페스트가 겹치지 않는다.
#   alpha : 태그 v0.0.N        자산 momo-macos-0.0.N.zip        매니페스트 update-manifest-alpha.json
#   next  : 태그 next-v0.1.0-next.N  자산 momo-next-*.app.tar.gz/.zip  매니페스트 update-next.json
# 이 스크립트는 update-next.json 하나만 커밋한다. index.html / TESTER_GUIDE.md 는
# 손대지 않는다(사이트 문안은 사람이 반영).
#
# 성재 복붙 재발행 체크리스트(전제·dry-run·실발행·확인): docs/NEXT_CHANNEL.md §8.
# 공개 dmg(oort v0.x Release 자산, next 채널 아님): docs/RELEASING.md §데스크탑 dmg.
#
# 버전 규칙 (제안, ADR-0133)
#   0.1.0-next.N  = 오픈 베타(0.1.0)로 가는 프리릴리스 열차. semver 프리릴리스라
#                   0.1.0 보다 항상 낮게 정렬되고, alpha 채널의 0.0.x 와도 겹치지
#                   않는다. next 채널은 N 만 올린다.
#   0.1.0         = 오픈 베타 전환 시 1회 (성재 2026-07-23 규칙: minor 상승은 그때만).
#
# 신뢰 사슬
#   minisign  개인키 ~/.momo-secrets/momo-updater.key (레포 밖, 0600), 공개키는
#             tauri.conf.json 에 박혀 빌드에 컴파일된다. 서명 검증 실패 시 업데이터가
#             설치 자체를 하지 않으므로, Pages 가 털려도 코드는 못 넣는다.
#   Developer ID  codesign(hardened runtime) → notarytool → stapler. 업데이터가 받는
#             tar.gz 안의 .app 은 다운로드 페이지가 주는 .app 과 동일한 스테이플된
#             번들이다. 자동 업데이트 후 Gatekeeper 판정이 수동 설치와 같아야 한다.
#
# 실측 (2026-07-25, MOMO-606)
#   - 번들러 서명: APPLE_SIGNING_IDENTITY 환경변수로 동작. tauri.conf.json 에 넣지
#     않는 이유는 인증서 없는 개발 머신의 `cargo tauri build` 를 깨뜨리기 때문.
#   - 번들러 공증: APPLE_ID/APPLE_PASSWORD 또는 APPLE_API_KEY 자격을 요구한다.
#     우리가 가진 것은 notarytool 의 keychain 프로파일(momo-notary)뿐이고 거기서
#     app-specific password 를 뽑을 방법은 없다. 그래서 공증·스테이플은 alpha
#     스크립트와 같은 notarytool 경로를 재사용한다.
#   - 그 결과 업데이터 tar.gz 는 번들러가 만든 것(스테이플 이전)을 쓰지 않고,
#     스테이플이 끝난 .app 으로 다시 만들어 서명한다. tauri.conf.json 의
#     createUpdaterArtifacts 를 끈 이유가 이것이다: 켜 두면 버릴 아티팩트를 만들면서
#     빌드 시점에 minisign 개인키를 요구해, 키가 없는 개발 머신의 `cargo tauri build`
#     가 exit 1 로 죽는다(2026-07-25 실측).
set -euo pipefail

VERSION=""
NOTES=""
DRY_RUN=0
PUBLIC=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --version) VERSION="$2"; shift 2 ;;
    --notes) NOTES="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --public) PUBLIC=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
if [ "$PUBLIC" = "1" ]; then
  [ -n "$VERSION" ] || { echo "usage: $0 --public --version 0.1.0 [--notes ...] [--dry-run]" >&2; exit 2; }
else
  [ -n "$VERSION" ] || { echo "usage: $0 --version 0.1.0-next.N [--notes ...] [--dry-run]" >&2; exit 2; }
fi
if [ -z "$NOTES" ]; then
  if [ "$PUBLIC" = "1" ]; then
    NOTES="oort desktop ${VERSION}"
  else
    NOTES="oort next 내부 빌드 ${VERSION}"
  fi
fi

# next 채널은 semver 프리릴리스만. 0.1.0 을 실수로 next 채널에 밀면 오픈 베타
# 번호를 태워버리고 되돌릴 수 없다(업데이터는 내려가지 않는다).
# --public 은 그 반대: next.N 을 공개 Release 에 올리면 T-2 안정 URL 과
# 채널 번호가 섞인다. 두 갈래는 한 호출에서 만나지 않는다.
if [ "$PUBLIC" = "1" ]; then
  case "$VERSION" in
    *-next.*)
      echo "[next-publish] --public version must not use the next-channel series (got: $VERSION)" >&2
      exit 2
      ;;
    0.[0-9]*.[0-9]*)
      case "$VERSION" in
        *-*)
          echo "[next-publish] --public version must be a release like 0.1.0 (got: $VERSION)" >&2
          exit 2
          ;;
      esac
      ;;
    *)
      echo "[next-publish] --public version must look like 0.1.0 (got: $VERSION)" >&2
      exit 2
      ;;
  esac
else
  case "$VERSION" in
    *-next.[0-9]*) : ;;
    *) echo "[next-publish] version must look like 0.1.0-next.N (got: $VERSION)" >&2; exit 2 ;;
  esac
fi

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

DIST_REPO="${MOMO_DIST_REPO:-yeomyeonggeori/momo-alpha}"
# 발행 커밋의 author — 공개 레포에 개인 주소를 두지 않는다(#1224).
# 실제 발행자는 MOMO_PUBLISH_GIT_EMAIL로 주입한다.
PUBLISH_GIT_EMAIL="${MOMO_PUBLISH_GIT_EMAIL:-oort-release@users.noreply.github.com}"
MANIFEST_NAME="update-next.json"
TAG="next-v${VERSION}"
BUILD_NUM="$(git rev-list --count HEAD)"
GIT_SHA="$(git rev-parse --short HEAD)"

SIGN_IDENTITY="${MOMO_SIGN_IDENTITY:-Developer ID Application: Kwak Seongjae (YWQQFQM38J)}"
NOTARY_PROFILE="${MOMO_NOTARY_PROFILE:-momo-notary}"
UPDATER_KEY="${MOMO_UPDATER_KEY:-$HOME/.momo-secrets/momo-updater.key}"
UPDATER_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"

if [ "$PUBLIC" != "1" ]; then
  [ -f "$UPDATER_KEY" ] || {
    echo "[next-publish] updater private key not found: $UPDATER_KEY" >&2
    echo "  generate one with: cargo tauri signer generate -w $UPDATER_KEY" >&2
    echo "  and put the printed public key in clients/desktop/src-tauri/tauri.conf.json" >&2
    exit 2; }
fi

# 업데이터의 플랫폼 키는 {os}-{arch}. 빌드 머신의 아키텍처로 고정한다 — 크로스
# 아키텍처를 한 줄로 우겨넣는 것보다, 어느 아키텍처를 발행했는지 매니페스트에
# 정확히 남기는 편이 낫다.
case "$(uname -m)" in
  arm64) UPDATER_TARGET="darwin-aarch64" ;;
  x86_64) UPDATER_TARGET="darwin-x86_64" ;;
  *) echo "[next-publish] unsupported architecture: $(uname -m)" >&2; exit 2 ;;
esac

WORK="$(mktemp -d "${TMPDIR:-/tmp}/momo-next-build.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT INT TERM

echo "[next-publish] 1/6 build (v${VERSION}, build ${BUILD_NUM} @${GIT_SHA}, ${UPDATER_TARGET}, app+dmg)"
# --config 로 버전을 주입한다: 발행 때마다 tauri.conf.json 을 커밋하지 않아도 되고,
# 앱이 스스로 보고하는 버전과 매니페스트가 갈라질 수 없다(같은 값에서 나온다).
# MOMO_CHANNEL_BUILD=1: 로컬 `cargo tauri build` 는 매니페스트보다 낮은 베이스라인
# 버전(0.1.0-next.1)을 심고 기동 즉시 롤백을 제안한다(#1281). 채널 산출물만
# 업데이터 체크를 연다. 이 환경변수를 빼면 발행된 앱이 업데이트를 안 받는다.
# --public 은 next 매니페스트를 보지 않는다(공개 0.1.0 이 내부 next.N 을
# "업데이트"로 제안하지 않게).
# --bundles app,dmg: next 채널 .app 경로는 불변(`bundle/macos/oort.app`). dmg 는
# 같은 빌드의 가산 산출이다. `--bundles app` 만 주면 conf 의 dmg 타깃을 덮어
# 공개 산출이 안 나온다.
(
  cd clients/desktop
  if [ "$PUBLIC" = "1" ]; then
    APPLE_SIGNING_IDENTITY="$SIGN_IDENTITY" \
    cargo tauri build --bundles app,dmg --ci --config "{\"version\":\"${VERSION}\"}"
  else
    APPLE_SIGNING_IDENTITY="$SIGN_IDENTITY" \
    MOMO_CHANNEL_BUILD=1 \
    cargo tauri build --bundles app,dmg --ci --config "{\"version\":\"${VERSION}\"}"
  fi
) > "$WORK/build.log" 2>&1 || { tail -40 "$WORK/build.log" >&2; exit 1; }

APP_PATH="clients/desktop/src-tauri/target/release/bundle/macos/oort.app"
[ -d "$APP_PATH" ] || { echo "[next-publish] .app not found at $APP_PATH" >&2; exit 1; }

# Tauri 2: bundle/dmg/{productName}_{version}_{arch}.dmg
# version 뒤에 바로 `_` 가 오므로 0.1.0 이 0.1.0-next.N 을 먹지 않는다.
DMG_DIR="clients/desktop/src-tauri/target/release/bundle/dmg"
DMG_PATH=""
if [ -d "$DMG_DIR" ]; then
  for f in "$DMG_DIR"/oort_"${VERSION}"_*.dmg; do
    [ -f "$f" ] || continue
    DMG_PATH="$f"
  done
fi
[ -n "$DMG_PATH" ] && [ -f "$DMG_PATH" ] || {
  echo "[next-publish] .dmg not found under $DMG_DIR for version ${VERSION}" >&2
  ls -la "$DMG_DIR" 2>/dev/null >&2 || true
  exit 1
}

echo "[next-publish] 2/6 verify signature (.app + .dmg)"
codesign --verify --strict --deep "$APP_PATH" 2>>"$WORK/codesign.log" || {
  tail -20 "$WORK/codesign.log" >&2
  echo "[next-publish] the bundler did not produce a valid signature (APPLE_SIGNING_IDENTITY?)" >&2
  exit 1; }
codesign -dv --verbose=2 "$APP_PATH" 2>&1 | grep -E "^(Identifier|Authority|TeamIdentifier|Runtime)" || true

# dmg 는 번들러가 이미 서명했을 수도 있고 아닐 수도 있다. --strict 가 실패하면
# Developer ID 로 한 번 서명하고 다시 잰다. --deep 은 디스크 이미지에 쓰지 않는다.
if ! codesign --verify --strict "$DMG_PATH" >/dev/null 2>&1; then
  echo "[next-publish] signing dmg (bundler left it unsigned or invalid)"
  codesign --force --sign "$SIGN_IDENTITY" --timestamp "$DMG_PATH" \
    >>"$WORK/codesign.log" 2>&1 || {
      tail -20 "$WORK/codesign.log" >&2
      echo "[next-publish] dmg codesign failed" >&2
      exit 1
    }
fi
codesign --verify --strict "$DMG_PATH" 2>>"$WORK/codesign.log" || {
  tail -20 "$WORK/codesign.log" >&2
  echo "[next-publish] dmg failed codesign --verify --strict" >&2
  exit 1
}
codesign -dv --verbose=2 "$DMG_PATH" 2>&1 | grep -E "^(Identifier|Authority|TeamIdentifier|Format)" || true

if [ "$DRY_RUN" = "1" ]; then
  echo "[next-publish] dry run: stopping before notarization."
  echo "  app at $APP_PATH"
  echo "  dmg at $DMG_PATH"
  exit 0
fi

if [ "$PUBLIC" = "1" ]; then
  echo "[next-publish] public dmg: notarize + staple (no next-channel upload)"
  ditto -c -k --keepParent "$APP_PATH" "$WORK/notarize.zip"
  xcrun notarytool submit "$WORK/notarize.zip" --keychain-profile "$NOTARY_PROFILE" \
    --wait --timeout 120m > "$WORK/notary.log" 2>&1 || {
      tail -30 "$WORK/notary.log" >&2
      echo "[next-publish] notarization failed (xcrun notarytool log <id> --keychain-profile $NOTARY_PROFILE)" >&2
      exit 1; }
  grep -q "status: Accepted" "$WORK/notary.log" || { tail -30 "$WORK/notary.log" >&2; exit 1; }
  xcrun stapler staple "$APP_PATH" >> "$WORK/notary.log" 2>&1 || { echo "[next-publish] staple failed" >&2; exit 1; }

  # 스테이플이 끝난 .app 으로 dmg 를 다시 만든다. 번들러 dmg 는 스테이플 이전
  # 사본을 담는다. --srcfolder 에 .app 을 직접 주면 번들 내용이 볼륨 루트가 된다.
  STABLE_DMG="$DMG_DIR/oort-macos-${UPDATER_TARGET#darwin-}.dmg"
  DMG_STAGE="$WORK/dmgroot"
  mkdir -p "$DMG_STAGE"
  cp -R "$APP_PATH" "$DMG_STAGE/"
  rm -f "$STABLE_DMG"
  hdiutil create -volname oort -srcfolder "$DMG_STAGE" -ov -format UDZO \
    "$STABLE_DMG" >> "$WORK/notary.log" 2>&1 || {
      echo "[next-publish] hdiutil create dmg failed" >&2
      exit 1
    }
  codesign --force --sign "$SIGN_IDENTITY" --timestamp "$STABLE_DMG" \
    >>"$WORK/codesign.log" 2>&1
  codesign --verify --strict "$STABLE_DMG" 2>>"$WORK/codesign.log" || {
    echo "[next-publish] restapled dmg failed codesign --verify --strict" >&2
    exit 1
  }
  xcrun notarytool submit "$STABLE_DMG" --keychain-profile "$NOTARY_PROFILE" \
    --wait --timeout 120m > "$WORK/notary-dmg.log" 2>&1 || {
      tail -30 "$WORK/notary-dmg.log" >&2
      echo "[next-publish] dmg notarization failed" >&2
      exit 1; }
  grep -q "status: Accepted" "$WORK/notary-dmg.log" || { tail -30 "$WORK/notary-dmg.log" >&2; exit 1; }
  xcrun stapler staple "$STABLE_DMG" >> "$WORK/notary-dmg.log" 2>&1 || {
    echo "[next-publish] dmg staple failed" >&2
    exit 1
  }
  echo "[next-publish] public dmg ready: $STABLE_DMG"
  echo "  attach (orchestrator — this script does not upload):"
  echo "  gh release upload v${VERSION} --repo yeomyeonggeori/oort $STABLE_DMG"
  echo "  stable URL: https://github.com/yeomyeonggeori/oort/releases/latest/download/$(basename "$STABLE_DMG")"
  exit 0
fi

echo "[next-publish] 3/6 notarize + staple (profile ${NOTARY_PROFILE})"
# next 채널은 .app 만 공증한다. dmg 는 공개 릴리스(--public) 경로이고 momo-alpha
# 업데이터 자산이 아니다(zip + .app.tar.gz 만 올린다).
# 공증은 zip 으로 제출하고, 성공하면 .app 에 티켓을 스테이플한다. 신규 팀의 첫
# 공증은 1시간을 넘길 수 있다(2026-07-24 실측).
ditto -c -k --keepParent "$APP_PATH" "$WORK/notarize.zip"
xcrun notarytool submit "$WORK/notarize.zip" --keychain-profile "$NOTARY_PROFILE" \
  --wait --timeout 120m > "$WORK/notary.log" 2>&1 || {
    tail -30 "$WORK/notary.log" >&2
    echo "[next-publish] notarization failed (xcrun notarytool log <id> --keychain-profile $NOTARY_PROFILE)" >&2
    exit 1; }
grep -q "status: Accepted" "$WORK/notary.log" || { tail -30 "$WORK/notary.log" >&2; exit 1; }
xcrun stapler staple "$APP_PATH" >> "$WORK/notary.log" 2>&1 || { echo "[next-publish] staple failed" >&2; exit 1; }
spctl -a -t exec -vv "$APP_PATH" 2>&1 | grep -q "accepted" \
  && echo "[next-publish] Gatekeeper: accepted" \
  || echo "[next-publish] warn: spctl not accepted (오프라인 평가일 수 있음)"

echo "[next-publish] 4/6 package (updater tar.gz + first-install zip)"
STAGE="$WORK/stage"; mkdir -p "$STAGE"
# 스테이플이 끝난 .app 으로 다시 만든다. 번들러가 만들어 둔 tar.gz 는 스테이플
# 이전 상태라, 그대로 배포하면 자동 업데이트한 사람만 공증 티켓 없는 앱을 받는다.
TARBALL="$WORK/momo-next-${VERSION}-${UPDATER_TARGET}.app.tar.gz"
# COPYFILE_DISABLE: macOS tar 는 확장속성을 ._ AppleDouble 파일로 흘려 넣는다.
# 업데이터의 tar 구현은 그것을 실제 파일로 풀어서 서명을 깨뜨린다.
COPYFILE_DISABLE=1 tar -czf "$TARBALL" \
  -C "$(dirname "$APP_PATH")" "$(basename "$APP_PATH")"

# 왕복 검증: 실제로 풀어서 서명·공증이 살아남았는지 본다. 업데이터가 하는 일과
# 같은 순서(풀기 → 실행)이므로, 여기서 통과하지 못하면 테스터에게서도 실패한다.
VERIFY="$WORK/verify"; mkdir -p "$VERIFY"
tar -xzf "$TARBALL" -C "$VERIFY"
codesign --verify --strict --deep "$VERIFY/$(basename "$APP_PATH")" \
  || { echo "[next-publish] tar round trip broke the signature" >&2; exit 1; }
xcrun stapler validate "$VERIFY/$(basename "$APP_PATH")" \
  || { echo "[next-publish] tar round trip lost the notarization ticket" >&2; exit 1; }
echo "[next-publish] tar round trip: signature + staple intact"

# `signer sign` writes <file>.sig holding exactly the base64 blob the manifest's
# `signature` field wants, so it is read from the file rather than scraped out of
# the command's stdout.
cargo tauri signer sign -f "$UPDATER_KEY" -p "$UPDATER_KEY_PASSWORD" "$TARBALL" > "$WORK/sign.log" 2>&1 \
  || { tail -10 "$WORK/sign.log" >&2; exit 1; }
SIGNATURE="$(tr -d '\n' < "${TARBALL}.sig")"
[ -n "$SIGNATURE" ] || { echo "[next-publish] minisign signing produced no signature" >&2; exit 1; }

# 처음 설치하는 사람은 tar.gz 가 아니라 더블클릭할 수 있는 zip 을 받는다.
cp -R "$APP_PATH" "$STAGE/"
cp LICENSE NOTICE legal/THIRD_PARTY_NOTICES.md "$STAGE/"
ZIP_NAME="momo-next-${VERSION}-${UPDATER_TARGET}.zip"
ditto -c -k "$STAGE" "$WORK/$ZIP_NAME"
ZIP_SHA256="$(shasum -a 256 "$WORK/$ZIP_NAME" | cut -d' ' -f1)"

echo "[next-publish] 5/6 release upload to $DIST_REPO ($TAG)"
gh release create "$TAG" --repo "$DIST_REPO" --prerelease \
  --title "oort next ${VERSION}" \
  --notes "${NOTES}

- channel: next (Tauri 2 셸, 자동 업데이트)
- build: ${BUILD_NUM} (source ${GIT_SHA}, private repo)
- zip sha256: \`${ZIP_SHA256}\`
- Developer ID 서명 + 공증 + 스테이플: 더블클릭으로 바로 실행됩니다" \
  "$TARBALL" "$WORK/$ZIP_NAME" 2>/dev/null \
  || gh release upload "$TAG" --repo "$DIST_REPO" --clobber "$TARBALL" "$WORK/$ZIP_NAME"

TARBALL_URL="https://github.com/${DIST_REPO}/releases/download/${TAG}/$(basename "$TARBALL")"
ZIP_URL="https://github.com/${DIST_REPO}/releases/download/${TAG}/${ZIP_NAME}"

echo "[next-publish] 6/6 manifest ($MANIFEST_NAME)"
PAGES="$WORK/pages"
git clone -q "https://github.com/${DIST_REPO}" "$PAGES"
PUB_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
MOMO_VERSION="$VERSION" MOMO_NOTES="$NOTES" MOMO_PUB_DATE="$PUB_DATE" \
MOMO_TARGET="$UPDATER_TARGET" MOMO_SIGNATURE="$SIGNATURE" MOMO_URL="$TARBALL_URL" \
python3 - "$PAGES/$MANIFEST_NAME" <<'PY'
import json, os, pathlib, sys

path = pathlib.Path(sys.argv[1])
# 다른 아키텍처(darwin-x86_64 등) 항목은 보존한다. 한 머신에서 발행한다고 다른
# 머신의 테스터를 매니페스트에서 지워버리면 그쪽 채널이 조용히 멈춘다.
previous = json.loads(path.read_text()) if path.exists() else {}
platforms = previous.get("platforms", {}) if isinstance(previous, dict) else {}
platforms[os.environ["MOMO_TARGET"]] = {
    "signature": os.environ["MOMO_SIGNATURE"],
    "url": os.environ["MOMO_URL"],
}
manifest = {
    "version": os.environ["MOMO_VERSION"],
    "notes": os.environ["MOMO_NOTES"],
    "pub_date": os.environ["MOMO_PUB_DATE"],
    "platforms": platforms,
}
path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
PY
(
  cd "$PAGES"
  git add "$MANIFEST_NAME"
  git -c user.name=momo-main -c user.email="$PUBLISH_GIT_EMAIL" \
    commit -qm "next: publish ${VERSION} (build ${BUILD_NUM})"
  git push -q
)

echo "[next-publish] done"
echo "  updater:  $TARBALL_URL"
echo "  download: $ZIP_URL"
echo "  manifest: https://yeomyeonggeori.github.io/momo-alpha/${MANIFEST_NAME}"
echo "  zip sha256: $ZIP_SHA256"

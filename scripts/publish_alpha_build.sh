#!/usr/bin/env bash
# 내부 알파 macOS 빌드 발행 (2026-07-23 내부 테스트 전환 §1).
#
#   scripts/publish_alpha_build.sh --version 0.0.1 [--notes "..."] [MOMO_SIGN=0 폴백]
#
# 버전 규칙 (성재 2026-07-23): 내부 빌드는 0.0.1부터 시작해 0.0.2, 0.0.3...
# patch를 계속 올린다. **오픈 베타 전환 시에만 0.1.0**. 그 전에는 minor를 올리지
# 않는다(0.0.x 역전 방지 — 이전 0.5.0-alpha 태그는 폐기됨).
#
# 절차: unsigned Release 앱 빌드 → LICENSE/NOTICE/THIRD_PARTY 동봉 zip+SHA-256 →
# momo-alpha(공개 배포 저장소) Release 자산 업로드 → Pages의
# update-manifest-alpha.json 갱신 → 인앱 Updates 채널(MOMO-244)이 소비.
# 소스는 유통하지 않는다 — 바이너리·라이선스 문서만.
set -euo pipefail

VERSION=""
NOTES="internal alpha build"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --version) VERSION="$2"; shift 2 ;;
    --notes) NOTES="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
[ -n "$VERSION" ] || { echo "usage: $0 --version X.Y.Z-alpha.N [--notes ...]" >&2; exit 2; }

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"
DIST_REPO="Dawn-kim-official/momo-alpha"
BUILD_NUM="$(git rev-list --count HEAD)"
GIT_SHA="$(git rev-parse --short HEAD)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/momo-alpha-build.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT INT TERM

# 서명/공증(W-O6, 2026-07-24 성재 인증서 준비 완료). 기본=서명 배포.
# 비상시 MOMO_SIGN=0 으로 구버전(unsigned) 경로 폴백.
SIGN="${MOMO_SIGN:-1}"
SIGN_IDENTITY="${MOMO_SIGN_IDENTITY:-Developer ID Application: Kwak Seongjae (YWQQFQM38J)}"
NOTARY_PROFILE="${MOMO_NOTARY_PROFILE:-momo-notary}"

echo "[alpha-publish] 1/5 Release build (v${VERSION} build ${BUILD_NUM} @${GIT_SHA}, sign=${SIGN})"
xcodebuild -project clients/macOS/MomoMac.xcodeproj -scheme MomoMac -configuration Release \
  -derivedDataPath "$WORK/dd" \
  CODE_SIGNING_ALLOWED=NO CODE_SIGN_IDENTITY="" \
  MARKETING_VERSION="$VERSION" CURRENT_PROJECT_VERSION="$BUILD_NUM" \
  build > "$WORK/xcodebuild.log" 2>&1 || { tail -30 "$WORK/xcodebuild.log" >&2; exit 1; }

APP_PATH="$(find "$WORK/dd/Build/Products/Release" -maxdepth 1 -name '*.app' | head -1)"
[ -n "$APP_PATH" ] || { echo "[alpha-publish] .app not found" >&2; exit 1; }

if [ "$SIGN" = "1" ]; then
  echo "[alpha-publish] 1b/5 codesign (hardened runtime) + notarize + staple"
  # 내부 중첩 코드(프레임워크/dylib/헬퍼)를 먼저, 앱 번들을 마지막에 서명한다.
  while IFS= read -r nested; do
    codesign --force --options runtime --timestamp \
      --sign "$SIGN_IDENTITY" "$nested" 2>>"$WORK/codesign.log" || {
        echo "[alpha-publish] nested codesign failed: $nested" >&2; exit 1; }
  done < <(find "$APP_PATH" -type d \( -name '*.framework' -o -name '*.xpc' -o -name '*.appex' \) ; \
           find "$APP_PATH" -type f \( -name '*.dylib' \))
  codesign --force --options runtime --timestamp \
    --sign "$SIGN_IDENTITY" "$APP_PATH" >> "$WORK/codesign.log" 2>&1 || {
      tail -20 "$WORK/codesign.log" >&2; exit 1; }
  codesign --verify --strict --deep "$APP_PATH" || { echo "[alpha-publish] codesign verify failed" >&2; exit 1; }

  # 공증은 zip으로 제출하고, 성공 후 앱에 스테이플 → 최종 배포 zip을 다시 만든다.
  ditto -c -k --keepParent "$APP_PATH" "$WORK/notarize.zip"
  xcrun notarytool submit "$WORK/notarize.zip" --keychain-profile "$NOTARY_PROFILE" \
    --wait --timeout 30m > "$WORK/notary.log" 2>&1 || {
      tail -30 "$WORK/notary.log" >&2
      echo "[alpha-publish] notarization failed — 로그를 확인하세요 (xcrun notarytool log <id> --keychain-profile $NOTARY_PROFILE)" >&2
      exit 1; }
  grep -q "status: Accepted" "$WORK/notary.log" || { tail -30 "$WORK/notary.log" >&2; exit 1; }
  xcrun stapler staple "$APP_PATH" >> "$WORK/notary.log" 2>&1 || { echo "[alpha-publish] staple failed" >&2; exit 1; }
  spctl -a -t exec -vv "$APP_PATH" 2>&1 | grep -q "accepted" && echo "[alpha-publish] Gatekeeper: accepted" \
    || echo "[alpha-publish] warn: spctl not accepted (오프라인 평가일 수 있음)"
fi

echo "[alpha-publish] 2/5 packaging with LICENSE/NOTICE/THIRD_PARTY"
STAGE="$WORK/stage"; mkdir -p "$STAGE"
cp -R "$APP_PATH" "$STAGE/"
cp LICENSE NOTICE legal/THIRD_PARTY_NOTICES.md "$STAGE/"
ZIP_NAME="momo-macos-${VERSION}.zip"
# ditto가 서명/스테이플 메타데이터(리소스 포크·xattr)를 보존한다 — zip -qry는 유실 위험.
# --keepParent 없이 스테이징 내용물이 zip 루트에 오도록.
ditto -c -k "$STAGE" "$WORK/$ZIP_NAME"
SHA256="$(shasum -a 256 "$WORK/$ZIP_NAME" | cut -d' ' -f1)"
echo "[alpha-publish] sha256=$SHA256"

echo "[alpha-publish] 3/5 release upload to $DIST_REPO"
TAG="v${VERSION}"
gh release create "$TAG" --repo "$DIST_REPO" --title "momo ${VERSION} (internal alpha)" \
  --notes "${NOTES}

- build: ${BUILD_NUM} (source ${GIT_SHA}, private repo)
- sha256: \`${SHA256}\`
$([ "$SIGN" = "1" ] && echo "- Developer ID signed + notarized: 더블클릭으로 바로 실행됩니다" || echo "- unsigned internal build: install per the download page instructions")" \
  "$WORK/$ZIP_NAME" 2>/dev/null || gh release upload "$TAG" --repo "$DIST_REPO" --clobber "$WORK/$ZIP_NAME"
DOWNLOAD_URL="https://github.com/${DIST_REPO}/releases/download/${TAG}/${ZIP_NAME}"

echo "[alpha-publish] 4/5 manifest + page push"
PAGES="$WORK/pages"
git clone -q "https://github.com/${DIST_REPO}" "$PAGES"
RELEASED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
MANIFEST_NOTES="$NOTES" MANIFEST_SIGNED="$SIGN" python3 - "$PAGES/update-manifest-alpha.json" <<PY
import json, os, sys
signed = os.environ.get("MANIFEST_SIGNED") == "1"
steps = [
    "Download and unzip the new build.",
    "Replace the app in /Applications and relaunch."
    if signed
    else "Replace the app in /Applications, then right-click > Open on first launch.",
    "Reopen Updates to confirm the new build.",
]
manifest = {
    "schema_version": 1,
    "channel": "alpha",
    "version": "${VERSION}",
    "build": "${BUILD_NUM}",
    "released_at": "${RELEASED_AT}",
    "minimum_macos": "14.0",
    "summary": os.environ["MANIFEST_NOTES"],
    "download_url": "${DOWNLOAD_URL}",
    "release_notes_url": "https://github.com/${DIST_REPO}/releases/tag/${TAG}",
    "sha256": "${SHA256}",
    "signed": signed,
    "restart_instructions": steps,
}
json.dump(manifest, open(sys.argv[1], "w"), ensure_ascii=False, indent=2)
PY
(cd "$PAGES" && git add update-manifest-alpha.json && \
 git -c user.name=momo-main -c user.email=gkffhdnls13@gmail.com commit -qm "publish ${VERSION} (build ${BUILD_NUM})" && git push -q)

echo "[alpha-publish] 5/5 done"
echo "  download: $DOWNLOAD_URL"
echo "  page:     https://dawn-kim-official.github.io/momo-alpha/"
echo "  sha256:   $SHA256"

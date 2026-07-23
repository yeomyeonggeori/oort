#!/usr/bin/env bash
# 내부 알파 macOS 빌드 발행 (2026-07-23 내부 테스트 전환 §1).
#
#   scripts/publish_alpha_build.sh --version 0.5.0-alpha.1 [--notes "..."]
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

echo "[alpha-publish] 1/5 unsigned Release build (v${VERSION} build ${BUILD_NUM} @${GIT_SHA})"
xcodebuild -project clients/macOS/MomoMac.xcodeproj -scheme MomoMac -configuration Release \
  -derivedDataPath "$WORK/dd" \
  CODE_SIGNING_ALLOWED=NO CODE_SIGN_IDENTITY="" \
  MARKETING_VERSION="$VERSION" CURRENT_PROJECT_VERSION="$BUILD_NUM" \
  build > "$WORK/xcodebuild.log" 2>&1 || { tail -30 "$WORK/xcodebuild.log" >&2; exit 1; }

APP_PATH="$(find "$WORK/dd/Build/Products/Release" -maxdepth 1 -name '*.app' | head -1)"
[ -n "$APP_PATH" ] || { echo "[alpha-publish] .app not found" >&2; exit 1; }

echo "[alpha-publish] 2/5 packaging with LICENSE/NOTICE/THIRD_PARTY"
STAGE="$WORK/stage"; mkdir -p "$STAGE"
cp -R "$APP_PATH" "$STAGE/"
cp LICENSE NOTICE legal/THIRD_PARTY_NOTICES.md "$STAGE/"
ZIP_NAME="momo-macos-${VERSION}.zip"
(cd "$STAGE" && zip -qry "$WORK/$ZIP_NAME" .)
SHA256="$(shasum -a 256 "$WORK/$ZIP_NAME" | cut -d' ' -f1)"
echo "[alpha-publish] sha256=$SHA256"

echo "[alpha-publish] 3/5 release upload to $DIST_REPO"
TAG="v${VERSION}"
gh release create "$TAG" --repo "$DIST_REPO" --title "momo ${VERSION} (internal alpha)" \
  --notes "${NOTES}

- build: ${BUILD_NUM} (source ${GIT_SHA}, private repo)
- sha256: \`${SHA256}\`
- unsigned internal build — install per the download page instructions" \
  "$WORK/$ZIP_NAME" 2>/dev/null || gh release upload "$TAG" --repo "$DIST_REPO" --clobber "$WORK/$ZIP_NAME"
DOWNLOAD_URL="https://github.com/${DIST_REPO}/releases/download/${TAG}/${ZIP_NAME}"

echo "[alpha-publish] 4/5 manifest + page push"
PAGES="$WORK/pages"
git clone -q "https://github.com/${DIST_REPO}" "$PAGES"
RELEASED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
MANIFEST_NOTES="$NOTES" python3 - "$PAGES/update-manifest-alpha.json" <<PY
import json, os, sys
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
    "restart_instructions": [
        "Download and unzip the new build.",
        "Replace the app in /Applications, then right-click > Open on first launch.",
        "Relaunch momo and reopen Updates to confirm the new build.",
    ],
}
json.dump(manifest, open(sys.argv[1], "w"), ensure_ascii=False, indent=2)
PY
(cd "$PAGES" && git add update-manifest-alpha.json && \
 git -c user.name=momo-main -c user.email=gkffhdnls13@gmail.com commit -qm "publish ${VERSION} (build ${BUILD_NUM})" && git push -q)

echo "[alpha-publish] 5/5 done"
echo "  download: $DOWNLOAD_URL"
echo "  page:     https://dawn-kim-official.github.io/momo-alpha/"
echo "  sha256:   $SHA256"

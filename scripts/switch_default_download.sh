#!/usr/bin/env bash
# 기본 다운로드 전환 (ADR-0133 parity 게이트 통과 후 1회 + 이후 next.N 갱신).
#
#   scripts/switch_default_download.sh --version 0.1.0-next.7 --sha256 <zip sha256>
#
# momo-alpha(공개 배포 저장소)의 update-manifest-alpha.json — 정적 사이트의
# 다운로드 버튼 3곳(#dl/#dl-nav/#dl-foot)이 소비하는 유일한 정본 — 을
# Tauri(momo-next) 빌드로 교체한다. 구 SwiftUI 최종 빌드는 legacy 블록으로 보존.
# publish_next_build.sh 와 동일한 clone→rewrite→commit→push 경로.
set -euo pipefail

VERSION=""; SHA256=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --version) VERSION="$2"; shift 2 ;;
    --sha256) SHA256="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
[ -n "$VERSION" ] && [ -n "$SHA256" ] || { echo "usage: $0 --version 0.1.0-next.N --sha256 <hex>" >&2; exit 2; }
case "$VERSION" in *-next.*) ;; *) echo "version must be a -next.N build" >&2; exit 2 ;; esac

DIST_REPO="yeomyeonggeori/momo-alpha"
# 발행 커밋의 author — 공개 레포에 개인 주소를 두지 않는다(#1224).
# 실제 발행자는 MOMO_PUBLISH_GIT_EMAIL로 주입한다.
PUBLISH_GIT_EMAIL="${MOMO_PUBLISH_GIT_EMAIL:-oort-release@users.noreply.github.com}"
REPO_ROOT="$(git rev-parse --show-toplevel)"
BUILD_NUM="$(git -C "$REPO_ROOT" rev-list --count HEAD)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/momo-switch.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT INT TERM

git clone -q "https://github.com/${DIST_REPO}" "$WORK/pages"
RELEASED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
VERSION="$VERSION" SHA256="$SHA256" BUILD_NUM="$BUILD_NUM" RELEASED_AT="$RELEASED_AT" \
python3 - "$WORK/pages/update-manifest-alpha.json" <<'PY'
import json, os, sys
path = sys.argv[1]
old = json.load(open(path))
version = os.environ["VERSION"]
tag = f"next-v{version}"
zip_name = f"momo-next-{version}-darwin-aarch64.zip"
base = "https://github.com/yeomyeonggeori/momo-alpha/releases/download"
# 최초 전환 시에만 구 SwiftUI 항목을 legacy로 보존, 이후 갱신은 기존 legacy 유지.
legacy = old.get("legacy")
if legacy is None and not str(old.get("version", "")).startswith("0.1.0-next"):
    legacy = {
        "app": "oort (SwiftUI, retired)",
        "version": old.get("version"),
        "download_url": old.get("download_url"),
        "note": "구 앱 최종 빌드입니다. 신규 설치는 기본 다운로드를 사용하세요.",
    }
manifest = {
    "schema_version": 1,
    "channel": "default",
    "app": "oort (Tauri)",
    "version": version,
    "build": os.environ["BUILD_NUM"],
    "released_at": os.environ["RELEASED_AT"],
    "minimum_macos": "14.0",
    "summary": "기본 다운로드가 새 oort 앱입니다. 이후 업데이트는 앱 안에서 자동으로 안내됩니다.",
    "download_url": f"{base}/{tag}/{zip_name}",
    "release_notes_url": f"https://github.com/yeomyeonggeori/momo-alpha/releases/tag/{tag}",
    "sha256": os.environ["SHA256"],
    "signed": True,
    "restart_instructions": [
        "Download and unzip the new build.",
        "Move oort.app into /Applications and launch.",
        "In-app updates keep you current from here.",
    ],
}
if legacy:
    manifest["legacy"] = legacy
json.dump(manifest, open(path, "w"), ensure_ascii=False, indent=2)
PY
(cd "$WORK/pages" && git add update-manifest-alpha.json && \
 git -c user.name=momo-main -c user.email="$PUBLISH_GIT_EMAIL" \
   commit -qm "switch default download to momo-next ${VERSION} (Tauri)" && git push -q)
echo "[switch] done — default download is now momo-next ${VERSION}"
echo "  verify: https://yeomyeonggeori.github.io/momo-alpha/update-manifest-alpha.json"

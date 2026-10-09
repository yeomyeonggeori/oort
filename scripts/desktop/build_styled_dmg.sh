#!/usr/bin/env bash
# 설치 창 배경·창 크기·아이콘 위치(.DS_Store)를 입힌 DMG를 만든다(#3642).
#   build_styled_dmg.sh <stage-dir> <out.dmg>
# stage-dir: oort.app 이 들어 있는 폴더(Applications 링크는 여기서 만든다).
# publish_next_build.sh 가 서명(·스테이플)한 앱으로 DMG 를 다시 만들 때 쓴다. Tauri 번들러
# DMG 와 같은 값이다: clients/desktop/src-tauri/tauri.conf.json bundle.macOS.dmg.
# 순서: 읽기-쓰기 DMG → 마운트 → 배경 복사 → Finder 로 레이아웃 → 분리 → UDZO 변환.
# 기존 시스템 도구(hdiutil, osascript/Finder)만 쓴다. 로그인한 GUI 세션이 필요하다.
set -euo pipefail
STAGE=${1:?stage dir}; OUT=${2:?out dmg}
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BG="$ROOT/clients/desktop/src-tauri/dmg/background.tiff"
[ -f "$BG" ] || { echo "background.tiff 가 없어요: $BG" >&2; exit 1; }
APP=$(cd "$STAGE" && ls -d *.app | head -1)
[ -n "$APP" ] || { echo "$STAGE 에 .app 이 없어요" >&2; exit 1; }
WORK=$(mktemp -d "${TMPDIR:-/tmp}/oort-dmg.XXXXXX")
MNT=""
cleanup() { [ -n "$MNT" ] && hdiutil detach "$MNT" -force -quiet 2>/dev/null || true; rm -rf "$WORK"; }
trap cleanup EXIT INT TERM
SIZE_KB=$(du -sk "$STAGE" | awk '{print $1}')
RW="$WORK/rw.dmg"
hdiutil create -volname oort -srcfolder "$STAGE" -ov -fs HFS+ -format UDRW \
  -size "$(( SIZE_KB * 12 / 10 / 1024 + 20 ))m" "$RW" >/dev/null
MNT=$(hdiutil attach "$RW" -readwrite -noverify -noautoopen -mountrandom "$WORK" | awk -F'\t' '/Apple_HFS/{print $NF}' | head -1)
[ -d "$MNT" ] || { echo "마운트 실패" >&2; exit 1; }
[ -e "$MNT/Applications" ] || ln -s /Applications "$MNT/Applications"
mkdir -p "$MNT/.background"
cp "$BG" "$MNT/.background/background.tiff"
# 마운트 지점이 무작위 경로라 Finder 의 disk 이름은 볼륨 이름(oort)이다.
# 같은 이름 볼륨이 이미 열려 있으면 위치를 못 맞추므로 미리 확인한다.
[ "$(diskutil info "$MNT" | awk -F': *' '/Volume Name/{print $2}')" = "oort" ] || { echo "볼륨 이름 확인 실패" >&2; exit 1; }
osascript <<OSA
tell application "Finder"
  set d to (POSIX file "$MNT" as alias)
  open d
  set w to container window of d
  set current view of w to icon view
  set toolbar visible of w to false
  set statusbar visible of w to false
  set bounds of w to {200, 120, 860, 552}
  set o to icon view options of w
  set arrangement of o to not arranged
  set icon size of o to 128
  set text size of o to 12
  set background picture of o to (POSIX file "$MNT/.background/background.tiff" as alias)
  set position of item "$APP" of d to {180, 185}
  set position of item "Applications" of d to {480, 185}
  update d without registering applications
  delay 2
  close w
end tell
OSA
sync; sleep 1
[ -f "$MNT/.DS_Store" ] || { echo ".DS_Store 가 안 만들어졌어요" >&2; exit 1; }
hdiutil detach "$MNT" -quiet; MNT=""
rm -f "$OUT"
hdiutil convert "$RW" -format UDZO -imagekey zlib-level=9 -o "$OUT" >/dev/null
echo "styled dmg: $OUT"

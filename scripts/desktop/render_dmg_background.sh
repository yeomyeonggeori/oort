#!/usr/bin/env bash
# oort DMG 설치 창 배경 래스터를 SVG 정본에서 다시 만든다(#3642).
#   scripts/desktop/render_dmg_background.sh          # 다시 만들기
#   scripts/desktop/render_dmg_background.sh --check  # 커밋된 TIFF가 SVG에서 나온 것과 같은지만 본다
# 쓰는 도구: rsvg-convert(brew librsvg), tiffutil(macOS 기본). 새 의존성 없음.
# 산출: clients/desktop/src-tauri/dmg/background.tiff — 72dpi @1x(660x400) + 144dpi @2x(1320x800)를
# 한 파일에 담은 멀티 해상도 TIFF. Finder가 레티나에서 @2x 를 고른다. tauri.conf.json 이 이 파일을 가리킨다.
set -euo pipefail
cd "$(dirname "$0")/../.."
DIR=clients/desktop/src-tauri/dmg
SVG=$DIR/background.svg
OUT=$DIR/background.tiff
command -v rsvg-convert >/dev/null || { echo "rsvg-convert 가 필요해요(brew install librsvg)" >&2; exit 1; }
command -v tiffutil >/dev/null || { echo "tiffutil 이 필요해요(macOS)" >&2; exit 1; }
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
rsvg-convert -w 660 -h 400 --dpi-x 72 --dpi-y 72 "$SVG" -o "$WORK/bg.png"
rsvg-convert -w 1320 -h 800 --dpi-x 144 --dpi-y 144 "$SVG" -o "$WORK/bg@2x.png"
tiffutil -cathidpicheck "$WORK/bg.png" "$WORK/bg@2x.png" -out "$WORK/background.tiff" 2>/dev/null
if [ "${1:-}" = "--check" ]; then
  # 재현성 확인: 픽셀을 같은 도구로 다시 뽑아 크기와 해상도 2종을 본다.
  n=$(tiffutil -info "$OUT" 2>&1 | grep -c 'Image Width')
  [ "$n" = 2 ] || { echo "TIFF 에 해상도가 $n 종이에요(2종이어야 해요)" >&2; exit 1; }
  cmp -s "$WORK/background.tiff" "$OUT" || { echo "background.tiff 가 SVG와 달라요 — 다시 만들어 주세요" >&2; exit 1; }
  echo "ok"; exit 0
fi
cp "$WORK/background.tiff" "$OUT"
echo "wrote $OUT"

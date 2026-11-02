#!/usr/bin/env bash
# oort 메뉴 막대 아이콘(macOS 템플릿 PNG 네 장)을 브랜드 마크 정본에서 다시 만든다(#5193).
#   scripts/desktop/render_tray_icons.sh          # 다시 만들기
#   scripts/desktop/render_tray_icons.sh --check  # 커밋된 PNG가 정본에서 나온 것과 같은지만 본다
# 쓰는 도구: rsvg-convert(brew librsvg 2.63.2로 만든 값). 새 의존성 없음.
#
# 정본: docs/brand/mark/oort-mark-small-black.svg(16~32px 광학 보정판). 새로 그리지 않는다 —
# 색만 순수 검정(#000000)으로 바꾸고, 안 읽음 변형에만 점 하나를 더한다. 템플릿 이미지는 알파만 쓴다
# (AppKit이 밝은 막대에서는 어둡게, 어두운 막대에서는 밝게 칠한다).
#
# 산출(clients/desktop/src-tauri/icons/tray/): 18pt 칸. @1x 18x18 · @2x 36x36, 검정 + 알파, RGBA 8비트.
#   oort-tray.png · oort-tray@2x.png                마크
#   oort-tray-unread.png · oort-tray-unread@2x.png  같은 마크 + 점
# 쉘(`src/tray.rs`)이 박는 것은 @2x 두 장이다(tray-icon은 비트맵 한 장만 받고 이미지 높이를 18pt로 고정한다).
# @1x 두 장은 같은 정본에서 나온 1배 판으로 함께 둔다.
#
# 점: 24 격자에서 중심 (20.2, 20.2), 반지름 2.6. 마크의 꼬리(왼쪽 아래)·위성(오른쪽 위) 축 밖, 곧
# 오른쪽 아래 빈 모서리다. 링과 겹치지 않고(틈 1.08) 위성(반지름 3)보다 작아서 「위성이 하나 더」로
# 읽히지 않게 했다. 마크의 viewBox는 그대로라 점이 생겨도 마크는 한 픽셀도 움직이지 않는다.
set -euo pipefail
cd "$(dirname "$0")/../.."
SRC=docs/brand/mark/oort-mark-small-black.svg
OUT=clients/desktop/src-tauri/icons/tray
DOT='<circle cx="20.2" cy="20.2" r="2.6" fill="#000000"/>'
command -v rsvg-convert >/dev/null || { echo "rsvg-convert 가 필요해요(brew install librsvg)" >&2; exit 1; }
[ -f "$SRC" ] || { echo "정본이 없어요: $SRC" >&2; exit 1; }
# 정본 모양을 확인한다: 색 한 가지, 그룹 하나. 정본이 바뀌었으면 여기서 멈춘다(점을 엉뚱한 곳에 꽂지 않게).
[ "$(grep -c '#17161a' "$SRC")" -ge 1 ] || { echo "정본의 색(#17161a)을 못 찾았어요" >&2; exit 1; }
[ "$(grep -c '</g>' "$SRC")" = 1 ] || { echo "정본의 </g> 가 하나가 아니에요 — 점을 꽂을 자리를 다시 정해야 해요" >&2; exit 1; }

# 임시 폴더는 이 스크립트가 만든 것이고 안에는 PNG·SVG 몇 장뿐이다: 파일만 지우고 빈 폴더를 걷는다(재귀 삭제 없음).
WORK=$(mktemp -d); trap 'rm -f "$WORK"/*.svg "$WORK"/*.png; rmdir "$WORK"' EXIT
sed -e 's/#17161a/#000000/' "$SRC" > "$WORK/plain.svg"
sed -e 's/#17161a/#000000/' -e "s|</g>|</g>$DOT|" "$SRC" > "$WORK/unread.svg"
grep -q 'r="2.6"' "$WORK/unread.svg" || { echo "점이 꽂히지 않았어요" >&2; exit 1; }

render() { # <이름> <svg>
  rsvg-convert -w 18 -h 18 "$2" -o "$WORK/$1.png"
  rsvg-convert -w 36 -h 36 "$2" -o "$WORK/$1@2x.png"
}
render oort-tray "$WORK/plain.svg"
render oort-tray-unread "$WORK/unread.svg"

# Rust 쪽 디코더가 읽는 모양(RGBA 8비트)과 크기를 확인한다.
for f in oort-tray oort-tray-unread; do
  file "$WORK/$f.png" | grep -q '18 x 18, 8-bit/color RGBA' || { echo "$f.png 모양이 달라요" >&2; exit 1; }
  file "$WORK/$f@2x.png" | grep -q '36 x 36, 8-bit/color RGBA' || { echo "$f@2x.png 모양이 달라요" >&2; exit 1; }
done

if [ "${1:-}" = "--check" ]; then
  for f in oort-tray oort-tray@2x oort-tray-unread oort-tray-unread@2x; do
    cmp -s "$WORK/$f.png" "$OUT/$f.png" || { echo "$OUT/$f.png 가 정본에서 나온 것과 달라요 — 다시 만들어 주세요" >&2; exit 1; }
  done
  echo "ok"; exit 0
fi
mkdir -p "$OUT"
for f in oort-tray oort-tray@2x oort-tray-unread oort-tray-unread@2x; do
  cp "$WORK/$f.png" "$OUT/$f.png"
done
echo "wrote $OUT"

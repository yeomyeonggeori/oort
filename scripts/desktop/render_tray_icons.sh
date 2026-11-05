#!/usr/bin/env bash
# oort 메뉴 막대 아이콘(macOS PNG 여덟 장)을 브랜드 마크 정본에서 다시 만든다(#5193, #5358).
#   scripts/desktop/render_tray_icons.sh          # 다시 만들기
#   scripts/desktop/render_tray_icons.sh --check  # 커밋된 PNG가 정본에서 나온 것과 같은지만 본다
# 쓰는 도구: rsvg-convert(brew librsvg 2.63.2로 만든 값). 새 의존성 없음.
#
# 정본: docs/brand/mark/oort-mark-small-black.svg(16~32px 광학 보정판). 새로 그리지 않는다 — 색만 바꾸고,
# 안 읽음 점 변형에만 점 하나를 더한다.
#
# 산출(clients/desktop/src-tauri/icons/tray/): 18pt 칸. @1x 18x18 · @2x 36x36, RGBA 8비트.
#   템플릿(검정 + 알파. AppKit이 밝은 막대에서는 어둡게, 어두운 막대에서는 밝게 칠한다)
#     oort-tray.png · oort-tray@2x.png                          마크. 알림 없음
#     oort-tray-unread.png · oort-tray-unread@2x.png            같은 마크 + 점. 알림이 있는데 막대 모양을 못 읽을 때(안전한 쪽)
#   색 있는 아이콘(템플릿 아님. 정본 모양 그대로, 오른쪽 위 행성만 신호 주황. 덧붙는 점 없음)
#     oort-tray-unread-on-light.png · …@2x.png                  밝은 막대용: 링 #17161a(정본의 색), 행성 --signal 라이트 값
#     oort-tray-unread-on-dark.png · …@2x.png                   어두운 막대용: 링 #ffffff(brand-mark.mjs COLORS.white), 행성 --signal 다크 값
# 신호 주황은 새 색이 아니다: clients/web/src/design/tokens.css 의 `--signal: light-dark(라이트, 다크);`(Dawn Sky 기본
# 신호, `.brand-lockup`이 마크 옆에서 쓰는 그 값)를 이 스크립트가 읽는다. 토큰이 바뀌면 `--check`가 다르다고 알린다.
# 쉘(`src/tray.rs`)이 박는 것은 @2x 네 장이다(tray-icon은 비트맵 한 장만 받고 이미지 높이를 18pt로 고정한다).
# @1x 네 장은 같은 정본에서 나온 1배 판으로 함께 둔다. 어느 장을 쓰는지는 tray.rs의 `icon_kind`가 정한다.
#
# 점: 24 격자에서 중심 (20.2, 20.2), 반지름 2.6. 마크의 꼬리(왼쪽 아래)·위성(오른쪽 위) 축 밖, 곧
# 오른쪽 아래 빈 모서리다. 링과 겹치지 않고(틈 1.08) 위성(반지름 3)보다 작아서 「위성이 하나 더」로
# 읽히지 않게 했다. 마크의 viewBox는 그대로라 점이 생겨도 마크는 한 픽셀도 움직이지 않는다.
set -euo pipefail
cd "$(dirname "$0")/../.."
SRC=docs/brand/mark/oort-mark-small-black.svg
TOKENS=clients/web/src/design/tokens.css
OUT=clients/desktop/src-tauri/icons/tray
DOT='<circle cx="20.2" cy="20.2" r="2.6" fill="#000000"/>'
INK='#17161a'    # 정본의 색: 밝은 막대 위 링
WHITE='#ffffff'  # 어두운 막대 위 링(brand-mark.mjs 의 COLORS.white)
# 위성(오른쪽 위 행성)의 path. 정본의 두 번째 path 다 — 색을 나눌 자리를 이 모양으로 찾는다.
SAT_D='M21 6A3 3 0 1 1 15 6A3 3 0 1 1 21 6Z'
NAMES="oort-tray oort-tray@2x oort-tray-unread oort-tray-unread@2x oort-tray-unread-on-light oort-tray-unread-on-light@2x oort-tray-unread-on-dark oort-tray-unread-on-dark@2x"
command -v rsvg-convert >/dev/null || { echo "rsvg-convert 가 필요해요(brew install librsvg)" >&2; exit 1; }
[ -f "$SRC" ] || { echo "정본이 없어요: $SRC" >&2; exit 1; }
[ -f "$TOKENS" ] || { echo "토큰 파일이 없어요: $TOKENS" >&2; exit 1; }
# 정본 모양을 확인한다: 색 한 가지, 그룹 하나, path 둘(링·위성). 정본이 바뀌었으면 여기서 멈춘다(점을 엉뚱한 곳에 꽂지 않게,
# 행성이 아닌 곳에 주황을 칠하지 않게).
[ "$(grep -c "$INK" "$SRC")" -ge 1 ] || { echo "정본의 색($INK)을 못 찾았어요" >&2; exit 1; }
[ "$(grep -c '</g>' "$SRC")" = 1 ] || { echo "정본의 </g> 가 하나가 아니에요 — 점을 꽂을 자리를 다시 정해야 해요" >&2; exit 1; }
[ "$(grep -c '<path' "$SRC")" = 2 ] || { echo "정본의 <path> 가 둘이 아니에요 — 링과 위성을 다시 가려야 해요" >&2; exit 1; }
[ "$(grep -c "<path d=\"$SAT_D\"" "$SRC")" = 1 ] || { echo "정본에서 위성 path 를 못 찾았어요 — 행성에 칠할 자리를 다시 정해야 해요" >&2; exit 1; }

# 신호 주황: 토큰의 `--signal: light-dark(#라이트, #다크);` 한 줄. 같은 값이 여러 줄이면 모두 같아야 한다.
SIGNALS=$(grep -E '^[[:space:]]*--signal:[[:space:]]*light-dark\(#[0-9a-fA-F]{6},[[:space:]]*#[0-9a-fA-F]{6}\);' "$TOKENS" | sed -E 's/^[[:space:]]*//' | sort -u)
[ -n "$SIGNALS" ] || { echo "$TOKENS 에서 --signal 값을 못 찾았어요" >&2; exit 1; }
[ "$(printf '%s\n' "$SIGNALS" | wc -l | tr -d ' ')" = 1 ] || { echo "--signal 값이 한 가지가 아니에요 — 어느 것이 브랜드 신호인지 정해야 해요" >&2; exit 1; }
SIGNAL_LIGHT=$(printf '%s' "$SIGNALS" | sed -E 's/^--signal:[[:space:]]*light-dark\((#[0-9a-fA-F]{6}),.*/\1/')
SIGNAL_DARK=$(printf '%s' "$SIGNALS" | sed -E 's/^--signal:[[:space:]]*light-dark\(#[0-9a-fA-F]{6},[[:space:]]*(#[0-9a-fA-F]{6})\);.*/\1/')

# 임시 폴더는 이 스크립트가 만든 것이고 안에는 PNG·SVG 몇 장뿐이다: 파일만 지우고 빈 폴더를 걷는다(재귀 삭제 없음).
WORK=$(mktemp -d); trap 'rm -f "$WORK"/*.svg "$WORK"/*.png; rmdir "$WORK"' EXIT
sed -e 's/#17161a/#000000/' "$SRC" > "$WORK/plain.svg"
sed -e 's/#17161a/#000000/' -e "s|</g>|</g>$DOT|" "$SRC" > "$WORK/unread.svg"
grep -q 'r="2.6"' "$WORK/unread.svg" || { echo "점이 꽂히지 않았어요" >&2; exit 1; }
# 색 있는 두 벌: 링 색은 그룹의 fill 을 바꿔서, 행성 색은 위성 path 에만 fill 을 달아서 준다. 모양은 그대로다.
recolor() { # <링 색> <행성 색>
  sed -e "s/$INK/$1/" -e "s|<path d=\"$SAT_D\"|<path fill=\"$2\" d=\"$SAT_D\"|" "$SRC"
}
recolor "$INK" "$SIGNAL_LIGHT" > "$WORK/on-light.svg"
recolor "$WHITE" "$SIGNAL_DARK" > "$WORK/on-dark.svg"
grep -q "<path fill=\"$SIGNAL_LIGHT\" d=\"$SAT_D\"" "$WORK/on-light.svg" || { echo "밝은 막대용 행성에 색이 칠해지지 않았어요" >&2; exit 1; }
grep -q "<path fill=\"$SIGNAL_DARK\" d=\"$SAT_D\"" "$WORK/on-dark.svg" || { echo "어두운 막대용 행성에 색이 칠해지지 않았어요" >&2; exit 1; }
grep -q "<g fill=\"$WHITE\"" "$WORK/on-dark.svg" || { echo "어두운 막대용 링이 흰색이 아니에요" >&2; exit 1; }

render() { # <이름> <svg>
  rsvg-convert -w 18 -h 18 "$2" -o "$WORK/$1.png"
  rsvg-convert -w 36 -h 36 "$2" -o "$WORK/$1@2x.png"
}
render oort-tray "$WORK/plain.svg"
render oort-tray-unread "$WORK/unread.svg"
render oort-tray-unread-on-light "$WORK/on-light.svg"
render oort-tray-unread-on-dark "$WORK/on-dark.svg"

# Rust 쪽 디코더가 읽는 모양(RGBA 8비트)과 크기를 확인한다.
for f in oort-tray oort-tray-unread oort-tray-unread-on-light oort-tray-unread-on-dark; do
  file "$WORK/$f.png" | grep -q '18 x 18, 8-bit/color RGBA' || { echo "$f.png 모양이 달라요" >&2; exit 1; }
  file "$WORK/$f@2x.png" | grep -q '36 x 36, 8-bit/color RGBA' || { echo "$f@2x.png 모양이 달라요" >&2; exit 1; }
done

if [ "${1:-}" = "--check" ]; then
  for f in $NAMES; do
    cmp -s "$WORK/$f.png" "$OUT/$f.png" || { echo "$OUT/$f.png 가 정본에서 나온 것과 달라요 — 다시 만들어 주세요" >&2; exit 1; }
  done
  echo "ok"; exit 0
fi
mkdir -p "$OUT"
for f in $NAMES; do
  cp "$WORK/$f.png" "$OUT/$f.png"
done
echo "wrote $OUT (signal light=$SIGNAL_LIGHT dark=$SIGNAL_DARK)"

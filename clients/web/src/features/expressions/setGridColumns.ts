// =============================================================================
// 세트 카드 격자의 열 수 (#5527, 검수 7c M2 · #5462). 카드 폭이 정한다: 줄 나눔(`chunk`), 줄의 모양(`data-cols`를 읽는 `expressionSet.css`), 키보드 칸 이동(위·아래가
// 한 줄의 열 수만큼 건넌다)이 모두 이 값 하나를 쓰므로 눈에 보이는 열과 키가 걷는 열이 어긋날 수 없다.
//
// 이전에는 4열 고정이었다. 데스크탑 최소 창(720)에서 카드 폭이 약 290이 되어 칸이 약 60px인데 그림 자리는 64px 고정이라 그림이 칸을 넘고, 칸 왼쪽 위의 체크 상자가 그림을 덮었다.
// 칸의 가장 좁은 폭을 정하고(아래 `SET_TILE_MIN_PX`) 그 폭을 지키는 열 수 중 가장 많은 것을 고른다(최대 4, 넓은 카드의 모양은 그대로다).
// =============================================================================

/** 한 줄에 놓을 수 있는 가장 많은 칸. 넓은 카드의 모양이고, 폭을 알 수 없는 자리(첫 그림 전, 레이아웃이 없는 시험 환경)의 값이다. */
export const SET_GRID_MAX_COLUMNS = 4;

/**
 * 칸의 가장 좁은 폭(px). 그림 자리 64가 칸 한가운데 서고 칸 왼쪽 위의 체크 상자(칸 가장자리에서 6 + 16 = 22까지)가 그림을 덮지 않으려면 그림 왼쪽 가장자리가
 * 칸 왼쪽에서 22 이상이어야 한다: (64 + 22 × 2) = 108.
 */
export const SET_TILE_MIN_PX = 108;

/** 칸 사이 간격(px). 줄의 `gap-2`(8)와 같아야 한다 — 브라우저 시험(`ExpressionSetApprovalCard.fit.browser.test.ts`)이 실제 칸 폭으로 대조한다. */
export const SET_GRID_GAP_PX = 8;

/** 스크롤바가 생기며 카드 폭이 줄어도 한 번 정한 열 수를 지키는 여유(px, 클래식 스크롤바 15보다 크다): 문턱에서 열 수가 깜박이지 않게 한다. */
const HYSTERESIS_PX = 16;

/** 열이 n개일 때 격자에 필요한 가장 좁은 폭. */
const neededWidth = (columns: number) => columns * SET_TILE_MIN_PX + (columns - 1) * SET_GRID_GAP_PX;

/**
 * 격자(카드 안쪽) 폭 `width`px에서의 열 수(1 ~ 4). 폭을 모르면(0 이하·유한하지 않음) `previous`, 그것도 없으면 최대 열 수다.
 * `previous`가 있으면(폭이 바뀌어 다시 셀 때) 열을 줄일 때만 `HYSTERESIS_PX`만큼 봐 준다. 늘릴 때는 봐 주지 않는다.
 */
export function setGridColumns(width: number, previous?: number): number {
  if (!Number.isFinite(width) || width <= 0) return previous ?? SET_GRID_MAX_COLUMNS;
  let fit = 1;
  for (let columns = SET_GRID_MAX_COLUMNS; columns > 1; columns--) {
    if (width >= neededWidth(columns)) { fit = columns; break; }
  }
  if (previous !== undefined && fit < previous && width >= neededWidth(previous) - HYSTERESIS_PX) return previous;
  return fit;
}

/** 피커 그리드는 8칸. 카테고리 탭·검색 리스트가 같은 열 수를 쓴다. */
export const EMOJI_GRID_COLS = 8;

/**
 * 한 번에 마운트하는 이모지 칸 상한 (#1742 H-2, 패킷 AC 「전량 DOM 금지」).
 *
 * 12행 × 8열 = 96. 패널 `max-h-pane`(320)은 대략 7행만 보이므로 위아래
 * overscan을 포함한 약 3화면이다. people 559 · 검색 `s` 1335 · 옛 `:` 한 글자
 * 1914(34화면)를 전량 버튼으로 올리면 안 된다. react-virtuoso는 타임라인이
 * 이미 쓰고, 행 높이를 인라인 스타일로 심는다. 피커는 신규 의존 없이 이
 * 슬라이스만 렌더한다.
 */
export const EMOJI_GRID_RENDER_LIMIT = 96;

export function emojiGridWindow(
  count: number,
  centerIndex: number,
  limit = EMOJI_GRID_RENDER_LIMIT
): { start: number; end: number } {
  if (count <= 0) return { start: 0, end: 0 };
  if (count <= limit) return { start: 0, end: count };
  const rows = Math.max(1, Math.floor(limit / EMOJI_GRID_COLS));
  const totalRows = Math.ceil(count / EMOJI_GRID_COLS);
  const clamped = Math.min(count - 1, Math.max(0, centerIndex));
  const centerRow = Math.floor(clamped / EMOJI_GRID_COLS);
  // 앵커는 보이는 밴드의 첫 행이다(onGridScroll). 창을 반씩 가르면 위 6행이
  // 화면 밖 overscan으로 죽고 아래가 밴드(약 7행)보다 얕아 빈 띠가 남는다.
  let startRow = centerRow - 3;
  if (startRow < 0) startRow = 0;
  if (startRow + rows > totalRows) startRow = Math.max(0, totalRows - rows);
  const start = startRow * EMOJI_GRID_COLS;
  return { start, end: Math.min(count, start + rows * EMOJI_GRID_COLS) };
}

export function emojiGridPadRows(itemCount: number): number {
  if (itemCount <= 0) return 0;
  return Math.ceil(itemCount / EMOJI_GRID_COLS);
}

// =============================================================================
// Hover quick-action toolbar contract (#1743).
//
// The toolbar is not an always-on row of buttons. B11 R1 hid six controls with
// `opacity-0`; Tab still found them, and a virtualized timeline grew ~150 stops.
// The replacement is: mount the toolbar only while the row is hovered, focused,
// or holding an overlay, and treat the toolbar as one WAI-ARIA composite
// (toolbar items join the row's one roving group). Touch (`hover: none`) never
// mounts it. The bar straddles the row's top edge, or the bottom edge when
// that would clip the scroller (#1743 H-4), and must not intersect this
// row's body text (B11 R2 Blocker). It also flips when the top edge would cover
// the previous neighbour's text and the bottom edge would not (#5179).
// =============================================================================

/** Curated seed. Must stay inside `PICKER_EMOJI`. Frequency then promotes. */
export const HOVER_TOOLBAR_REACTION_SEED = ["👍", "✅", "🙏"] as const;

export const HOVER_TOOLBAR_SLOT_COUNT = 3;

export function shouldShowHoverToolbar(input: {
  pointerCanHover: boolean;
  editing: boolean;
  rowHovered: boolean;
  rowFocused: boolean;
  overlayOpen: boolean;
  selecting: boolean;
  /** Previous message row has an open InlineBanner; do not straddle its 「닫기」. */
  neighborBannerOpen?: boolean;
}): boolean {
  if (!input.pointerCanHover || input.editing) return false;
  if (input.neighborBannerOpen) return false;
  if (input.overlayOpen) return true;
  if (input.selecting) return false;
  return input.rowHovered || input.rowFocused;
}

export function rectsIntersect(
  a: Pick<DOMRect, "left" | "right" | "top" | "bottom">,
  b: Pick<DOMRect, "left" | "right" | "top" | "bottom">
): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

/** Previous *message* row in this list has an open row banner. */
export function previousMessageRowHasOpenBanner(row: Element): boolean {
  const root =
    row.closest("[data-testid='timeline-virtuoso']") ??
    row.closest("[data-virtuoso-scroller]") ??
    row.parentElement;
  if (!root) return false;
  const messages = Array.from(
    root.querySelectorAll('[data-testid="timeline-message"]')
  );
  const index = messages.indexOf(row);
  if (index <= 0) return false;
  return messages[index - 1]?.getAttribute("data-row-banner") === "open";
}

/** Tab stops owned by a mounted toolbar. Red proof: this is 0 or 1, never more. */
export function countToolbarTabStops(root: ParentNode): number {
  return Array.from(
    root.querySelectorAll<HTMLElement>("[data-toolbar-item]")
  ).filter((el) => !el.hasAttribute("disabled") && el.tabIndex >= 0).length;
}

/**
 * 위쪽 straddle이 스크롤러 상단을 침범하면 행 하단으로 뒤집는다 (#1743 H-4).
 * 스크롤러가 아직 높이를 모르면 뒤집지 않는다.
 */
export function toolbarClipsScrollerTop(
  bar: Pick<DOMRect, "top">,
  scroller: Pick<DOMRect, "top" | "height">
): boolean {
  if (scroller.height <= 0) return false;
  return bar.top < scroller.top;
}

const TOOLBAR_CLIPPING_OVERFLOW = new Set([
  "auto",
  "scroll",
  "overlay",
  "hidden",
  "clip",
]);

/**
 * 툴바를 실제로 자를 수 있는 가장 가까운 세로 경계를 찾는다 (#1753).
 *
 * 채널 타임라인은 react-virtuoso가 `data-virtuoso-scroller`를 주지만 스레드 패널은
 * 자기 `overflow-y-auto` 상자를 쓴다. 특정 타임라인 표식만 찾으면 스레드 루트는
 * 경계를 하나도 못 찾아 위 straddle을 헤더 쪽으로 내보낸다. 표식은 안정적인 빠른
 * 경로로 보존하고, 나머지는 계산된 overflow로 일반화한다.
 */
export function closestToolbarScrollContainer(
  element: HTMLElement
): HTMLElement | null {
  let ancestor = element.parentElement;
  while (ancestor) {
    if (
      ancestor.hasAttribute("data-message-scroll-container") ||
      ancestor.hasAttribute("data-virtuoso-scroller") ||
      ancestor.getAttribute("data-testid") === "timeline-virtuoso"
    ) {
      return ancestor;
    }
    const overflowY = getComputedStyle(ancestor).overflowY;
    if (TOOLBAR_CLIPPING_OVERFLOW.has(overflowY)) return ancestor;
    ancestor = ancestor.parentElement;
  }
  return null;
}

// =============================================================================
// 위 이웃의 글자를 덮을 때의 뒤집기 (#5179, README §6 행 액션 5번)
//
// 위 straddle 은 행 위 경계를 걸쳐 앞 이웃의 바닥 `키 − --spacing-row`(34~38)를 덮는다. 그 띠 안에는 앞 이웃의 **마지막 줄**이 늘
// 서므로, 겹침은 세로가 아니라 가로로 정해진다: 마지막 줄이 막대 왼쪽 끝(오른쪽에서 12 + 223)보다 오른쪽까지 오면 덮인다. 390 열에서는
// 글머리에서 한국어 7~8자가 넘는 줄이 그렇다. 앞 줄이 막대에 닿으면 막대를 행 아래 경계로 뒤집는다 — 단 **새 겹침을 만들지 않을 때만**:
// 아래 자리는 같은 띠를 뒤 이웃의 첫 줄(머리 줄 또는 본문 첫 줄)에 얹으므로, 그 자리가 뒤 이웃 글자를 덮거나 스크롤러 아래로 잘리면 위에
// 그대로 둔다(옛 동작 그대로, 한 겹침을 다른 겹침으로 바꾸지 않는다). 스크롤러 위가 막히면 뒤집는 옛 규칙(#1743 H-4)이 먼저다.
// 넓은 열에서는 글자가 막대에 닿지 않으니 위에 그대로 선다 — 폭 문턱이 아니라 **잰 값**이 정한다.
// =============================================================================

type ToolbarRect = Pick<DOMRect, "left" | "right" | "top" | "bottom">;

/**
 * 막대가 이웃으로 세는 칸: 행(`timeline-message`)과 시스템 줄(`system-line`). 겹침 단정의 자
 * (`scripts/lib/hoverToolbarOverlap.mjs` 의 `HOVER_TOOLBAR_NEIGHBOR_SELECTOR`)와 같은 목록이어야 한다 — 시험이 둘이 같은지 묻는다.
 */
export const TOOLBAR_NEIGHBOR_SELECTOR =
  '[data-testid="timeline-message"], [data-testid="system-line"]';

/**
 * 위 자리에 선 막대가 행 아래 경계로 뒤집히면(`hover-toolbar-straddle-below`) 설 상자. CSS 와 같은 산식이다: 위 자리는 막대 하단이
 * 행 안으로 `--spacing-row` 만 들어오고(`top: 0` + `translate: -100% + row`), 아래 자리는 막대 상단이 행 하단에서 `--spacing-row` 만큼
 * 위에 선다(`bottom: 0` + `translate: 100% − row`). 그 깊이를 CSS 변수를 읽어 구하지 않고 위 자리의 상자에서 잰다.
 */
export function belowStraddleRect(
  bar: ToolbarRect,
  row: Pick<DOMRect, "top" | "bottom">
): ToolbarRect {
  const height = bar.bottom - bar.top;
  const intoRow = bar.bottom - row.top;
  const top = row.bottom - intoRow;
  return { left: bar.left, right: bar.right, top, bottom: top + height };
}

/**
 * 막대를 행 **아래** 경계로 뒤집어야 하는가(true = 아래, false = 위 그대로). `bar` 는 처음 마운트된 위 자리의 상자다. 이웃 글자는
 * **필요할 때만** 재도록 함수로 받는다(위가 비어 있으면 뒤 이웃은 만지지 않는다).
 *
 * 문자열 대신 불리언을 돌려주는 이유: 웹의 직접 문구 장부(`direct-copy`)는 제품 소스의 낱말 리터럴(「top」「below」)을 하나씩 센다.
 * 자리 이름은 문구가 아니라 CSS 클래스·`data-straddle` 값이고, 그 이름은 이미 `MessageActions.tsx` 한 곳에 있다.
 */
export function shouldFlipToolbarBelow(input: {
  bar: ToolbarRect;
  row: Pick<DOMRect, "top" | "bottom"> | null;
  scroller: Pick<DOMRect, "top" | "bottom" | "height"> | null;
  prevText: () => readonly ToolbarRect[];
  nextText: () => readonly ToolbarRect[];
}): boolean {
  const { bar, row, scroller } = input;
  if (scroller && toolbarClipsScrollerTop(bar, scroller)) return true;
  if (!row) return false;
  if (!input.prevText().some((text) => rectsIntersect(bar, text))) return false;
  const below = belowStraddleRect(bar, row);
  if (input.nextText().some((text) => rectsIntersect(below, text))) return false;
  if (scroller && scroller.height > 0 && below.bottom > scroller.bottom) return false;
  return true;
}

/** 같은 목록(`root`) 안에서 문서 순서로 센 앞·뒤 한 칸(행·시스템 줄). */
export function toolbarNeighbors(
  row: Element,
  root: ParentNode
): { prev: Element | null; next: Element | null } {
  const items = Array.from(root.querySelectorAll(TOOLBAR_NEIGHBOR_SELECTOR));
  const index = items.indexOf(row);
  if (index < 0) return { prev: null, next: null };
  return { prev: items[index - 1] ?? null, next: items[index + 1] ?? null };
}

/**
 * 이웃 칸의 글자가 선 자리들. 글자를 재는 상자는 시스템 줄이면 줄 자신, 행이면 머리 줄(이름·시각)과 본문이 든 `[data-row-body]`다.
 * 글 노드마다 한 번 `getClientRects()` 를 불러 **줄마다 한 조각**(그 줄의 첫 글자 왼쪽 ~ 끝 글자 오른쪽)을 얻는다: 글자마다 Range 를
 * 만들지 않아 긴 메시지에서도 싸고, 줄 끝 빈 칸만큼 넉넉하게 재므로 글자 단위 자(겹침 단정)가 겹침을 찾는 곳에서는 늘 여기도 겹친다.
 * 노드 전체를 한 Range 로 잡지 않는 이유: 블록 자식의 **상자**(폭 전체)가 같이 나와 빈 곳에서 뒤집게 된다.
 * 레이아웃을 못 재는 환경(Range 에 `getClientRects` 가 없는 jsdom)에서는 빈 목록이다.
 */
export function neighborTextRects(item: Element | null): DOMRect[] {
  if (!item) return [];
  const box =
    item.getAttribute("data-testid") === "system-line"
      ? item
      : item.querySelector("[data-row-body]");
  if (!box) return [];
  const doc = box.ownerDocument;
  const rects: DOMRect[] = [];
  const walker = doc.createTreeWalker(box, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (!(node.textContent ?? "").trim()) continue;
    const range = doc.createRange();
    range.selectNodeContents(node);
    if ((range as Partial<Range>).getClientRects === undefined) return rects;
    for (const rect of Array.from(range.getClientRects())) {
      if (rect.width > 0 && rect.height > 0) rects.push(rect);
    }
  }
  return rects;
}

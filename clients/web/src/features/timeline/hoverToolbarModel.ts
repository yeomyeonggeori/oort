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
// the previous neighbour's text and the bottom edge would not (#5179), and when
// neither edge is free it slides down into the first text-free window of the row (#5179).
// A line end that grazes the toolbar's left edge by 1-2px is dodged by nudging the bar right (#5179).
// =============================================================================

import { POINTER_MODALITY_SELECTOR } from "@/design/focusModality";

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

/**
 * 이 초점은 키보드로 닿은 것인가 (#5328). 막대를 붙드는 「행에 초점 있음」은 키보드 초점만이다.
 *
 * 마우스 흐름이 남긴 초점은 막대를 붙들지 않는다: ⋮ 메뉴에서 행동을 고르면 Radix 가 닫으며 초점을 ⋮ 단추(막대 안)로 돌려주는데, 이것을
 * 세면 포인터가 그 행을 떠난 뒤에도 막대가 남아 다른 곳을 눌러야 꺼졌다. **`:focus-visible` 만으로는 가려지지 않는다**: Radix 메뉴는 초점이
 * body 에 있는 채로 열리므로 그 뒤 스크립트가 옮기는 초점이 마우스 흐름에서도 `:focus-visible` 이다(Chromium 실측, `capture-5328.mjs`).
 * 그래서 앱이 이미 쥔 입력 방식 스탬프(`focusModality.ts`: 포인터 누름이 `pointer` 로, 캐럿을 옮기는 키가 `keyboard` 로)가 포인터이면
 * 키보드 초점이 아니다. 키보드 사용자는 그대로다: 초점이 ⋮ 로 돌아오면 막대가 남아 자리를 잃지 않는다. 스탬프가 없는 환경(시험)은
 * `:focus-visible` 로만 가르고, 셀렉터를 모르는 환경은 키보드로 본다(막대를 지우면 초점이 body 로 떨어진다).
 */
export function isKeyboardFocusTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  try {
    if (target.ownerDocument.documentElement.matches(POINTER_MODALITY_SELECTOR)) return false;
    return target.matches(":focus-visible");
  } catch {
    return true;
  }
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

// =============================================================================
// 위·아래 경계가 모두 글자에 막힐 때: 행 안쪽으로 밀어 앉히기 (#5179, 남은 경우 C·F)
//
// 위 자리는 앞 이웃 글자를 덮고 아래 자리도 뒤 이웃 글자를 덮거나 스크롤러 밖으로 잘려 뒤집지 못하는 자리가 있다(앞·뒤 이웃이 모두 긴 글일 때,
// 대화의 마지막 행). 위 자리에서 아래 자리까지 사이에는 막대가 **행에 붙은 채** 설 수 있는 자리가 연속으로 있고, 그 안에서 글자가 없는 창 — 앞 글줄 바로 밑 ~
// 뒤 글줄·스크롤러 바닥 사이, 막대 키 이상 — 을 찾으면 막대를 그 창으로 아래로 민다. 포인터 행 글이 막대 밑까지 안 오는 짧은 행은 행 높이만큼이 비고, 머리 행은
// 머리 줄(이름·시각)의 오른쪽이 빈다. 위 자리에 가장 가까운(= 가장 위의) 창에 앉아 막대가 평소 자리에서 가장 덜 떨어진다. 창이 없으면 위 그대로다(남은 경우:
// 포인터 행·앞·뒤 행의 글이 모두 막대 밑까지 오는 이어짐 행 — 글줄이 36px 간격이라 42px 창이 없다).
// =============================================================================

/** 막대를 아래로 민 px 를 막대의 CSS 변수로 건넨다(CSSOM, `tooltipFit.ts` 와 같은 방식). `tokens.css` 의 `hover-toolbar-straddle` 이 읽는다. */
export const HOVER_TOOLBAR_SLIDE_VAR = "--hover-toolbar-slide";

/**
 * 막대를 오른쪽으로 비껴 세운 px 의 CSS 변수. 두 straddle 유틸리티가 모두 읽는다.
 *
 * 머리 줄(이름 + 시각)이나 글줄의 오른끝이 막대 왼쪽 끝을 **1~2px** 넘는 경계가 있다: 720 창(글머리에서 막대 왼쪽 끝까지 77px)에서 3글자 이름 + 시각이 정확히 그렇다
 * (78px). 그 1px 때문에 위·아래·행 안쪽 어느 자리도 「글자 없음」이 못 되어 앞 행 끝줄 전체를 덮던 장면이 있었다. 막대는 글 오른끝(= 행 안쪽 여백 12 안쪽)에 맞춰 서 있어
 * 오른쪽으로 1~2px 비키면 새로 닿는 글이 없고(글은 막대 오른끝을 넘지 않는다) 닿던 글줄만 비켜난다. 막대는 여전히 행 오른쪽 안쪽 여백(12) 안에 머문다.
 */
export const HOVER_TOOLBAR_NUDGE_VAR = "--hover-toolbar-nudge";

/** 비껴 설 수 있는 거리들(px). 작은 것부터 시도한다. 글 상자는 소수 px 로 나오므로 「1px 침범」은 1.25px 일 수 있다(720 창의 3글자 이름 머리 줄: 시각 오른끝 466.25 · 막대 왼끝 465 → 2px 비껴야 비킨다). 최대 2px 는 `capture-screens.mjs`가 지키는 오른쪽 거터 12 ± 2 안이다. 이보다 깊이 닿는 글은 비껴서 풀 일이 아니다. */
const NUDGE_STEPS = [1, 2] as const;

/** 창이 넉넉하면 앞 글줄과 막대 사이에 두는 틈(px). 창이 좁으면 위·아래 틈을 같게 나눈다. */
const SLIDE_GAP = 2;

/**
 * 위 자리(`bar`)에서 아래로 몇 px 밀면 막대가 어떤 글자도 덮지 않고 행에 붙어 앉는가. 없으면 `null`, 밀 필요가 없으면 0.
 * `text` 는 막대 주변 글줄 조각 전부(앞 이웃·포인터 행·뒤 이웃)이고, 막대 가로 범위에 걸치는 조각만 막는다. 막대는 행에 붙은 채여야 하므로 위 자리와 아래 자리
 * 사이만 보고, 스크롤러 바닥 밖으로 잘리는 자리는 뺀다.
 */
export function slideToolbarDown(input: {
  bar: ToolbarRect;
  row: Pick<DOMRect, "top" | "bottom">;
  scroller: Pick<DOMRect, "bottom" | "height"> | null;
  text: readonly ToolbarRect[];
}): number | null {
  const { bar, row, scroller } = input;
  const height = bar.bottom - bar.top;
  let lowest = belowStraddleRect(bar, row).top;
  if (scroller && scroller.height > 0) lowest = Math.min(lowest, scroller.bottom - height);
  if (lowest <= bar.top) return null;
  // 막대 윗단이 (글 윗단 − 키, 글 밑단) 안에 들면 그 글을 덮는다. 경계에 닿는 것은 덮는 것이 아니다(`rectsIntersect` 와 같다).
  const walls = input.text
    .filter((text) => text.left < bar.right && text.right > bar.left && text.bottom > text.top)
    .map((text) => [text.top - height, text.bottom] as const)
    .sort((a, b) => a[0] - b[0]);
  let top = bar.top;
  let limit = lowest;
  let moved = false;
  for (const [from, to] of walls) {
    if (top <= from) {
      limit = Math.min(limit, from);
      break; // 이 벽 위쪽의 빈 창에 서 있다
    }
    if (top < to) {
      top = to; // 벽 안에 들었다: 그 글줄 바로 밑으로 내려온다
      moved = true;
    }
  }
  if (top > limit) return null;
  if (!moved) return 0; // 위 자리가 이미 비어 있다
  return top + Math.min(SLIDE_GAP, (limit - top) / 2) - bar.top;
}

function once<T>(read: () => readonly T[]): () => readonly T[] {
  let cached: readonly T[] | undefined;
  return () => (cached ??= read());
}

function shiftedRight(bar: ToolbarRect, by: number): ToolbarRect {
  return { left: bar.left + by, right: bar.right + by, top: bar.top, bottom: bar.bottom };
}

/**
 * 마운트 때 한 번 재서 막대의 자리를 정한다. `below` = 행 아래 경계로 뒤집기(`shouldFlipToolbarBelow`), `slide` = 위 자리에서 아래로 민 px(0 = 안 밂),
 * `nudge` = 오른쪽으로 비껴 선 px(0 = 안 비낌).
 * ① 위 자리가 앞 이웃 글자를 안 덮으면 위 그대로 ② 덮고 아래 자리가 비면 뒤집는다(1차 수리) ③ 위·아래 모두 막히면 행 안쪽의 빈 창으로 민다
 * ④ 창이 없으면 위 그대로다. 글줄 끝이 막대 왼쪽 끝에 1~2px 닿는 경계는 막대를 오른쪽으로 비껴(1px, 2px) 먼저 ①②를, 그다음 ③을 다시 해 본다 — 움직임이
 * 작은 쪽(비끼기 < 밀기)이 먼저다. 이웃 글자는 **필요할 때만** 재도록 함수로 받는다.
 */
export function placeToolbar(input: {
  bar: ToolbarRect;
  row: Pick<DOMRect, "top" | "bottom"> | null;
  scroller: Pick<DOMRect, "top" | "bottom" | "height"> | null;
  prevText: () => readonly ToolbarRect[];
  selfText: () => readonly ToolbarRect[];
  nextText: () => readonly ToolbarRect[];
}): { below: boolean; slide: number; nudge: number } {
  const prevText = once(input.prevText);
  const nextText = once(input.nextText);
  const { row, scroller } = input;
  const offsets = [0, ...NUDGE_STEPS];
  // 뒤집기·위 그대로: 위 자리가 앞 이웃 글자를 덮지 않거나, 덮어도 뒤집을 수 있을 때.
  for (const nudge of offsets) {
    const bar = shiftedRight(input.bar, nudge);
    if (shouldFlipToolbarBelow({ ...input, bar, prevText, nextText })) return { below: true, slide: 0, nudge };
    if (!row || !prevText().some((text) => rectsIntersect(bar, text))) return { below: false, slide: 0, nudge };
  }
  // 위·아래가 모두 막혔다: 행 안쪽으로 민다.
  if (row) {
    for (const nudge of offsets) {
      const slide = slideToolbarDown({
        bar: shiftedRight(input.bar, nudge),
        row,
        scroller,
        text: [...prevText(), ...input.selfText(), ...nextText()],
      });
      if (slide !== null) return { below: false, slide, nudge };
    }
  }
  return { below: false, slide: 0, nudge: 0 };
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

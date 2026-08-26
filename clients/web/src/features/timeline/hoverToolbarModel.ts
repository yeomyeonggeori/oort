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
// row's body text (B11 R2 Blocker).
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
}): boolean {
  if (!input.pointerCanHover || input.editing) return false;
  if (input.overlayOpen) return true;
  if (input.selecting) return false;
  return input.rowHovered || input.rowFocused;
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

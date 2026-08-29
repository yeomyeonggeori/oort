// =============================================================================
// 선택 서식 트레이 좌표 (#1902). buzz SelectionFormattingTray 의 포털 상하 배치
// + 뷰포트 클램프 문법만 옮긴다. TipTap coordsAtPos 는 없고, textarea 미러로
// 선택 첫 줄의 화면 상자를 잰다.
// =============================================================================

/** `--spacing-3`. 뷰포트 가장자리에서 트레이가 떨어질 최소 간격. */
export const FORMAT_TRAY_EDGE_GUTTER = 12;
/** `--spacing-2`. 선택 영역과 트레이 사이. */
export const FORMAT_TRAY_SELECTION_OFFSET = 8;
/** `--tap-target`. 이보다 위 공간이 없으면 선택 아래로 내린다. */
export const FORMAT_TRAY_MIN_SPACE_ABOVE = 44;

export type FormatTrayPlacement = "top" | "bottom";

export interface FormatTrayPosition {
  left: number;
  top: number;
  placement: FormatTrayPlacement;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * 선택 영역 중앙 위에 트레이를 두고, 위 공간이 없으면 아래로, 좌우는 뷰포트
 * 안으로 가둔다. `left` 는 트레이 가로 중앙(CSS `translate -50%`).
 */
export function clampFormatTrayPosition(
  selection: { left: number; top: number; width: number; height: number },
  trayWidth: number,
  viewport: { width: number; height: number }
): FormatTrayPosition {
  const selectionCenter = selection.left + selection.width / 2;
  const halfTrayWidth = trayWidth / 2;
  const minLeft = Math.min(
    viewport.width - FORMAT_TRAY_EDGE_GUTTER,
    FORMAT_TRAY_EDGE_GUTTER + halfTrayWidth
  );
  const maxLeft = Math.max(
    FORMAT_TRAY_EDGE_GUTTER,
    viewport.width - FORMAT_TRAY_EDGE_GUTTER - halfTrayWidth
  );
  const left =
    minLeft <= maxLeft
      ? clamp(selectionCenter, minLeft, maxLeft)
      : viewport.width / 2;
  const hasRoomAbove = selection.top >= FORMAT_TRAY_MIN_SPACE_ABOVE;
  if (hasRoomAbove) {
    return {
      left,
      placement: "top",
      top: Math.max(
        FORMAT_TRAY_EDGE_GUTTER,
        selection.top - FORMAT_TRAY_SELECTION_OFFSET
      ),
    };
  }
  return {
    left,
    placement: "bottom",
    top: Math.min(
      viewport.height - FORMAT_TRAY_EDGE_GUTTER,
      selection.top + selection.height + FORMAT_TRAY_SELECTION_OFFSET
    ),
  };
}

const MIRROR_PROPS = [
  "box-sizing",
  "width",
  "height",
  "overflow-x",
  "overflow-y",
  "border-top-width",
  "border-right-width",
  "border-bottom-width",
  "border-left-width",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "font",
  "letter-spacing",
  "text-indent",
  "text-transform",
  "word-spacing",
  "tab-size",
  "line-height",
  "text-align",
  "word-wrap",
  "word-break",
  "overflow-wrap",
] as const;

/**
 * textarea 선택은 DOM Range 가 아니라서 getClientRects 가 비어 있다. 같은
 * 박스·스크롤의 숨은 미러에서 선택 첫 줄 상자를 읽는다.
 */
export function getTextareaSelectionRect(
  textarea: HTMLTextAreaElement
): DOMRect | null {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  if (start === end) return null;
  if (typeof document === "undefined") return null;

  const textareaRect = textarea.getBoundingClientRect();
  const style = window.getComputedStyle(textarea);
  const mirror = document.createElement("div");
  mirror.setAttribute("aria-hidden", "true");
  mirror.setAttribute("data-composer-format-mirror", "");
  for (const prop of MIRROR_PROPS) {
    mirror.style.setProperty(prop, style.getPropertyValue(prop));
  }
  mirror.style.setProperty("position", "fixed");
  mirror.style.setProperty("left", `${textareaRect.left}px`);
  mirror.style.setProperty("top", `${textareaRect.top}px`);
  mirror.style.setProperty("visibility", "hidden");
  mirror.style.setProperty("pointer-events", "none");
  mirror.style.setProperty("white-space", "pre-wrap");
  mirror.style.setProperty("overflow", "hidden");

  const value = textarea.value;
  const mark = document.createElement("span");
  mark.append(document.createTextNode(value.slice(start, end) || "\u200b"));
  mirror.append(document.createTextNode(value.slice(0, start)), mark);
  document.body.append(mirror);
  mirror.scrollTop = textarea.scrollTop;
  mirror.scrollLeft = textarea.scrollLeft;

  const rects = Array.from(mark.getClientRects()).filter(
    (rect) => rect.width > 0 || rect.height > 0
  );
  const rect = rects[0] ?? mark.getBoundingClientRect();
  mirror.remove();
  if (rect.width <= 0 && rect.height <= 0) return null;
  return rect;
}

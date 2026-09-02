// =============================================================================
// Channel-section hover actions (#1756 UX-D4, UX-HT toolbar contract).
//
// The section header's + (and any future real action) is not an always-on
// control. UX-HT hid six timeline buttons with `opacity-0`; Tab still found
// them. The same contract lands here: mount the actions only while the header
// is hovered, keyboard-focused (`:focus-visible`), or holding an overlay.
// Touch (`hover: none`) always mounts them, because a finger has no hover and
// the empty-state / ⌘K paths are not the only door on a phone drawer.
//
// Collapse (chevron) is NOT a hover action. It is section structure, always
// mounted, always a tab stop, so a keyboard user reaches it without ever
// hovering. Pointer click uses `focus-visible:focus-ring` only: a mouse down
// must not paint an amber ring (#1743 B-4).
// =============================================================================

/**
 * 한 섹션을 부르는 이름.
 *
 * BT-4(#1932) 전에는 `"channels" | "dms"` 두 낱말의 합집합이었다. ADR-0177 D4 가
 * 그 둘을 **기본 섹션**으로 남기고 커스텀 섹션을 같은 문법에 합류시키면서, 이
 * 자리는 데이터가 됐다: 기본 두 종은 코어가 이름을 갖고
 * (`BASE_CHANNELS_SECTION_ID` / `BASE_DMS_SECTION_ID`), 커스텀은 payload 가 민
 * `sec-<수>` 다.
 *
 * 별칭을 지우지 않고 남긴 이유는 이것이 **한 자리의 뜻**이기 때문이다 -
 * `data-testid` 접미사, 접기 원장의 열쇠, `aria-controls` 의 목록 id 가 전부 이
 * 값을 쓴다. `string` 으로 흩뿌리면 그 셋이 같은 것을 가리킨다는 사실이 사라진다.
 */
export type SidebarSectionId = string;

export function shouldShowSectionActions(input: {
  pointerCanHover: boolean;
  headerHovered: boolean;
  headerKeyboardFocused: boolean;
  overlayOpen: boolean;
}): boolean {
  if (!input.pointerCanHover) return true;
  if (input.overlayOpen) return true;
  return input.headerHovered || input.headerKeyboardFocused;
}

/** Tab stops owned by a mounted section-action cluster. Red proof: 0 at rest
 *  on a pointer surface (the actions are not in the DOM). Called from a
 *  rendered SidebarSection (SidebarSection.test.tsx), same contract as
 *  countToolbarTabStops receiving a rendered row. */
export function countSectionActionTabStops(root: ParentNode): number {
  return Array.from(
    root.querySelectorAll<HTMLElement>("[data-section-action]")
  ).filter((el) => !el.hasAttribute("disabled") && el.tabIndex >= 0).length;
}

/** Unread + mention totals for a collapsed section header. Collapse hides
 *  rows, not alerts: ⌥↓ still walks these channels, so the header must say
 *  the same fact the keyboard already knows. */
export function sectionUnreadTotals(
  items: ReadonlyArray<{ unreadCount: number; mentionCount: number }>
): { unreadCount: number; mentionCount: number } {
  let unreadCount = 0;
  let mentionCount = 0;
  for (const item of items) {
    unreadCount += item.unreadCount;
    mentionCount += item.mentionCount;
  }
  return { unreadCount, mentionCount };
}

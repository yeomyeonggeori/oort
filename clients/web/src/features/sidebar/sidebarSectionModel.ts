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

export type SidebarSectionId = "channels" | "dms";

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
 *  on a pointer surface (the actions are not in the DOM). */
export function countSectionActionTabStops(root: ParentNode): number {
  return Array.from(
    root.querySelectorAll<HTMLElement>("[data-section-action]")
  ).filter((el) => !el.hasAttribute("disabled") && el.tabIndex >= 0).length;
}

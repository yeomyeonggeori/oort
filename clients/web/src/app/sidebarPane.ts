// =============================================================================
// Desktop sidebar fold (#1864, #3280).
//
// The fold is the list column only (the 56px rail stays). It is one state shared by
// every tab (`sidebarCollapseStore`, remembered per device since #3280; #1864 kept it
// shell-lifetime only).
// This file holds the copy and a11y predicates the titlebar toggle and the
// sidebar tree share, so a label and an inert rule cannot drift apart.
// =============================================================================

export function sidebarPaneToggleCopy(collapsed: boolean): {
  label: string;
  expanded: boolean;
} {
  return collapsed
    ? { label: "탐색 패널 열기", expanded: false }
    : { label: "탐색 패널 접기", expanded: true };
}

/** 접기 단추의 키 힌트(#3280). macOS는 ⌘B, 그 밖은 Ctrl+B. */
export function sidebarToggleKeyHint(isMac: boolean): string {
  return isMac ? "⌘B" : "Ctrl+B";
}

/** Closed mobile drawer, or a desktop fold: the tree is off the tab/AX path. */
export function isSidebarTreeInert({
  asDrawer,
  drawerOpen,
  collapsed,
}: {
  asDrawer: boolean;
  drawerOpen: boolean;
  collapsed: boolean;
}): boolean {
  return (asDrawer && !drawerOpen) || (!asDrawer && collapsed);
}

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * After a desktop fold settles, the tree leaves paint and layout (`hidden`).
 * The mobile drawer never takes this path: it is a translate overlay, not a
 * 0-width column, and must stay in geometry so the existing drawer can open.
 */
export function shouldHideCollapsedSidebarTree({
  asDrawer,
  collapsed,
  paintSettled,
}: {
  asDrawer: boolean;
  collapsed: boolean;
  paintSettled: boolean;
}): boolean {
  return !asDrawer && collapsed && paintSettled;
}

/** Drag region belongs on the titlebar row, never on the toggle itself. */
export function titlebarDragProps(isTauri: boolean): {
  "data-tauri-drag-region"?: "";
} {
  return isTauri ? { "data-tauri-drag-region": "" } : {};
}

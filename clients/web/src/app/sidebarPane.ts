// =============================================================================
// Desktop sidebar fold (#1864).
//
// The pane fold is shell-lifetime state owned by AppShell (`sidebarPaneCollapsed`).
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

/** Drag region belongs on the titlebar row, never on the toggle itself. */
export function titlebarDragProps(isTauri: boolean): {
  "data-tauri-drag-region"?: "";
} {
  return isTauri ? { "data-tauri-drag-region": "" } : {};
}

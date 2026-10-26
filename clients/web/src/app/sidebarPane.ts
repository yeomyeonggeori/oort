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

/**
 * 셸이 창 맨 위 잡기 띠를 그리는가의 마커 (#4591). `app-shell`의 `data-desktop-shell` 규칙(tokens.css)이 이
 * 마커를 읽어 본문 판을 띠 아래(둘째 행)로 내린다. 마커가 없으면 판은 웹처럼 첫 행까지 올라가 있다.
 *
 * 띠는 **Tauri 셸에서 상단 줄이 그려질 때만** 선다. 웹(브라우저)에는 창을 잡을 일이 없고, 설정 표면은 앱 상단
 * 줄 자체를 그리지 않으며(격자가 한 행이다) 자기 끌기 줄을 따로 가진다.
 */
export function desktopShellProps(
  isTauri: boolean,
  titlebarDrawn: boolean
): { "data-desktop-shell"?: "" } {
  return isTauri && titlebarDrawn ? { "data-desktop-shell": "" } : {};
}

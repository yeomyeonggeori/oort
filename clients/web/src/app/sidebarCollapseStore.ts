import { useSyncExternalStore } from "react";

// =============================================================================
// 목록 열 접힘 (#3280). 모든 탭이 공유하는 상태 한 벌이다.
//
// 접힘은 목록 열(268)만 접고 레일(56)은 남긴다(Cursor의 Activity Bar 방식).
// 대화·인박스·팀 작업의 사이드바 트리와 「내 작업」의 세션 목록이 같은 상태를
// 읽으므로 탭을 옮겨도 접힘은 유지된다.
//
// 기기별로 기억한다(localStorage). #1864는 이 상태를 저장하지 않는 셸 수명
// 상태로 두었으나(AppShell), 레일이 고정되고 접기 단추가 하나가 된 이 범위에서
// 성재가 「기기별로 기억」을 결재했다(2026-10-01, #3280). 접근이 막히면(사생활 보호
// 창·차단) 메모리에만 두고 펼침으로 시작한다.
// =============================================================================

export const SIDEBAR_COLLAPSED_KEY = "momo.web.shell.listColumn.collapsed.v1";

/** #2856의 옛 키(「내 작업」 세션 목록만 접던 때). 이제 이 저장소 하나가 대신한다. */
const LEGACY_SESSION_LIST_KEY = "momo.web.workbench.sessionList.open.v1";

function load(): boolean {
  try {
    localStorage.removeItem(LEGACY_SESSION_LIST_KEY);
  } catch {
    /* 저장소 없음 */
  }
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

let collapsed = load();
// 이번 실행에만 있는 상태(저장하지 않는다).
// - pinnedOpen: 사람이 이번 실행에 직접 편 목록. 좁은 창에서 폭 규칙으로 자동으로 접히지 않는다.
// - autoClosed: 「내 작업」이 폭 규칙으로 세션 목록을 접어 두었다(사람이 접은 것이 아니다).
//   제목줄 단추와 ⌘B는 이것까지 「접힘」으로 읽는다: 화면에 보이는 상태와 단추가 어긋나면
//   첫 번째 ⌘B가 아무 일도 하지 않는다.
let pinnedOpen = false;
let autoClosed = false;
const listeners = new Set<() => void>();

export function getSidebarCollapsed(): boolean {
  return collapsed;
}

function notify(): void {
  for (const listener of [...listeners]) listener();
}

export function getSidebarPinnedOpen(): boolean {
  return pinnedOpen;
}

/** 사람이 목록을 폈다: 폭 규칙으로 다시 접지 않는다(이번 실행에만). */
export function pinSidebarListOpen(): void {
  if (pinnedOpen) return;
  pinnedOpen = true;
  notify();
}

export function getSidebarAutoClosed(): boolean {
  return autoClosed;
}

/** 「내 작업」이 폭 규칙으로 목록을 접어 두었는지 알린다(떠나면 거짓으로 되돌린다). */
export function setSidebarAutoClosed(next: boolean): void {
  if (next === autoClosed) return;
  autoClosed = next;
  notify();
}

export function setSidebarCollapsed(next: boolean): void {
  // 사람이 접으면 이번 실행의 「폈다」 표지도 끝난다.
  if (next && pinnedOpen) pinnedOpen = false;
  if (next === collapsed) {
    if (next) notify();
    return;
  }
  collapsed = next;
  try {
    if (next) localStorage.setItem(SIDEBAR_COLLAPSED_KEY, "1");
    else localStorage.removeItem(SIDEBAR_COLLAPSED_KEY);
  } catch {
    /* 이번 실행에만 기억한다 */
  }
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useSidebarCollapsed(): boolean {
  return useSyncExternalStore(subscribe, getSidebarCollapsed, () => false);
}

export function useSidebarPinnedOpen(): boolean {
  return useSyncExternalStore(subscribe, getSidebarPinnedOpen, () => false);
}

export function useSidebarAutoClosed(): boolean {
  return useSyncExternalStore(subscribe, getSidebarAutoClosed, () => false);
}

/**
 * 제목줄 단추와 ⌘B가 읽는 「접힘」: 화면에 보이는 상태다. `routeOwnsList`(「내 작업」)에서는
 * 폭 규칙으로 세션 목록이 자동으로 접혀 있는 것도 접힘이다.
 */
export function useDisplayedSidebarCollapsed(routeOwnsList: boolean): boolean {
  const stored = useSidebarCollapsed();
  const auto = useSidebarAutoClosed();
  return stored || (routeOwnsList && auto);
}

/**
 * 접기·펴기 요청 한 곳. 펴기는 목록을 이번 실행에 붙박는다(폭 규칙이 다시 접지 않는다).
 * `apply`는 접힘 전이를 그리는 쪽(셸의 `requestCollapsedChange`)이고, 기본은 상태만 바꾼다.
 */
export function applySidebarListChange(
  nextCollapsed: boolean,
  apply: (next: boolean) => void = setSidebarCollapsed
): void {
  if (!nextCollapsed) pinSidebarListOpen();
  apply(nextCollapsed);
}

/** 시험 전용: 메모리 상태를 저장소에서 다시 읽는다. */
export function resetSidebarCollapsedForTest(): void {
  collapsed = load();
  pinnedOpen = false;
  autoClosed = false;
  notify();
}

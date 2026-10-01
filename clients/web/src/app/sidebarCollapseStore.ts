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

function load(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

let collapsed = load();
const listeners = new Set<() => void>();

export function getSidebarCollapsed(): boolean {
  return collapsed;
}

export function setSidebarCollapsed(next: boolean): void {
  if (next === collapsed) return;
  collapsed = next;
  try {
    if (next) localStorage.setItem(SIDEBAR_COLLAPSED_KEY, "1");
    else localStorage.removeItem(SIDEBAR_COLLAPSED_KEY);
  } catch {
    /* 이번 실행에만 기억한다 */
  }
  for (const listener of [...listeners]) listener();
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

/** 시험 전용: 메모리 상태를 저장소에서 다시 읽는다. */
export function resetSidebarCollapsedForTest(): void {
  collapsed = load();
  for (const listener of [...listeners]) listener();
}

import { useSyncExternalStore } from "react";

// 목록 열 본문 자리 (#3334). 「내 작업」의 세션 목록은 라우트(`LocalTerminalDock`)가 상태를
// 쥐고 있어 사이드바 안으로 옮길 수 없다. 대신 사이드바가 본문 자리(`sidebar-body-slot`)를
// 이 저장소에 내놓고, 도크가 그 자리에 목록을 포털로 그린다. 그래서 머리(검색·목적지)는
// 탭이 바뀌어도 같은 React 노드이고 바뀌는 것은 본문 자리의 내용뿐이다.

let slot: HTMLElement | null = null;
const listeners = new Set<() => void>();

export function setSidebarBodySlot(el: HTMLElement | null): void {
  if (slot === el) return;
  slot = el;
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useSidebarBodySlot(): HTMLElement | null {
  return useSyncExternalStore(subscribe, () => slot, () => null);
}

/**
 * 시험 전용: 사이드바 없이 도크를 그리는 시험에 본문 자리를 하나 세운다. 돌려주는 함수가 정리다.
 * 자리가 없으면 목록은 그려지지 않는다(셸이 자리를 내놓기 전에는 갈 곳이 없다).
 */
export function mountSidebarBodySlotForTest(): () => void {
  const el = document.createElement("div");
  el.setAttribute("data-testid", "sidebar-body-slot");
  document.body.append(el);
  setSidebarBodySlot(el);
  return () => {
    setSidebarBodySlot(null);
    el.remove();
  };
}

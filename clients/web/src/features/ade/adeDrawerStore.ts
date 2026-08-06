import { useSyncExternalStore } from "react";
import type { DialogFocusTarget } from "@/design/ui/dialog";

// =============================================================================
// 서랍이 열려 있는가 (이슈 1135) — 불리언 하나짜리 스토어.
//
// `useState` 로 셸에 두지 않은 이유가 성능이다. 요약 줄은 열린 턴이 있는 동안
// 1Hz 로 다시 그려야 하고(TTL 을 재고 서랍의 경과 시계를 굴린다), 그 시계를
// AppShell 에 두면 **사이드바와 라우트 전체가 초당 한 번 다시 렌더된다.** 시계는
// 그것을 쓰는 컴포넌트 안에 있어야 하고, 그러면 요약 줄과 서랍이 형제가 되어
// 상태를 공유할 자리가 없어진다 — 이 스토어가 그 자리다.
//
// AppShell 은 이 불리언 하나만 읽는다(덮인 라우트를 `inert` 로 빼내려고). 그
// 값은 사람이 누를 때만 바뀌므로 셸의 렌더는 상호작용당 한 번이다.
//
// 캐럿을 돌려줄 엘리먼트는 스냅샷에 넣지 않는다 — `workLogStore` 의 같은 규칙:
// DOM 노드를 스냅샷에 넣으면 값 비교가 참조 비교가 되고 구독자 전원이 그 노드를
// 들고 다니게 된다.
// =============================================================================

/**
 * 요약 줄의 `aria-controls` 와 서랍의 `id`. 둘이 같은 문자열을 봐야 하므로
 * 한 자리에 둔다 — 두 파일에 리터럴로 적히면 한쪽만 고쳐지는 날이 온다.
 */
export const ADE_DRAWER_DOM_ID = "ade-drawer";

let open = false;
const listeners = new Set<() => void>();
let pendingOpener: DialogFocusTarget | null = null;

function emit(next: boolean): void {
  if (open === next) return;
  open = next;
  for (const listener of listeners) listener();
}

export function openAdeDrawer(opener?: DialogFocusTarget | null): void {
  pendingOpener = opener ?? null;
  emit(true);
}

export function closeAdeDrawer(): void {
  emit(false);
}

/** 서랍이 마운트하면서 한 번 가져간다. 두 번째 호출은 null 을 받는다. */
export function takeAdeDrawerOpener(): DialogFocusTarget | null {
  const opener = pendingOpener;
  pendingOpener = null;
  return opener;
}

/** 테스트/진단 seam: React 구독 없이 현재 상태를 본다. */
export function adeDrawerSnapshot(): boolean {
  return open;
}

/** 세션 종료·워크스페이스 전환·테스트. */
export function resetAdeDrawer(): void {
  pendingOpener = null;
  emit(false);
}

/**
 * React 훅이 쓰는 구독. 이름을 붙여 내보내는 이유는 테스트가 **전이 횟수**를
 * 세야 하기 때문이다: `emit` 의 조기 반환(같은 값이면 알리지 않는다)은 구독자
 * 없이는 관측할 수 없고, 그 한 줄이 없으면 이미 열린 서랍을 다시 여는 클릭이
 * 셸을 한 번 더 렌더한다.
 */
export function subscribeAdeDrawer(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAdeDrawerOpen(): boolean {
  return useSyncExternalStore(
    subscribeAdeDrawer,
    adeDrawerSnapshot,
    adeDrawerSnapshot
  );
}

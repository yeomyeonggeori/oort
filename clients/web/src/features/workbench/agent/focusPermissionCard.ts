// =============================================================================
// 주소가 연 A 칸(`agentPanePath`)의 승인 카드에 초점을 둔다 (#5640, #5595 후속).
//
// 「작업 · 내 작업」의 「응답 필요」 줄과 권한 요청 배너는 그 세션의 A 칸을 연다. 격자는 칸을 활성으로 만들 뿐이라(#5595)
// 캐럿은 칸에 머문다. 승인 카드(`AgentProgressView`의 `agent-permission`)는 그 세션의 스레드를 읽은 뒤에야 선다 — 막 연 칸이면
// 몇 백 ms 뒤다. 그래서 카드가 설 때까지 칸을 지켜보다가 서면 한 번 초점을 둔다.
//
// - 상한: `PERMISSION_CARD_FOCUS_WAIT_MS`. 그 안에 카드가 서지 않으면(요청이 이미 닫혔다) 칸의 초점을 그대로 둔다.
// - 캐럿을 빼앗지 않는다: 그새 사람이 다른 곳(다른 칸·사이드바·입력)으로 갔으면 아무것도 하지 않는다.
// - 카드는 주인의 판에만 초점을 받는다(`tabindex`가 있는 판). 관전자 판에는 결정할 것이 없다.
// =============================================================================

/** 카드가 서기를 기다리는 상한. 스레드 첫 읽기가 이 안에 끝나지 않으면 칸의 초점을 그대로 둔다. */
export const PERMISSION_CARD_FOCUS_WAIT_MS = 4_000;

const CARD_SELECTOR = '[data-testid="agent-permission"][tabindex]';

/**
 * `root` 안에서 `paneId()` 칸의 승인 카드가 서면 초점을 둔다. 돌려준 함수로 멈춘다(칸을 다시 열거나 격자가 내려갈 때).
 * 카드가 이미 서 있으면 곧바로 둔다.
 */
export function focusPermissionCardWhenReady(
  root: HTMLElement | null,
  paneId: () => string,
  waitMs: number = PERMISSION_CARD_FOCUS_WAIT_MS
): () => void {
  if (root === null) return () => undefined;
  let stopped = false;
  let observer: MutationObserver | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const stop = () => {
    stopped = true;
    observer?.disconnect();
    observer = null;
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  /** 카드를 찾았으면(초점을 두었든, 사람이 다른 곳에 있어 두지 않았든) true. */
  const attempt = (): boolean => {
    const pane = root.querySelector<HTMLElement>(`[data-pane-id="${paneId()}"]`);
    const card = pane?.querySelector<HTMLElement>(CARD_SELECTOR) ?? null;
    if (pane === null || pane === undefined || card === null) return false;
    const active = document.activeElement;
    const free = active === null || active === document.body || pane.contains(active);
    if (free) card.focus();
    return true;
  };
  if (attempt()) return () => undefined;
  observer = new MutationObserver(() => {
    if (stopped) return;
    if (attempt()) stop();
  });
  observer.observe(root, { childList: true, subtree: true });
  timer = setTimeout(stop, waitMs);
  return stop;
}

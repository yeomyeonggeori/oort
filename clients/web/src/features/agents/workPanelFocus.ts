import { releaseInert } from "@/app/inert";
import { ROUTE_REGION_DOM_ID } from "@/app/shellNav";
import { adeDrawerSnapshot } from "@/features/ade/adeDrawerStore";
import { restoreDialogOpenerFocus, type DialogFocusTarget } from "@/design/ui/dialog";

// =============================================================================
// 작업 패널을 닫을 때 캐럿을 돌려주는 곳 (#5165).
//
// ## 폭마다 달랐던 이유
//
// 900px 아래에서 작업 패널은 라우트를 덮고, 셸은 덮인 라우트를 `inert`로 둔다(`AppShell`의 `useInertWhile`).
// 그런데 `closeWorkPanel()`은 상태를 바꿀 뿐이고 React는 그 커밋이 끝나야 `inert`를 걷는다. 그 전에 부르는
// `opener.focus()`는 inert 안의 요소를 거절한다: `isConnected`는 참이라 「돌려줬다」고 믿고, 캐럿은 `<body>`에 남는다.
// 넓은 폭에서는 라우트가 inert가 아니라 같은 호출이 먹는다. 사이드바 서랍(`AppShell.closeDrawer`)·관제 서랍
// (`AdeDrawer.close`)·작업 세션 서랍(`ChatShell`)이 이미 같은 순서를 지킨다: **덮인 표면의 inert를 먼저 걷고 나서 돌려준다.**
//
// ## 연 요소가 사라졌으면
//
// 끝난 요청 줄은 실시간 갱신으로 다시 그려질 수 있다(같은 run, 새 노드). 그 칩이 다시 서 있으면 그 칩이, 없으면 같은
// 메시지 행이, 그것도 없으면 라우트 상자가 캐럿을 받는다. `<body>`로 떨어지는 길은 없다.
// =============================================================================

/**
 * 캐럿이 어디로 돌아갔는가(시험이 읽는다). 숫자로 두는 이유: 문구가 아닌 낱말을 문자열로 적으면 직접 문구 장부가 문구
 * 후보로 센다.
 */
export const RETURNED = { opener: 0, sameRun: 1, sameRow: 2, route: 3, body: 4 } as const;
export type Returned = (typeof RETURNED)[keyof typeof RETURNED];

/** 열 때 적어 두는 이웃의 열쇠. 연 요소가 사라져도 같은 자리를 다시 찾는다. */
export interface PanelOpenerMemo {
  /** 소문자 run id. 같은 run의 요약 칩을 다시 찾는다. */
  runKey: string | null;
  /** 연 요소가 든 메시지 행의 id(`data-message-id`). */
  messageKey: string | null;
}

export function rememberPanelOpener(
  opener: Element | null,
  runId: string | null
): PanelOpenerMemo {
  const row = opener?.closest<HTMLElement>('[data-testid="timeline-message"]') ?? null;
  return {
    runKey: runId === null ? null : runId.toLowerCase(),
    messageKey: row?.getAttribute("data-message-id") ?? null,
  };
}

/** 같은 run의 요약 칩 단추(다시 그려진 새 노드). */
function sameRunChip(runKey: string | null): HTMLElement | null {
  if (runKey === null) return null;
  for (const slot of document.querySelectorAll<HTMLElement>('[data-testid="request-thought-slot"]')) {
    if (slot.getAttribute("data-run-id")?.toLowerCase() !== runKey) continue;
    const button = slot.querySelector<HTMLElement>('[data-testid="request-thought-line"]');
    if (button !== null) return button;
  }
  return null;
}

/** 같은 메시지 행. 초점을 받을 수 있게 만들어진 행(`tabindex`가 있는 것)만 쓴다. */
function sameMessageRow(messageKey: string | null): HTMLElement | null {
  if (messageKey === null) return null;
  for (const row of document.querySelectorAll<HTMLElement>('[data-testid="timeline-message"]')) {
    if (row.getAttribute("data-message-id") === messageKey && row.matches("[tabindex]")) return row;
  }
  return null;
}

/**
 * 돌려주고 **실제로 받았는지** 확인한다. `focus()`는 inert·숨김 안의 요소를 조용히 거절하고, 그 호출이 던지지도
 * 않으므로 「불렀다」는 「받았다」의 증거가 아니다.
 */
function tryFocus(target: DialogFocusTarget | null): boolean {
  if (!restoreDialogOpenerFocus(target)) return false;
  return !(target instanceof HTMLElement) || document.activeElement === target;
}

/**
 * 패널이 닫힌 직후 캐럿을 돌려준다. 호출 순서가 요점이다: `closeWorkPanel()` 다음에, 같은 동기 구간에서 부른다.
 * @returns 어디로 돌려줬는가. `RETURNED.body`는 돌려줄 곳이 하나도 없었다는 뜻이다.
 */
export function returnFocusAfterWorkPanelClose(
  opener: DialogFocusTarget | null,
  memo: PanelOpenerMemo | null
): Returned {
  const route = document.getElementById(ROUTE_REGION_DOM_ID);
  // 관제 서랍이 라우트를 덮고 있으면 inert는 서랍의 몫이다(그 서랍이 닫힐 때 걷는다).
  if (!adeDrawerSnapshot()) releaseInert(route);
  if (tryFocus(opener)) return RETURNED.opener;
  const chip = sameRunChip(memo?.runKey ?? null);
  if (chip !== null && chip !== opener && tryFocus(chip)) return RETURNED.sameRun;
  const row = sameMessageRow(memo?.messageKey ?? null);
  if (row !== null && tryFocus(row)) return RETURNED.sameRow;
  if (route !== null && tryFocus(route)) return RETURNED.route;
  return RETURNED.body;
}

import { useCallback, useEffect, useLayoutEffect, type RefObject } from "react";
import { ROW_ACTIONS_SHORTCUT } from "@/app/keyboardShortcuts";

// =============================================================================
// 한 행 = 탭 스톱 하나 (B11 R2 H1).
//
// **왜.** 1라운드는 액션 바를 `opacity-0`으로만 숨겼다. 투명한 버튼은 여전히
// 포커스를 받으므로, 화면에 아무것도 없는 행마다 최대 여섯 개의 탭 스톱이
// 깔려 있었다. 반응 칩과 스레드 앵커까지 세면 가상 목록 20행에서 타임라인을
// 지나 컴포저에 닿는 데 100번 가까이 Tab을 눌러야 했다. MOMO-626 R1 M8은
// **에이전트 그룹마다 탭 스톱이 하나 느는 것만으로** 되돌린 판정이다.
//
// **그래서 무엇을.** 행 안의 컨트롤들은 하나의 로빙 그룹이 된다. 그 중 정확히
// 하나만 `tabIndex=0`이고 나머지는 `-1`이다. Tab은 행을 한 번에 지나가고,
// 행 안에서는 ←/→가 컨트롤 사이를 돈다. 툴바 항목도 이 그룹의 구성원이다
// (#1743 M-2: 툴바 안 별도 링 금지).
//
// **actionable 포인터 행의 rest 정거장은 행 자신이다** (W-4, #1743 B-2/H-1).
// 아바타를 승격하지 않는다. 행이 **키보드** 포커스(`:focus-visible`)를 받으면
// 툴바가 마운트되고, 포커스는 preferred 항목(⋯)으로 핸드오프된다. 마우스
// mousedown이 행을 포커스해도 핸드오프하지 않는다 — `focus({focusVisible})`
// 강제는 클릭에 호박색 링을 그리고 본문 드래그 선택을 접는다 (#1743 B-4).
// `normalizeRow`는 그 핸드오프가 끝나기 전에 행의 tabindex를 떼지 않는다.
// 순회 중 재실행해도 행당 정거장은 1이다.
//
// **왜 ↑/↓가 아니라 ←/→인가.** 위아래는 이미 타임라인을 스크롤한다. 그것을
// 가로채면 메시지를 읽으려는 사람에게서 스크롤을 빼앗는 셈이다.
//
// **왜 `tabIndex`를 JSX가 아니라 DOM에 쓰는가.** 그룹의 구성원이 행마다 다르고
// (반응이 없는 행에는 칩이 없다) 시간에 따라 변한다(반응이 하나 달리면 컨트롤
// 이 생긴다). 각 컴포넌트에 인덱스를 내려보내면 세 파일이 서로의 순서를 알아야
// 하는데, 그건 DOM이 이미 정확히 알고 있는 사실이다. React가 관리하지 않는
// 속성만 건드리므로(JSX에 `tabIndex`를 쓰지 않는다) 리렌더가 이 값을 되돌려
// 놓지도 않는다.
// =============================================================================

/**
 * 로빙 그룹의 구성원임을 선언하는 속성. 값이 `"primary"`인 요소가 있으면 그것이
 * 기본 진입점이 된다 — 행의 액션 진입점(⋯)은 DOM 순서로는 마지막이지만
 * 사람이 이 행에서 가장 먼저 찾는 것이기 때문이다.
 */
export const ROW_ACTION_SELECTOR = "[data-row-action]";

/** 순환하는 다음 인덱스. 처리하지 않는 키에는 `null`. */
export function nextRovingIndex(
  current: number,
  count: number,
  key: string
): number | null {
  if (count === 0) return null;
  if (!ROW_ACTIONS_SHORTCUT.matches({ key })) return null;
  if (key === "ArrowRight") return (current + 1) % count;
  return (current - 1 + count) % count;
}

/**
 * 지금 이 행에서 실제로 포커스를 받을 수 있는 컨트롤들.
 *
 * `disabled`와 `display:none`을 빼는 것이 핵심이다. 호버 툴바는 hover가 없는
 * 기기와 비호버 행에서 마운트 자체가 없고, 칩은 삭제된 메시지에서 disabled가
 * 된다. 둘 중 하나를 그룹의 유일한 구성원으로 골라 두면 그 행에는 아예 닿을
 * 수 없는 탭 스톱 하나가 남는다.
 */
function rowActionItems(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(ROW_ACTION_SELECTOR)
  ).filter(
    (el) =>
      !el.hasAttribute("disabled") &&
      // `offsetParent === null`은 이 요소나 조상이 `display:none`이라는 뜻이다.
      el.offsetParent !== null
  );
}

function preferredIndex(items: HTMLElement[]): number {
  const primary = items.findIndex(
    (el) => el.getAttribute("data-row-action") === "primary"
  );
  return primary >= 0 ? primary : 0;
}

function hasPrimary(items: HTMLElement[]): boolean {
  return items.some((el) => el.getAttribute("data-row-action") === "primary");
}

function isActionableRow(root: HTMLElement): boolean {
  return root.getAttribute("data-actionable") === "true";
}

function setItemTabStops(items: HTMLElement[], active: number): void {
  for (let i = 0; i < items.length; i++) {
    items[i].tabIndex = i === active ? 0 : -1;
  }
}

function restStationOnRow(root: HTMLElement, items: HTMLElement[]): void {
  root.tabIndex = 0;
  for (const item of items) item.tabIndex = -1;
}

/**
 * 행 요소에 붙인다. 돌려주는 것은 그 행에 걸 `onKeyDown` 하나뿐이다.
 */
export function useRowRovingFocus(
  ref: RefObject<HTMLElement | null>
): (event: React.KeyboardEvent) => void {
  // 의존성 배열이 없는 것은 의도다. 그룹의 구성원은 렌더마다 달라질 수 있고
  // (반응이 하나 달리면 칩이 생긴다), 새로 생긴 버튼의 기본 `tabIndex`는 0이라
  // 정규화하지 않으면 그 순간 탭 스톱이 하나 늘어난다. 하는 일은 작은 서브트리
  // 하나의 querySelectorAll이다.
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const normalize = () => {
      normalizeRow(root);
    };
    normalize();
    // 렌더 밖에서 태어나는 구성원(#1718 리뷰 Blocker-1의 뿌리). 언퍼얼 카드와
    // 제거 X는 자기 스토어 구독으로 **행 리렌더 없이** 마운트되는 첫 액세서리라,
    // 위 정규화가 지나간 뒤 기본 tabIndex 0으로 태어나 「행 하나 = 탭 스톱
    // 하나」를 조용히 깬다. 구성원 목록의 정본은 DOM이므로(파일 머리말), DOM의
    // 변화 통지로 같은 정규화를 다시 돈다 — React를 거치지 않는 사실에는 React
    // 를 거치지 않는 귀가 맞다.
    const observer = new MutationObserver(normalize);
    observer.observe(root, { childList: true, subtree: true });
    // 포커스가 행을 **떠나면** 정거장을 기본 진입점(primary)으로 되돌린다.
    // 로빙의 「마지막 방문 기억」은 행 안에 머무는 동안의 예의고, 떠난 뒤의
    // 다음 Tab 진입은 언제나 「사람이 이 행에서 가장 먼저 찾는 것」(파일 머리말)
    // 이어야 한다 — 이 복원이 없으면 앞선 상호작용이 남긴 임의 구성원이
    // 정거장으로 굳어, 행마다 Tab 도착지가 이력에 따라 달라진다(#1718 Blocker-1).
    const onFocusOut = (event: FocusEvent) => {
      const next = event.relatedTarget;
      if (next instanceof Node && root.contains(next)) return;
      normalizeRow(root, { resetToPreferred: true });
    };
    root.addEventListener("focusout", onFocusOut);
    return () => {
      observer.disconnect();
      root.removeEventListener("focusout", onFocusOut);
    };
  });

  return useCallback(
    (event: React.KeyboardEvent) => {
      const root = ref.current;
      if (!root) return;
      const items = rowActionItems(root);
      const current = items.indexOf(document.activeElement as HTMLElement);
      // 포커스가 이 그룹 밖(편집기 입력창, 열린 메뉴)에 있으면 남의 키다.
      if (current < 0) return;
      const next = nextRovingIndex(current, items.length, event.key);
      if (next === null) return;
      event.preventDefault();
      items[current].tabIndex = -1;
      items[next].tabIndex = 0;
      items[next].focus();
    },
    [ref]
  );
}

export function normalizeRow(
  root: HTMLElement,
  options?: { resetToPreferred?: boolean }
): void {
  const items = rowActionItems(root);
  const activeEl = document.activeElement;
  const rowHoldsFocus = activeEl === root;
  const focusedItem = options?.resetToPreferred
    ? -1
    : items.findIndex((el) => el === activeEl);
  const actionable = isActionableRow(root);

  if (items.length === 0) {
    // **컨트롤이 하나도 없는 행은 자기 자신이 정거장이 된다** (리뷰 W-4).
    //
    // 이 규칙이 지키는 것은 「행 하나 = 탭 스톱 하나」의 나머지 절반이다. 위
    // 문단은 여섯 개를 하나로 줄이는 이야기였고, 여기는 **0개를 하나로 올리는**
    // 이야기다. 액션 없이 마운트되는 표면(작업 세션 이벤트 로그, 읽기 전용
    // 스레드)과 액션을 내놓지 않는 행(삭제된 메시지)에는 포커스 받을 자식이
    // 없어서, 거터의 시각을 드러내는 `group-focus-within`이 걸릴 자리가 아예
    // 없었다 — 눈으로 읽으며 키보드만 쓰는 사람에게는 시각으로 가는 길이
    // 하나도 없었다는 뜻이다(보조기술은 `<time>`이 DOM에 있어 영향 없다).
    //
    // 예산은 늘지 않는다: 이 갈래가 도는 행은 정의상 다른 정거장이 0개다.
    // `:focus-within`은 **자기 자신이 포커스일 때도** 참이므로 시각을 드러내는
    // 규칙은 이미 있는 그것을 그대로 쓴다.
    root.tabIndex = 0;
    return;
  }

  // 행이 포커스를 들고 있는 동안에는 정거장을 빼앗지 않는다 (#1743 B-2).
  // 툴바 마운트 → MutationObserver → 여기서 tabindex를 떼면 Chrome이 포커스를
  // BODY로 떨어뜨린다. 핸드오프가 ⋯에 옮긴 뒤에야 행에서 뗀다.
  if (rowHoldsFocus) {
    restStationOnRow(root, items);
    return;
  }

  if (focusedItem >= 0) {
    if (root.hasAttribute("tabindex")) root.removeAttribute("tabindex");
    setItemTabStops(items, focusedItem);
    return;
  }

  // 로빙 그룹 밖(링크·카드·디스클로저)에 포커스가 있다. 아바타를 승격하지
  // 않는다. 툴바가 떠 있으면 ⋯만 구성원 정거장으로 두어 Tab이 닿게 한다.
  const inside =
    activeEl instanceof Node && root.contains(activeEl) && !options?.resetToPreferred;
  if (actionable && inside) {
    if (root.hasAttribute("tabindex")) root.removeAttribute("tabindex");
    if (hasPrimary(items)) {
      setItemTabStops(items, preferredIndex(items));
    } else {
      for (const item of items) item.tabIndex = -1;
    }
    return;
  }

  // Rest, 또는 행을 떠난 뒤의 복원. actionable 행은 행 자신이 정거장이다.
  if (actionable) {
    restStationOnRow(root, items);
    return;
  }

  if (root.hasAttribute("tabindex")) root.removeAttribute("tabindex");
  setItemTabStops(items, preferredIndex(items));
}

/**
 * 행이 키보드로 포커스를 들고 있는가. 마우스 mousedown 포커스는
 * `:focus-visible`이 아니라서 여기서 거짓이다.
 */
export function isKeyboardRowFocus(root: HTMLElement): boolean {
  if (document.activeElement !== root) return false;
  try {
    return root.matches(":focus-visible");
  } catch {
    return false;
  }
}

/**
 * 행이 키보드 포커스를 들고 있고 툴바가 마운트됐으면 ⋯로 옮긴다.
 * 포인터 hover 마운트는 activeElement가 행이 아니므로 포커스를 훔치지 않는다.
 * 마우스 mousedown 포커스는 `:focus-visible`이 아니라서 아무것도 하지 않는다
 * (#1743 B-4). 키보드 경로의 모달리티는 평범한 `focus()`로 승계된다.
 */
export function handoffRowFocusToPreferred(root: HTMLElement): void {
  if (!isKeyboardRowFocus(root)) return;
  const items = rowActionItems(root);
  const primary = items.find(
    (el) => el.getAttribute("data-row-action") === "primary"
  );
  const target = primary ?? items[0];
  if (!target) return;
  target.focus();
  normalizeRow(root);
}

/** 행이 키보드 포커스를 들고 툴바가 떠 있으면 ⋯로 핸드오프한다. */
export function useHoverToolbarFocusHandoff(
  ref: RefObject<HTMLElement | null>,
  toolbarMounted: boolean,
  rowFocused = toolbarMounted
): void {
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root || !toolbarMounted || !rowFocused) return;
    if (!isKeyboardRowFocus(root)) return;
    handoffRowFocusToPreferred(root);
  }, [ref, toolbarMounted, rowFocused]);
}

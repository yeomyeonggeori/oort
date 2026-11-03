/** A selected message belongs to the browser's native context menu. */
export function selectionIsWithinRow(
  root: Pick<HTMLElement, "contains"> | null,
  selection: Pick<Selection, "isCollapsed" | "anchorNode" | "focusNode"> | null
): boolean {
  if (root === null || selection === null || selection.isCollapsed) return false;
  return (
    (selection.anchorNode !== null && root.contains(selection.anchorNode)) ||
    (selection.focusNode !== null && root.contains(selection.focusNode))
  );
}

// =============================================================================
// 우클릭이 브라우저 기본 메뉴에 양보하는 때 (#5192)
//
// 행 안에서 사용자가 글을 골라 두었으면(드래그·더블클릭) 우클릭은 브라우저 기본 메뉴(복사 등)의 몫이다. 문제는 **엔진이 우클릭
// 때문에 스스로 만드는 선택**이다. macOS WebKit(Safari·Tauri WKWebView)은 우클릭한 낱말을 먼저 고르고(`EventHandler::
// sendContextMenuEvent`: 클릭 자리가 기존 선택 안이 아니면 가장 가까운 낱말을 선택) 그 **뒤에** `contextmenu`를 쏜다. 그래서 그 시점의
// 「이 행 안의 펼친 선택」은 사용자가 고른 것이 아니라 엔진이 방금 만든 것인데, 예전 규칙(지금 선택이 있으면 양보)은 둘을 못 갈라서
// 글자 위 우클릭이 늘 기본 메뉴로 양보했다(앱 메뉴가 안 열림). Chromium은 선택을 만들지 않아 문제가 없었다.
//
// 가르는 방법: 우클릭을 **누르는 순간**(`pointerdown`, 엔진의 낱말 선택보다 앞)의 선택 상태를 기억하고, `contextmenu` 때 비교한다.
//   · 누르기 전에 이 행에 선택이 있었다 → 사용자가 고른 선택: 양보한다(기본 메뉴).
//   · 누르기 전엔 없었는데 지금 있다 → 엔진이 만든 낱말 선택: 양보하지 않고, 그 선택은 지운다(메뉴가 닫힌 뒤 낱말이 파랗게 남지 않고,
//     선택이 있는 동안 숨는 호버 도구 막대가 돌아오게).
//   · 누른 적이 없다(키보드 Shift+F10·메뉴 키) → 지금 선택이 있으면 양보한다(예전 규칙 그대로).
// =============================================================================

/** 우클릭을 누르는 입력인가: 보조 버튼, 또는 macOS 의 Ctrl+클릭(그 입력도 `contextmenu`를 쏜다). */
export function isContextPress(event: {
  button: number;
  ctrlKey: boolean;
}): boolean {
  return event.button === 2 || (event.button === 0 && event.ctrlKey);
}

/**
 * 이 우클릭을 브라우저 기본 메뉴에 양보할까. `selectedBeforePress`는 누르는 순간 이 행에 선택이 있었는지(`null` = 누른 기록 없음),
 * `selectedNow`는 `contextmenu` 시점의 선택이다.
 */
export function shouldYieldContextMenu(
  selectedBeforePress: boolean | null,
  selectedNow: boolean
): boolean {
  if (selectedBeforePress === null) return selectedNow;
  return selectedBeforePress && selectedNow;
}

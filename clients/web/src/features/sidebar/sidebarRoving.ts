// =============================================================================
// 사이드바 행 사이의 ↑/↓ 순회, 그리고 그 순회가 **어디까지인가**
// (design-review #1937 B-1).
//
// ## 실측 결함
//
// 이 순회는 사이드바 트리 전체에 걸린 한 개의 React `onKeyDown` 이었다. 그런데
// **React 포털 이벤트는 DOM 트리가 아니라 React 트리로 버블한다**: 행이 연
// 컨텍스트 메뉴는 `document.body` 로 포털되지만 React 상으로는 여전히 이
// 핸들러의 자손이다. 그래서 메뉴 안에서 누른 ↓ 가 여기까지 올라왔고, 핸들러는
// `rows.indexOf(document.activeElement)` 가 -1(캐럿이 메뉴 항목에 있다)이라
// `rows[1]` 로 포커스를 옮겼다 — 실측: ↓ 한 번에 메뉴가 사라지고 캐럿이
// 「활동」에 섰다. 포커스가 비모달 메뉴 밖으로 나가는 순간 Radix 가 dismiss 하니
// 다섯 항목 중 어느 것도 키보드로 실행할 수 없었다.
//
// ## 왜 「경계를 세우는」 갈래인가
//
// 세 갈래가 있었다 — ①로빙이 자기 목록 안의 키만 처리 ②메뉴가 열린 동안 로빙이
// 후퇴 ③로빙을 DOM 리스너로 이관.
//
// ②는 표면마다 「지금 열려 있나」를 위로 올려 보내야 하고, 그 배선을 잊은 다음
// 표면에서 같은 결함이 조용히 되살아난다. ③은 React 밖에 리스너를 하나 더 두는
// 값을 치르면서 같은 답에 도달한다. ①은 **질문 자체를 옳게** 만든다: 이 순회가
// 답해야 하는 것은 「사이드바 목록 안에서 눌렀나」이고, 그 판정의 정본은 React
// 트리가 아니라 DOM 트리다. 포털이 하나 더 생겨도 규칙은 그대로다.
//
// 순수 함수로 빼 둔 이유는 시험이 **같은 정본을 소비**하기 위해서다. 컴포넌트
// 안에 남겨 두면 회귀 시험이 핸들러를 손으로 베껴 쓰게 되고, 베낀 사본은
// 거짓말한다.
// =============================================================================

/** 이 순회가 다루는 키인가. */
export function isSidebarRoveKey(key: string): boolean {
  return key === "ArrowDown" || key === "ArrowUp";
}

/**
 * ↑/↓ 로 사이드바 행 사이를 걷는다. 실제로 옮겼으면 `true`.
 *
 * `target` 이 `root` 의 **DOM 자손**이 아니면 아무것도 하지 않는다 — 포털로 뜬
 * 메뉴·다이얼로그 안의 키는 그 표면의 것이다(위 머리말).
 */
export function roveSidebarRows(
  root: HTMLElement | null,
  event: {
    key: string;
    target: EventTarget | null;
    preventDefault: () => void;
  }
): boolean {
  if (!isSidebarRoveKey(event.key)) return false;
  if (!root) return false;
  const target = event.target;
  if (!(target instanceof Node) || !root.contains(target)) return false;
  const rows = Array.from(
    root.querySelectorAll<HTMLElement>("[data-sidebar-row]")
  );
  if (rows.length === 0) return false;
  const index = rows.indexOf(root.ownerDocument.activeElement as HTMLElement);
  const step = event.key === "ArrowDown" ? 1 : -1;
  const next = rows[(Math.max(index, 0) + step + rows.length) % rows.length];
  if (!next) return false;
  event.preventDefault();
  next.focus();
  return true;
}

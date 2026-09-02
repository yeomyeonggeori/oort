// =============================================================================
// 행을 옮기는 액션이 끝난 뒤 캐럿이 가는 곳 (design-review #1933 H-1).
//
// ## 실측 결함
//
// 사이드바 행 메뉴의 세 항목 — 「별표 붙이기」·「별표 떼기」·「섹션으로 이동」 —
// 은 전부 **그 행을 다른 섹션으로 옮긴다**. 그런데 메뉴를 이고 있는 트리거가 그
// 행 안에 살아서, 행이 옮겨 가는 순간 함께 언마운트된다. Radix 는 닫으면서
// 트리거로 포커스를 되돌리려 하지만 되돌릴 트리거가 이미 없다 — 실측:
// Shift+F10 → 「별표 붙이기」 Enter 뒤 `document.activeElement === BODY`,
// `:focus-visible` 없음, 사이드바로 돌아오는 데 **18탭**.
//
// 「섹션으로 이동」은 BT-4 부터 같은 구멍이었다(리뷰 실측). 그래서 수리도 한
// 자리다: **행을 옮기는 액션은 옮겨간 그 행으로 캐럿을 넘긴다.**
//
// ## 왜 「그 행」인가
//
// 세 갈래가 있었다 — ①옮겨간 행 ②그 행이 도착한 섹션의 머리글 ③메뉴를 열기 전
// 정거장(원래 행이 있던 자리의 이웃).
//
// ①이다. 사람이 방금 한 일이 「이 채널을 저기로 보냈다」이므로 그 결과를 보는
// 자리가 곧 다음 정거장이고, 캐럿이 거기 있으면 ↑/↓ 로빙이 **새 이웃들** 사이를
// 걷는다 — 옮긴 결과를 확인하는 가장 짧은 길이다. ②는 한 칸 위에서 시작해 도착을
// 눈으로 찾게 하고, ③은 방금 한 일을 되돌아보지 못하게 한다.
//
// ## 왜 rAF 인가
//
// 이 함수를 부르는 시점에 행은 아직 **옛 자리**에 있다: 편집은 React 상태이고,
// 커밋은 이 이벤트 핸들러가 끝난 뒤에 온다. `useEffect` 로 미루는 길도 있었지만
// 그러면 Radix 의 닫힘 복귀(자기 effect·cleanup)와 같은 틱에서 순서를 다투게 되고,
// 그 순서는 Radix 판올림이 바꿀 수 있다. 프레임 하나 뒤는 **커밋도 복귀도 끝난
// 뒤**라, 마지막에 말하는 쪽이 우리다.
//
// 이 파일이 순수 함수를 내주는 이유는 `sidebarRoving.ts` 와 같다: 회귀 시험이
// 컴포넌트 안의 사본이 아니라 **같은 정본**을 소비해야 한다.
// =============================================================================

/** 이 행들이 로빙의 정거장이다(`sidebarRoving.ts` 와 같은 표식). */
const ROW_SELECTOR = "[data-sidebar-row][data-channel-id]";

/**
 * 이 채널의 행. 없으면 `null` — 옮긴 뒤 그 채널이 사라졌거나(탈퇴) 접힌 섹션에
 * 들어갔을 수 있고, 그때는 아무 데도 캐럿을 두지 않는 것이 옳다. 없는 자리로
 * 밀어 넣으면 그것이 곧 `<body>` 다.
 *
 * id 를 선택자에 이어 붙이지 않는다: 채널 id 는 서버가 준 문자열이고, 선택자에
 * 넣는 순간 그 문자열의 문법이 이 함수의 문법이 된다. 목록을 훑어 비교하는 쪽이
 * 값이 같고 안전하다(`uuidEq` 와 같은 대소문자 무시 비교).
 */
export function findSidebarChannelRow(
  root: ParentNode,
  channelId: string
): HTMLElement | null {
  const key = channelId.trim().toLowerCase();
  for (const row of Array.from(
    root.querySelectorAll<HTMLElement>(ROW_SELECTOR)
  )) {
    if ((row.dataset.channelId ?? "").trim().toLowerCase() === key) return row;
  }
  return null;
}

/**
 * 옮겨간 행으로 캐럿을 넘긴다. 실제로 넘겼으면 `true`.
 *
 * 포인터로 고른 사람에게는 아무 표시도 남지 않는다(`:focus-visible` 이 서지
 * 않는다) — 이 줄이 값을 하는 것은 키보드로 온 경로뿐이고, 그래서 조건을 두지
 * 않는다. 조건을 두려면 「어떻게 열었는가」를 메뉴가 기억해야 하고, 그 기억은
 * 포털·재열기·터치를 지나며 반드시 틀린다.
 */
export function focusSidebarChannelRow(
  root: ParentNode,
  channelId: string
): boolean {
  const row = findSidebarChannelRow(root, channelId);
  if (!row) return false;
  row.focus();
  return true;
}

/**
 * 다음 프레임에 넘긴다 (위 「왜 rAF 인가」).
 *
 * `requestAnimationFrame` 이 없는 곳(구형 웹뷰·서버 렌더)에서는 그냥 아무 일도
 * 하지 않는다 — 포커스를 옮기지 못하는 것은 오늘까지의 동작이고, 예외를 던지는
 * 것은 사이드바 전체를 죽이는 일이다.
 */
export function scheduleSidebarChannelRowFocus(
  channelId: string,
  root: ParentNode | null = typeof document === "undefined" ? null : document
): void {
  if (!root || typeof requestAnimationFrame !== "function") return;
  requestAnimationFrame(() => {
    focusSidebarChannelRow(root, channelId);
  });
}

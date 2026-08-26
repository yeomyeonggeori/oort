import { useEffect, useRef } from "react";

// =============================================================================
// Esc 는 **가장 위 층**의 것이다 (design-review ADE 2단계 H1 ①).
//
// 라우트를 덮는 층이 이 앱에 셋 있다: 폰 폭의 사이드바 서랍, 작업 패널
// (`AgentWorkPanel`), ADE 관제 서랍. 셋 다 자기 주석에 "Esc 는 언제나 가장 위
// 층의 것이다"라고 적어 두고 각자 `window` 의 **캡처 단계**에 리스너를 달았다.
// 그 주석은 참이 아니었다: `stopPropagation` 은 다음 **노드**로 가는 전파만
// 막고, 같은 노드 같은 단계에 걸린 다른 리스너는 그대로 돈다. 작업 패널을 열어
// 둔 채 서랍을 열고 Esc 를 한 번 누르면 둘이 함께 닫혔다 — 사람이 한 번 누른
// 것으로 두 층이 사라졌고, 그중 하나는 아직 보고 있던 것이다.
//
// 그래서 층을 **스택**으로 만든다. 리스너는 이 모듈에 한 벌뿐이고, 그 한 벌이
// 스택 맨 위 층에게만 넘긴다. 이제 "가장 위 층"은 주석이 아니라 자료구조다.
//
// ## 순서
//
// 등록 순서 = 마운트 순서이고, 이 셋은 나중에 마운트한 것이 실제로 위에 있다.
// 서랍은 패널 위에 열리고(패널이 먼저 있었다), 카드를 눌러 패널을 열 때는 서랍이
// **먼저** 물러나므로(AdeDrawer.openItem) 둘이 겹친 채 순서가 뒤집히는 자리는
// 없다. 층이 하나 더 생기면 그때도 규칙은 같다: 늦게 덮은 것이 위다.
//
// ## 다이얼로그·메뉴
//
// Radix 다이얼로그(⌘K 팔레트·채널 만들기·에이전트 프로필)가 열려 있으면 어느
// 층도 받지 않는다. 그때 가장 위는 그 다이얼로그이고 Radix 가 자기 Esc 를 갖는다.
// 세 표면이 각자 적어 두었던 이 예외를 여기 한 번만 적는다.
//
// 드롭다운 메뉴도 같다 (UX-D4 #1756). `role="menu"` 는 다이얼로그가 아니라서
// 옛 술어가 통과시켰고, 폰 서랍 안에서 프로필 카드를 연 뒤 Esc 한 번이 카드를
// 건너뛰고 서랍을 닫았다. 메뉴가 열려 있는 동안도 가장 위는 그 메뉴다.
//
// ## 왜 캡처 단계이고, 왜 `stopImmediatePropagation` 까지 부르는가
//
// 캡처인 이유는 사이드바 서랍이 이미 적어 둔 그대로다: 설정 라우트가 window 에서
// Esc 를 듣고 뒤로 가는데, 버블 단계에서 먼저 도는 그 리스너를 그대로 두면 서랍을
// 닫으려던 한 번이 라우트 이동까지 해버린다. 덮고 있는 층이 대상에 닿기 전에
// 자기 것을 가져간다.
//
// `stopImmediatePropagation` 은 그 다음 구멍을 막는다: 이 모듈 **뒤에** window 에
// Esc 리스너를 하나 더 다는 코드가 생겨도 그것은 돌지 않는다. 앞에 등록된
// 리스너까지 막지는 못하고 — 그 판이 정확히 이 결함이 났던 판이라 게이트의
// red seam(`ADE_GATE_PROVE_RED_ESC`)이 그것을 재현한다 — 그래서 층을 여는 표면은
// 리스너를 직접 달지 않고 이 훅만 쓴다.
// =============================================================================

// ## 닫히는 층과 삼키는 층 (#1205 R2 신규 H)
//
// 층이라고 해서 전부 Esc 로 닫히는 것은 아니다. 되돌릴 수 없는 값을 들고 있는
// 표면 — 서버가 원문을 보관하지 않는 웹훅 일회성 비밀값 카드가 그것이다 — 에서
// Esc 의 올바른 뜻은 **아무 일도 일어나지 않는다**이다. 그런데 그 뜻도 누군가
// 소유해야 성립한다: 삼키지 않으면 밑에 있는 설정 라우트가 자기 뜻(뒤로 가기)으로
// 처리해 버리고, 그 한 번에 다시 볼 수 없는 값이 사라진다(실측 — 리뷰 R2).
// 그래서 `useEscapeGuard` 는 층을 잡되 아무것도 하지 않는다.
export interface EscapeLayer {
  /** 이 층을 닫는다. 스택 맨 위일 때만 불린다. 삼키는 층은 아무것도 안 한다. */
  handle: () => void;
}

const stack: EscapeLayer[] = [];
let installed = false;

/** 지금 열려 있는 층의 수. 테스트와 진단이 읽는다. */
export function escapeLayerDepth(): number {
  return stack.length;
}

/**
 * 맨 위 층에게 Esc 를 넘긴다. 넘겼으면 `true`.
 *
 * `blocked` 는 "지금 가장 위에 있는 것이 우리 층이 아니다"(다이얼로그가 열려
 * 있다)라는 뜻이다. DOM 조회를 인자로 받는 이유는 이 함수가 브라우저 없이도
 * 도는 순수 함수여야 테스트가 층 순서 자체를 잴 수 있기 때문이다.
 */
export function runTopEscapeLayer(blocked: boolean): boolean {
  if (blocked) return false;
  const top = stack[stack.length - 1];
  if (top === undefined) return false;
  top.handle();
  return true;
}

export function pushEscapeLayer(layer: EscapeLayer): void {
  stack.push(layer);
  install();
}

export function removeEscapeLayer(layer: EscapeLayer): void {
  const index = stack.lastIndexOf(layer);
  if (index >= 0) stack.splice(index, 1);
  uninstall();
}

/** 테스트 seam: 남아 있는 층을 전부 버린다. */
export function resetEscapeLayers(): void {
  stack.length = 0;
  uninstall();
}

function dialogIsOpen(): boolean {
  if (typeof document === "undefined") return false;
  return (
    document.querySelector('[role="dialog"][data-state="open"]') !== null ||
    document.querySelector('[role="menu"][data-state="open"]') !== null
  );
}

/**
 * Esc 에 이미 임자가 있는가 — 층이 서 있거나 다이얼로그가 열려 있다.
 *
 * 층을 열지 **않는** 표면이 window 에서 Esc 를 직접 듣는 자리(설정 라우트의
 * 뒤로 가기)를 위한 술어다. 그 자리의 규칙은 태그 목록이 아니라 이것이어야
 * 한다: 지금 화면에 층이 있으면 Esc 는 그 층의 것이고, 아래 라우트는 자기
 * 것으로 처리하지 않는다.
 *
 * 무엇이 이미 참이고 무엇이 새로 참이 되는지 (#1205 R2, 실측):
 *   - 층이 서 있을 때는 위의 캡처 리스너가 이미 전파를 끊으므로 라우트의
 *     리스너가 돌지 않는다. 이 술어는 그 규칙을 **판정하는 자리에 적어 두는**
 *     것이지, 혼자 그 일을 하는 것이 아니다.
 *   - 다이얼로그·메뉴는 다르다. Radix 는 층 스택에 들어오지 않고 네이티브 이벤트의
 *     전파도 끊지 않는다. 그런데도 ⌘K 팔레트에서 이 사고가 나지 않았던 이유는
 *     **포커스가 팔레트의 입력 칸에 있었기 때문**이다 — 라우트의 옛 면제가
 *     `INPUT` 을 통과시켰다. 즉 안전이 포커스 위치에 얹혀 있었다. 포커스가
 *     입력 칸 밖으로 나간 순간(항목 이동·프로그램적 blur) 같은 Esc 가 팔레트와
 *     라우트를 함께 닫는다. 이 술어는 그 우연을 이유로 바꾼다. 프로필 카드
 *     메뉴(`role="menu"`)도 같은 면제에 들어간다: 없으면 서랍 층이 한 번에 닫힌다.
 */
export function escapeIsClaimed(): boolean {
  return stack.length > 0 || dialogIsOpen();
}

function onKeyDown(event: KeyboardEvent): void {
  if (event.key !== "Escape") return;
  if (!runTopEscapeLayer(dialogIsOpen())) return;
  event.stopImmediatePropagation();
  event.stopPropagation();
  event.preventDefault();
}

function install(): void {
  if (installed || typeof window === "undefined") return;
  window.addEventListener("keydown", onKeyDown, true);
  installed = true;
}

function uninstall(): void {
  if (!installed || stack.length > 0 || typeof window === "undefined") return;
  window.removeEventListener("keydown", onKeyDown, true);
  installed = false;
}

/**
 * 이 표면이 열려 있는 동안 Esc 층 하나를 잡는다.
 *
 * @param active 층이 서 있는가. `false` 면 등록하지 않는다 — 닫힌 표면이 스택에
 *   남아 있으면 그것이 곧 "가장 위 층"이 되어 Esc 가 아무 일도 안 하게 된다.
 * @param onEscape 닫는 방법. 매 렌더 새 함수여도 층은 다시 등록되지 않는다
 *   (ref 로 최신 것을 본다): 콜백이 바뀔 때마다 등록을 반복하면 그 층이 스택
 *   맨 위로 올라가 아래에 있어야 할 층을 앞지른다.
 */
export function useEscapeLayer(active: boolean, onEscape: () => void): void {
  const handler = useRef(onEscape);
  useEffect(() => {
    handler.current = onEscape;
  }, [onEscape]);
  useEffect(() => {
    if (!active) return;
    const layer: EscapeLayer = { handle: () => handler.current() };
    pushEscapeLayer(layer);
    return () => removeEscapeLayer(layer);
  }, [active]);
}

/** 삼키는 층은 아무것도 하지 않는다. 하는 일이 "밑으로 안 넘긴다"이다. */
const swallow = () => {};

/**
 * Esc 를 **삼키는** 층을 잡는다 (머리말 「닫히는 층과 삼키는 층」).
 *
 * 화면에 다시 만들 수 없는 값이 떠 있는 동안 쓴다. `useEscapeLayer(active, () => {})`
 * 와 같은 것이지만 이름이 다르다: 빈 콜백은 읽는 사람에게 "닫는 걸 깜빡했다"로
 * 보이고, 이 이름은 아무것도 하지 않는 것이 **결정**임을 말한다.
 */
export function useEscapeGuard(active: boolean): void {
  useEscapeLayer(active, swallow);
}

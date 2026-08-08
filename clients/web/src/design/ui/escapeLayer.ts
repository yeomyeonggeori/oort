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
// ## 다이얼로그
//
// Radix 다이얼로그(⌘K 팔레트·채널 만들기·에이전트 프로필)가 열려 있으면 어느
// 층도 받지 않는다. 그때 가장 위는 그 다이얼로그이고 Radix 가 자기 Esc 를 갖는다.
// 세 표면이 각자 적어 두었던 이 예외를 여기 한 번만 적는다.
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

export interface EscapeLayer {
  /** 이 층을 닫는다. 스택 맨 위일 때만 불린다. */
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
  return document.querySelector('[role="dialog"][data-state="open"]') !== null;
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

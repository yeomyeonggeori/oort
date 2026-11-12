/**
 * 대화에 들어갈 때의 첫 그림 (#5678).
 *
 * 타임라인의 가상 목록은 새로 설 때 줄을 맨 위(scrollTop 0)부터 그리고, 그 뒤 따라가기(`followOutput`)가 두 걸음에 나눠 바닥으로 간다.
 * 실측(수리 전, 그리기 직전 표본): 첫 쪽이 붙은 프레임은 목록 맨 위(바닥까지 2,038px — Chromium 1280), 다음 프레임은 바닥이지만 가장
 * 새 줄이 아직 없음, 그다음에야 자리 잡음 — 두 엔진 세 폭 모두 1~2프레임, WebKit 은 가끔 3~6프레임. 그 프레임들이 실제로 그려졌다
 * (화소: 누른 뒤 72~79ms 에 첫 쪽의 맨 위).
 *
 * 그래서 새로 선 스크롤 상자는 **자리 잡기 전까지 그리지 않는다.** 상자에 `data-placed` 가 없으면 보이지 않고(클래스는
 * `Timeline.tsx`), 가장 새 줄이 붙고 바닥에 닿은(바닥 거리 ≤ `REVEAL_GAP_PX`) 때 이 모듈이 그 속성을 단다. 속성은 React 가 모르는 DOM 속성이라
 * 다시 그리기가 지우지 않고, 새 목록(대화를 바꿔 다시 선 상자)은 속성 없이 태어나 저절로 다시 가려진다 — 따로 켜고 끌 상태가 없다.
 *
 * 판정은 크기 · 스크롤이 바뀔 때마다(ResizeObserver 는 그리기 전에 돈다) 다시 한다. 바닥이 목적지가 아닌 움직임(메시지로 이동 같은
 * 스크립트의 스크롤)이 먼저 오면 그때 바로 보인다. 휠 · 터치도 듣지만 가려진(`visibility: hidden`) 상자는 눌림 판정에서 빠져 그 동안
 * 오지 않는다 — 그 몫은 안전판이다. 어느 것도 오지 않아도 `REVEAL_FAILSAFE_MS` 뒤에는 보인다 —
 * 가려진 채 남는 일은 없다. 속성 값은 보인 까닭이다(`bottom` · `empty` · `jump` · `hand` · `timeout`) — 왜 그 프레임에 보였는지 DOM 에서 읽힌다.
 */
export const PLACED_ATTRIBUTE = "data-placed";

/** 자리를 끝내 못 잡아도 이만큼 뒤에는 그린다. 수리 전 자리 잡기는 첫 쪽이 붙고 20~110ms 였다. */
export const REVEAL_FAILSAFE_MS = 600;

/**
 * 바닥에 「닿았다」로 치는 거리(px). 진입 뒤 바닥이 몇 px 모자란 채 서는 일(#5679 — `itemSize` 없이 4px)이 다시 생겨도 안전판까지
 * 빈 화면으로 기다리지 않고 그 자리에서 그린다(모자람 자체는 게이트의 바닥 거리 판정이 잡는다). 가상 목록이 바닥으로 가는 중간 걸음은
 * 수백 px 라 여기 들지 않는다(실측 815 · 2,038px).
 */
export const REVEAL_GAP_PX = 8;

/** 보인 까닭. */
export type RevealReason = "bottom" | "empty" | "jump" | "hand" | "timeout";

export interface EntryReveal {
  /** 바닥이 목적지가 아닌 스크립트의 스크롤이 곧 온다(메시지로 이동 · 안 읽은 곳으로 이동): 기다리지 않고 지금 그린다. */
  reveal(reason: RevealReason): void;
  /** 관찰을 멈춘다(보이게 하지는 않는다 — 상자가 떠나는 때다). */
  stop(): void;
}

/**
 * @param scroller  가상 목록의 스크롤 상자
 * @param lastIndex 가장 새 줄의 `data-index`(가상 목록의 배열 첨자). 줄이 없으면 `null`.
 */
export function revealWhenPlaced(
  scroller: HTMLElement,
  lastIndex: () => number | null,
  { failsafeMs = REVEAL_FAILSAFE_MS }: { failsafeMs?: number } = {}
): EntryReveal {
  let done = scroller.hasAttribute(PLACED_ATTRIBUTE);
  if (done || typeof ResizeObserver === "undefined") {
    if (!done) scroller.setAttribute(PLACED_ATTRIBUTE, "bottom");
    return { reveal: () => {}, stop: () => {} };
  }

  const placed = (): RevealReason | null => {
    const last = lastIndex();
    if (last === null) return "empty";
    if (scroller.querySelector(`[data-index="${last}"]`) === null) return null;
    return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= REVEAL_GAP_PX ? "bottom" : null;
  };
  const check = () => {
    const why = placed();
    if (why !== null) reveal(why);
  };
  const onHand = () => reveal("hand");
  // 관찰자가 붙자마자 콜백을 부르는 환경(시험의 가짜 ResizeObserver)에서도 아래 정리가 아직 없는 타이머를 건드리지 않게 먼저 둔다.
  let failsafe = 0;

  const observer = new ResizeObserver(check);
  const watched = new Set<Element>();
  const watch = () => {
    // 스크롤 상자 · 그 안의 상자 · 줄 목록. 줄 목록은 늦게 붙을 수 있어 구조가 바뀔 때마다 다시 본다(`scrollHold` 와 같은 상자들).
    for (const box of [scroller, scroller.firstElementChild, scroller.querySelector('[data-testid="virtuoso-item-list"]')]) {
      if (box && !watched.has(box)) {
        watched.add(box);
        observer.observe(box);
      }
    }
  };
  const structure = new MutationObserver(() => {
    watch();
    check();
  });
  structure.observe(scroller, { childList: true, subtree: true });
  watch();
  scroller.addEventListener("scroll", check, { passive: true });
  scroller.addEventListener("wheel", onHand, { passive: true });
  scroller.addEventListener("touchmove", onHand, { passive: true });
  failsafe = window.setTimeout(() => reveal("timeout"), failsafeMs);

  function stop() {
    window.clearTimeout(failsafe);
    observer.disconnect();
    structure.disconnect();
    scroller.removeEventListener("scroll", check);
    scroller.removeEventListener("wheel", onHand);
    scroller.removeEventListener("touchmove", onHand);
  }
  function reveal(reason: RevealReason) {
    if (done) return;
    done = true;
    scroller.setAttribute(PLACED_ATTRIBUTE, reason);
    stop();
  }

  check();
  // 붙이는 사이에 이미 보였으면(관찰자가 곧바로 부름) 그 뒤에 붙인 것까지 걷는다.
  if (done) stop();
  return { reveal, stop };
}

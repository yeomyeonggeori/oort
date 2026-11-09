import { AT_BOTTOM_SLACK_PX } from "./navigation";

/**
 * 대화 목록의 높이가 바뀌어도 읽던 자리를 지킨다 (DS2-6 #2718 · #5575).
 *
 * - **바닥에 있었으면 바닥에 남는다.** 창이 낮아질 때(DS2-6: 사이드바를 접으면 떠 있는 판이 32px 낮아진다)와 **줄 높이가 바뀔 때** 둘 다다.
 *   데스크탑 WebKit 은 이 목록 안에서 스크롤 앵커링을 하지 않는다(가상 목록이 줄마다 `overflow-anchor:none` 을 건다). 그래서 맨 아래에서
 *   그림 줄이 자라면 scrollTop 이 그대로라 바닥이 그만큼 내려간다: #5575 실측(수리 전 번들, WebKit)에서 한 프레임에 470~1,119px, 가상 목록이
 *   제 손으로 따라붙기 전까지 「최신 메시지로 이동」이 설 수 있었다.
 * - **위를 읽던 중이면 보던 줄이 화면에서 움직이지 않는다.** 바뀌기 전에 적어 둔 「보던 줄」(화면 안에 처음 걸친 줄)이 바뀐 뒤에도 같은 화면
 *   높이에 오도록 scrollTop 을 옮긴다(수동 앵커). 수리 전 실측: 화면 위 밖의 줄이 120px 자라자 보던 줄이 73.6px 밀렸고 목록은 아무것도 하지 않았다.
 * - **화면 높이는 창 좌표다** (#5575 검수 H1). 목록 상자 자체가 움직여도(오프라인이 되면 머리 아래 허들 배너 39px, 폰 폭에서는 셸 위쪽 연결 띠가
 *   서며 목록의 위 가장자리를 내린다) 보던 줄은 창에서 제자리다: 목록 안쪽 좌표로 지키면 상자와 함께 39px 내려갔다(게이트는 그것을 0 으로 쟀다).
 *   그래서 목록 상자의 크기가 바뀌어도(위·아래 가장자리 이동) 위를 읽던 중이면 같은 바로잡기를 한다. 바닥에 붙어 있으면 바닥 붙이기가 같은 일을 한다.
 *
 * 판정은 **바뀌기 전의** 위치로 한다: 스크롤 이벤트와 직전 바로잡기마다 적어 둔 값이다(가상 목록의 atBottom 은 같은 프레임의 크기 변화로 이미
 * 거짓이 되었을 수 있다). 바로잡기는 ResizeObserver 콜백(그리기 전)에서 하므로 어긋난 프레임이 화면에 그려지지 않는다.
 *
 * 가상 목록이 스스로 옮기는 경우에는 손대지 않고 다시 적기만 한다: 위로 더 불러오기(`firstItemIndex` 가 바뀐다 — 목록이 앞에 붙은 높이를
 * 스스로 메운다)와 사람이 스크롤하는 도중(`SCROLLING_QUIET_MS` 안에 다른 스크롤이 있었다 — 위로 올리는 동안은 목록의 위쪽 보정이 돈다).
 */
export const SCROLLING_QUIET_MS = 150;

interface Anchor {
  /** 가상 목록 줄의 `data-index`(앞에 붙어도 그대로인 번호). */
  index: string;
  /** 창 위쪽에서 줄 위쪽까지(px). 목록 안쪽이 아니라 창 좌표다: 목록 상자가 움직여도 사람의 눈이 보는 자리를 지킨다. */
  top: number;
  /** 적을 때의 `firstItemIndex`. 다르면 위로 더 불러온 것이다. */
  first: number;
}

export interface ScrollHoldOptions {
  /** 지금의 `firstItemIndex`. */
  firstItemIndex: () => number;
}

export interface ScrollHold {
  /**
   * 내가 보낸 글이 들어온다 (#5603): 위를 읽던 중이었어도 **이제부터는 바닥이다.** 보던 줄을 지키지 않고 바닥으로 옮긴 뒤 바닥에 붙인다.
   * 이 신호가 없으면 메아리가 붙어 목록이 자란 바로 그 프레임에 이 모듈이 「보던 줄」을 제자리로 되돌려(위를 읽던 중의 바로잡기) 가상 목록의
   * 따라가기를 무를 수 있다 — 어느 쪽이 먼저 도는지는 엔진과 타이밍에 달렸다.
   */
  expectBottom(): void;
  /** 관찰을 멈춘다. */
  stop(): void;
}

export function holdScrollPosition(scroller: HTMLElement, options: ScrollHoldOptions): ScrollHold {
  if (typeof ResizeObserver === "undefined") return { expectBottom: () => {}, stop: () => {} };
  const nearBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= AT_BOTTOM_SLACK_PX;
  const readAnchor = (): Anchor | null => {
    const edge = scroller.getBoundingClientRect().top;
    for (const row of scroller.querySelectorAll<HTMLElement>("[data-index]")) {
      const box = row.getBoundingClientRect();
      if (box.bottom > edge) return { index: row.dataset.index ?? "", top: box.top, first: options.firstItemIndex() };
    }
    return null;
  };

  let wasAtBottom = nearBottom();
  let lastViewport = scroller.clientHeight;
  let lastContent = scroller.scrollHeight;
  let anchor = wasAtBottom ? null : readAnchor();
  let lastForeignScrollAt = Number.NEGATIVE_INFINITY;
  /** 이 모듈이 방금 놓은 scrollTop. 그 값으로 오는 스크롤 이벤트는 사람의 스크롤이 아니다. */
  let placed: number | null = null;

  /**
   * 바뀐 뒤의 기준을 적는다. `keep`은 이 모듈이 방금 지킨 「보던 줄」이다: 그 줄이 아직 붙어 있으면 **처음 적은 창 높이를 그대로** 목표로
   * 둔다. scrollTop 은 정수로 놓이고 목록 상자의 가장자리는 소수(예: 141.33px)라 바로잡을 때마다 1px 아래의 나머지가 남는데, 바로잡은 뒤의
   * 자리를 다시 읽어 목표로 삼으면 그 나머지가 흔들릴 때마다 쌓인다(#5575 실측: 폰 폭 WebKit 에서 두 번 흔들려 2px). 사람이 스크롤하면
   * 그때 다시 읽는다.
   */
  const remember = (keep: Anchor | null = null) => {
    wasAtBottom = nearBottom();
    lastViewport = scroller.clientHeight;
    lastContent = scroller.scrollHeight;
    const kept = keep !== null && keep.first === options.firstItemIndex() && scroller.querySelector(`[data-index="${CSS.escape(keep.index)}"]`) !== null;
    anchor = wasAtBottom ? null : kept ? keep : readAnchor();
  };
  const place = (top: number) => {
    scroller.scrollTop = top;
    placed = scroller.scrollTop;
  };

  const onScroll = () => {
    const own = placed !== null && Math.abs(scroller.scrollTop - placed) < 1;
    placed = null;
    if (!own) lastForeignScrollAt = performance.now();
    // 이 모듈이 놓은 스크롤이면 목표(보던 줄의 처음 창 높이)를 그대로 둔다.
    remember(own ? anchor : null);
  };

  /** 적어 둔 「보던 줄」이 같은 화면 높이에 오도록 옮긴다. 옮겼으면 참. */
  const holdAnchor = (target: Anchor) => {
    if (target.first !== options.firstItemIndex()) return false;
    const row = scroller.querySelector(`[data-index="${CSS.escape(target.index)}"]`);
    if (row === null) return false;
    const drift = row.getBoundingClientRect().top - target.top;
    if (Math.abs(drift) < 0.5) return false;
    place(scroller.scrollTop + drift);
    return true;
  };

  // 가상 목록은 줄 크기 변화를 **다음 프레임**(requestAnimationFrame)에 처리하고, 그때 스크롤 방향이 위쪽이면 스스로 위쪽 보정(scrollBy)을 한다.
  // 위쪽 줄이 줄어 이 모듈이 먼저 위로 바로잡으면 목록에는 방향이 「위」로 보여 같은 변화를 한 번 더 보정한다(실측: 보던 줄 127.5px 이중 이동).
  // 그래서 바로잡은 뒤 몇 프레임 동안 같은 자리를 다시 확인한다: 이 확인은 목록의 처리보다 늦게 걸린 rAF 라 그 뒤에 돌고, 그리기 전에 되돌린다.
  // 사람이 그 사이 스크롤하면(바깥 스크롤) 멈춘다.
  const SETTLE_FRAMES = 3;
  /** 다시 확인할 자리: 바닥(`null` 앵커)이거나 적어 둔 보던 줄. */
  let settleTarget: { anchor: Anchor | null } | null = null;
  let settleLeft = 0;
  let settleFrame = 0;
  const settle = () => {
    settleFrame = 0;
    const target = settleTarget;
    if (target === null || performance.now() - lastForeignScrollAt <= SCROLLING_QUIET_MS) {
      settleTarget = null;
      return;
    }
    if (target.anchor === null) {
      if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight > 0.5) place(scroller.scrollHeight);
    } else {
      holdAnchor(target.anchor);
    }
    remember(target.anchor);
    settleLeft -= 1;
    if (settleLeft > 0) settleFrame = requestAnimationFrame(settle);
    else settleTarget = null;
  };
  const armSettle = (target: Anchor | null) => {
    settleTarget = { anchor: target === null ? null : { ...target } };
    settleLeft = SETTLE_FRAMES;
    if (settleFrame === 0) settleFrame = requestAnimationFrame(settle);
  };

  const observer = new ResizeObserver(() => {
    const viewport = scroller.clientHeight;
    const content = scroller.scrollHeight;
    if (wasAtBottom && (viewport < lastViewport || content !== lastContent)) {
      place(scroller.scrollHeight);
      remember();
      armSettle(null);
      return;
    }
    // 위를 읽던 중: 내용 높이가 바뀌었거나(줄이 자람·줆) 목록 상자의 크기가 바뀌었다(위·아래 가장자리 이동 — 배너·띠가 서고 짐).
    if (
      !wasAtBottom &&
      (content !== lastContent || viewport !== lastViewport) &&
      anchor !== null &&
      performance.now() - lastForeignScrollAt > SCROLLING_QUIET_MS
    ) {
      const held = anchor;
      holdAnchor(held);
      remember(held);
      armSettle(held);
      return;
    }
    remember();
  });

  // 스크롤러(창 높이) + 그 안의 상자들(목록 내용의 높이 = scrollHeight). 가상 목록은 스크롤러 안에 상자 하나를 두고 그 안에 줄 목록을 둔다.
  observer.observe(scroller);
  const watched = new Set<Element>();
  const watchContent = () => {
    const boxes = [scroller.firstElementChild, scroller.querySelector('[data-testid="virtuoso-item-list"]')];
    for (const box of boxes) {
      if (box && !watched.has(box)) {
        watched.add(box);
        observer.observe(box);
      }
    }
  };
  watchContent();
  // 목록이 처음 그려질 때 상자가 늦게 붙을 수 있다: 붙는 것을 보고 그때 건다.
  const structure = new MutationObserver(watchContent);
  structure.observe(scroller, { childList: true });
  if (scroller.firstElementChild) structure.observe(scroller.firstElementChild, { childList: true });
  scroller.addEventListener("scroll", onScroll, { passive: true });
  return {
    expectBottom: () => {
      // 바닥에 있던 목록은 늘 하던 대로 둔다(가상 목록의 따라가기 + 위 바닥 붙이기). 여기서 한 번 더 놓으면 순서가 바뀌어 가상 목록의
      // 마지막 따라가기가 바닥보다 8px 위에 앉는다(#5603 게이트 실측: 바닥에서 보낸 줄의 아래 8px 이 잘림). 판정은 바뀌기 전의 위치다.
      if (wasAtBottom) return;
      anchor = null;
      wasAtBottom = true;
      place(scroller.scrollHeight);
      armSettle(null);
    },
    stop: () => {
      if (settleFrame !== 0) cancelAnimationFrame(settleFrame);
      scroller.removeEventListener("scroll", onScroll);
      structure.disconnect();
      observer.disconnect();
    },
  };
}

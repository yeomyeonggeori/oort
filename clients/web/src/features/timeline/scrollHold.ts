import { AT_BOTTOM_SLACK_PX } from "./navigation";

/**
 * 대화 목록의 높이가 바뀌어도 읽던 자리를 지킨다 (DS2-6 #2718 · #5575 · #5649).
 *
 * 타임라인(가상 목록)과 스레드 답글 목록(가상화 없는 스크롤 상자)이 같은 손을 쓴다. 두 스크롤 상자 모두 브라우저 스크롤 앵커링을
 * 끈다(`timeline-scroller` — #5638 · #5649). 앵커링은 엔진마다 다르다: Chromium · Playwright WebKit 26.5 · macOS 27 의 WKWebView 는
 * 켜져 있고(2026-11-10 실측), macOS 14~26 의 시스템 WebKit 에는 문서상 없다(Safari 27 릴리스 노트에서 처음 켜짐). 켜 두면 일부
 * 엔진에서만 손이 하나 더 낄 수 있어, 어느 엔진에서도 자리를 지키는 손은 이 모듈 하나로 둔다.
 *
 * - **바닥에 있었으면 바닥에 남는다.** 창이 낮아질 때(DS2-6: 사이드바를 접으면 떠 있는 판이 32px 낮아진다)와 **줄 높이가 바뀔 때** 둘 다다.
 *   앵커링이 없으면 맨 아래에서 그림 줄이 자랄 때 scrollTop 이 그대로라 바닥이 그만큼 내려간다: #5575 실측(수리 전 번들, WebKit)에서
 *   한 프레임에 470~1,119px, 가상 목록이 제 손으로 따라붙기 전까지 「최신 메시지로 이동」이 설 수 있었다.
 * - **위를 읽던 중이면 보던 줄이 화면에서 움직이지 않는다.** 바뀌기 전에 적어 둔 「보던 줄」(화면 안에 처음 걸친 줄)이 바뀐 뒤에도 같은 화면
 *   높이에 오도록 scrollTop 을 옮긴다(수동 앵커). 수리 전 실측: 화면 위 밖의 줄이 120px 자라자 보던 줄이 73.6px 밀렸고 목록은 아무것도 하지 않았다.
 * - **화면 높이는 창 좌표다** (#5575 검수 H1). 목록 상자 자체가 움직여도(오프라인이 되면 머리 아래 허들 배너 39px, 폰 폭에서는 셸 위쪽 연결 띠가
 *   서며 목록의 위 가장자리를 내린다) 보던 줄은 창에서 제자리다: 목록 안쪽 좌표로 지키면 상자와 함께 39px 내려갔다(게이트는 그것을 0 으로 쟀다).
 *   그래서 목록 상자의 크기가 바뀌어도(위·아래 가장자리 이동) 위를 읽던 중이면 같은 바로잡기를 한다. 바닥에 붙어 있으면 바닥 붙이기가 같은 일을 한다.
 *
 * 판정은 **바뀌기 전의** 위치로 한다: 스크롤 이벤트와 직전 바로잡기마다 적어 둔 값이다(가상 목록의 atBottom 은 같은 프레임의 크기 변화로 이미
 * 거짓이 되었을 수 있다). 바로잡기는 ResizeObserver 콜백(그리기 전)에서 하므로 어긋난 프레임이 화면에 그려지지 않는다.
 *
 * **사람이 스크롤하는 중에도 지킨다** (#5649). 스크롤 이벤트는 그 프레임의 ResizeObserver 보다 먼저 오고, 거기서 보던 줄을 그냥 다시 적으면
 * 방금 바뀐 줄 높이가 새 기준에 섞여 사라진다(실측: 휠로 내리는 중 위 밖 줄이 120px 자라면 보던 줄이 120px 튀었다 — 타임라인, 그리고
 * 앵커링을 끈 스레드 상자). 그래서 스크롤 이벤트에서 목록 높이가 달라져 있으면 다시 적지 않고, 적어 둔 자리를 **그 스크롤이 옮긴 만큼만**
 * 옮겨 둔다. 바로잡기는 같은 프레임의 ResizeObserver 가 한다. scrollTop 에 더하는 보정이라 사람의 스크롤 방향 · 거리는 그대로다.
 *
 * 다른 손이 같은 목록을 옮기는 경우(`coOwner` — 가상 목록)에는 그 손의 몫에 손대지 않고 다시 적기만 한다: 위로 더 불러오기
 * (`prependToken` 이 바뀐다 — 목록이 앞에 붙은 높이를 스스로 메운다)와 스크롤 직후(`ownsScroll` — 사람이 휠 · 터치로 **아래로** 내리는
 * 때만 빼고).
 */
export const SCROLLING_QUIET_MS = 150;
/** 휠 · 터치가 이 안에 왔으면 지금의 스크롤은 사람의 손이 움직인 것으로 본다(휠 이벤트는 그 스크롤 이벤트보다 한두 프레임 먼저 온다). */
export const HAND_SCROLL_MS = SCROLLING_QUIET_MS * 2;
/** `expectScripted` 가 연 창의 길이. 이 안의 스크롤은 휠이 끼어들어도 스크립트의 것으로 친다(부드러운 스크롤은 시작이 늦을 수 있다). */
export const SCRIPTED_WINDOW_MS = 1000;
/** `expectScripted("bottom")` 의 마무리를 기다리는 가장 긴 시간. 그때까지 스크롤이 조용해지지 않으면(아래로 이어지는 관성) 그때 마무리한다. */
export const BOTTOM_LANDING_DEADLINE_MS = SCRIPTED_WINDOW_MS * 2;

interface Anchor {
  /** 줄의 이름(`rowAttribute` 의 값). 가상 목록은 앞에 붙어도 그대로인 번호, 스레드는 메시지 id. */
  key: string;
  /** 창 위쪽에서 줄 위쪽까지(px). 목록 안쪽이 아니라 창 좌표다: 목록 상자가 움직여도 사람의 눈이 보는 자리를 지킨다. */
  top: number;
  /** 적을 때의 `prependToken`. 다르면 목록이 앞에 붙은 줄을 스스로 메운 것이다. */
  token: number;
}

/** 같은 목록의 scrollTop 을 옮기는 다른 손(가상 목록). 그 손의 몫과 겹치지 않게 하는 규칙이다. */
export interface ScrollCoOwner {
  /** 목록이 앞에 붙은 줄을 스스로 메울 때마다 바뀌는 값(가상 목록의 `firstItemIndex`). */
  prependToken: () => number;
  /**
   * 방금 있은 스크롤 뒤의 줄 높이 변화를 **이 모듈이 손대지 말아야 하는가**(목록이 스스로 메우거나, 목록이 스크롤을 옮기는 중이다).
   * `sinceMs` 는 이 모듈이 놓지 않은 마지막 스크롤부터의 시간, `direction` 은 그 방향, `byHand` 는 그 스크롤이 사람의 손(휠 · 터치)인가다.
   */
  ownsScroll: (scroll: { sinceMs: number; direction: "up" | "down"; byHand: boolean }) => boolean;
  /**
   * 바로잡은 뒤 같은 자리를 다시 확인할 프레임 수. 가상 목록은 줄 크기 변화를 **다음 프레임**(requestAnimationFrame)에 처리하고, 그때
   * 스크롤 방향이 위쪽이면 스스로 위쪽 보정(scrollBy)을 한다. 위쪽 줄이 줄어 이 모듈이 먼저 위로 바로잡으면 목록에는 방향이 「위」로 보여
   * 같은 변화를 한 번 더 보정한다(실측: 보던 줄 127.5px 이중 이동). 다시 확인은 목록의 처리보다 늦게 걸린 rAF 라 그 뒤에 돌고, 그리기
   * 전에 되돌린다.
   */
  settleFrames: number;
}

export interface ScrollHoldOptions {
  /** 줄의 이름이 든 속성. 이 속성이 있는 요소가 줄이고, 그 값으로 같은 줄을 다시 찾는다. */
  rowAttribute: string;
  /** 내용 높이(scrollHeight)를 정하는 상자들. 늦게 붙을 수 있어 목록 구조가 바뀔 때마다 다시 읽는다. */
  contentBoxes: (scroller: HTMLElement) => Iterable<Element | null>;
  /** 지금 「바닥에 있다」인가. */
  atBottom: (scroller: HTMLElement) => boolean;
  /** 같은 목록을 옮기는 다른 손. 없으면 이 모듈이 유일한 손이다. */
  coOwner?: ScrollCoOwner;
}

const distanceToBottom = (scroller: HTMLElement) => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;

/**
 * 타임라인: react-virtuoso 가상 목록. 줄은 `data-index`(앞에 붙어도 그대로인 번호), 내용 상자는 스크롤러 안의 상자 하나와 그 안의 줄 목록이다.
 * 가상 목록은 위로 더 불러온 높이를 스스로 메우고(`firstItemIndex`), 사람이 **위로** 올리는 동안은 위쪽 보정을 스스로 돈다(올리며 새로 그린
 * 줄의 실제 높이가 어림과 다른 만큼 — 4.18.11 `upwardScrollFixSystem`: 방향이 「위」일 때만, 방향은 스크롤이 멎고 50ms 안에 지워진다).
 * 그래서 위로 올린 지 `SCROLLING_QUIET_MS` 안에는 손대지 않는다: 이 모듈이 같은 변화를 먼저 바로잡으면 두 번 보정된다. 그 창을 150ms 로
 * 넉넉히 둔 것은 목록의 50ms 타이머가 늦게 돌아도 겹치지 않게 하려는 것이다.
 *
 * 사람이 **아래로** 내리는 중 · 그 직후에는 목록이 아무것도 하지 않는다(방향이 「위」가 아니다). 그때 위 밖 줄이 자라면 이 모듈이 지킨다
 * (#5649 — 수리 전에는 방향을 가리지 않고 150ms 를 비워, 내리는 중 · 멈춘 직후에는 아무도 맡지 않았다: 두 엔진 실측 120px).
 *
 * 다만 **사람의 손(휠 · 터치)이 움직인 스크롤일 때만**이다. 스크립트가 아래로 옮기는 스크롤(「최신 메시지로 이동」 · 메시지로 이동 — 목록이
 * 줄을 새로 재며 몇 프레임에 걸쳐 자리를 다시 놓는다)의 직후는 예전처럼 비워 둔다: 거기서 이 모듈이 자리를 붙들면 그 이동을 무른다.
 * 키보드로 내리는 스크롤(End · PageDown · 화살표 · 스페이스)은 `keydown` 이 휠 · 터치의 기억을 지워 스크립트 쪽으로 친다(예전과 같다 — 휠 직후에
 * 눌러도 그렇다, #5649 검수 2회차). 스크롤 막대 끌기도 가를 길이 없어 스크립트 쪽이다.
 */
export function virtualListHold(firstItemIndex: () => number, entering: () => boolean = () => false): ScrollHoldOptions {
  return {
    rowAttribute: "data-index",
    contentBoxes: (scroller) => [scroller.firstElementChild, scroller.querySelector('[data-testid="virtuoso-item-list"]')],
    atBottom: (scroller) => distanceToBottom(scroller) <= AT_BOTTOM_SLACK_PX,
    coOwner: {
      prependToken: firstItemIndex,
      // `entering`(#5717): 새로 선 목록이 아직 자리 잡기 전이다(진입 첫 그림 — `entryReveal.ts`). 그 동안의 스크롤은 모두 목록의 몫이다:
      // 목록은 맨 위부터 그린 뒤 스스로 바닥으로 가는데, 붙을 때 적은 맨 위 줄을 여기서 지키면 그 이동을 무른다(줄이 적어 그 줄이 DOM 에
      // 남는 대화 — 메시지 약 9~25개 — 가 맨 위에서 열렸다). 기준은 계속 다시 적으므로 자리 잡은 뒤부터는 그 자리를 지킨다.
      ownsScroll: ({ sinceMs, direction, byHand }) => entering() || (sinceMs <= SCROLLING_QUIET_MS && !(byHand && direction === "down")),
      settleFrames: 3,
    },
  };
}

/**
 * 가상화 없는 평범한 스크롤 상자(스레드 답글 목록). 줄은 `rowAttribute` 가 붙은 요소, 내용 상자는 스크롤 상자의 자식들이다.
 * 다른 손이 없으니 사람이 스크롤하는 중에도 이 모듈이 지킨다.
 *
 * 「바닥」은 **스크롤해 내려와 닿은 바닥**이다(scrollTop 이 0 보다 크다). 맨 위에 선 채로는 내용이 한 화면에 다 들어와 있어도 바닥이
 * 아니다 — 스레드는 루트가 보이는 맨 위에서 열리고, 그때 답글이 채워지거나 새 답글이 와도 바닥으로 끌려가지 않는다(이 칸 전과 같다).
 */
export function plainListHold(rowAttribute: string): ScrollHoldOptions {
  return {
    rowAttribute,
    contentBoxes: (scroller) => scroller.children,
    atBottom: (scroller) => scroller.scrollTop > 0 && distanceToBottom(scroller) <= AT_BOTTOM_SLACK_PX,
  };
}

export interface ScrollHold {
  /**
   * 내가 보낸 글이 들어온다 (#5603): 위를 읽던 중이었어도 **이제부터는 바닥이다.** 보던 줄을 지키지 않고 바닥으로 옮긴 뒤 바닥에 붙인다.
   * 이 신호가 없으면 메아리가 붙어 목록이 자란 바로 그 프레임에 이 모듈이 「보던 줄」을 제자리로 되돌려(위를 읽던 중의 바로잡기) 따라가기를
   * 무를 수 있다 — 어느 쪽이 먼저 도는지는 엔진과 타이밍에 달렸다.
   */
  expectBottom(): void;
  /**
   * 스크립트가 이 목록을 곧 옮긴다(`scrollToIndex` 로 「최신 메시지로 이동」 · 메시지로 이동 · 안 읽은 곳으로 이동 — #5649 검수 H1).
   * 그 스크롤은 휠 · 터치 직후여도 **사람의 손이 아니다**: 손으로 치면 이 모듈이 자리를 붙들어 부드러운 스크롤을 도중에 멈춘다(WebKit 실측:
   * 휠 뒤 30~160ms 에 누르면 바닥에 360~526px 못 미침). 알린 뒤 `SCRIPTED_WINDOW_MS` 동안이며, 그 사이 휠이
   * 끼어들어도 창은 닫히지 않는다.
   *
   * `destination` 이 `"bottom"`(「최신 메시지로 이동」 — 옮긴 **뒤** 한 번 더 알린다)이면 그 이동은 **바닥에서 끝난다**: 스크롤이 조용해진 뒤
   * 바닥에 못 미쳐 서 있으면 바닥으로 한 번 마무리한다(#5649 검수 3회차). WebKit 은 진행 중인 부드러운 스크롤을 다른 스크롤이 끊는다 —
   * 실측: 이동 중 가장 새 줄의 ⋯ 단추로 초점이 넘어가며(`handoffRowFocusToPreferred`, 스크롤 막지 않음) 반쯤 보이던 단추를 아래 가장자리에
   * 맞춰 바닥 64px 위에서 멈췄다. 사람이 손을 대면(위로 굴린 휠 · 터치 · 키 · 누름 — 스크롤 막대 끌기 포함) 마무리하지 않는다: 그 자리가
   * 사람의 뜻이다. 아래로 굴린 휠은 같은 방향이라 손을 댄 것으로 치지 않는다. 다른 목적지로 알리면(`"elsewhere"`, 기본) 바닥 마무리는 걷힌다.
   */
  expectScripted(destination?: "bottom" | "elsewhere"): void;
  /** 관찰을 멈춘다. */
  stop(): void;
}

export function holdScrollPosition(scroller: HTMLElement, options: ScrollHoldOptions): ScrollHold {
  if (typeof ResizeObserver === "undefined") return { expectBottom: () => {}, expectScripted: () => {}, stop: () => {} };
  const { rowAttribute, coOwner } = options;
  const prependToken = () => coOwner?.prependToken() ?? 0;
  const findRow = (key: string) => scroller.querySelector(`[${rowAttribute}="${CSS.escape(key)}"]`);
  const readAnchor = (): Anchor | null => {
    const edge = scroller.getBoundingClientRect().top;
    for (const row of scroller.querySelectorAll(`[${rowAttribute}]`)) {
      const box = row.getBoundingClientRect();
      if (box.bottom > edge) return { key: row.getAttribute(rowAttribute) ?? "", top: box.top, token: prependToken() };
    }
    return null;
  };

  let wasAtBottom = options.atBottom(scroller);
  let lastViewport = scroller.clientHeight;
  let lastContent = scroller.scrollHeight;
  /** 마지막으로 적을 때의 scrollTop. 다음 스크롤 이벤트가 옮긴 거리 · 방향을 여기서 잰다. */
  let lastTop = scroller.scrollTop;
  let anchor = wasAtBottom ? null : readAnchor();
  let lastForeignScrollAt = Number.NEGATIVE_INFINITY;
  let lastForeignDirection: "up" | "down" = "down";
  /** 이 모듈이 방금 놓은 scrollTop. 그 값으로 오는 스크롤 이벤트는 사람의 스크롤이 아니다. */
  let placed: number | null = null;
  /** 스크롤 이벤트에서 「곧 올 ResizeObserver 에게 맡긴」 내용 높이. 다음 스크롤 이벤트까지 그대로면 관찰자는 오지 않는다. */
  let deferredContent: number | null = null;

  /** 휠 · 터치가 마지막으로 온 때. 사람의 손이 움직인 스크롤과 스크립트가 옮긴 스크롤을 가른다. */
  let lastHandInputAt = Number.NEGATIVE_INFINITY;
  /** `expectScripted` 가 연 창의 끝. 이 안에서는 스크롤을 스크립트의 것으로 친다(휠이 와도 닫히지 않는다). */
  let scriptedUntil = Number.NEGATIVE_INFINITY;

  // 바닥 마무리(`expectScripted("bottom")`): 바닥으로 가는 스크립트 이동이 바닥에 못 미쳐 멈추면 조용해진 뒤 바닥에 놓는다. 걷히는 때는
  // 닿음(스크롤이 바닥에 옴) · 마무리 · 사람이 손을 댐 · 기한뿐이다 — 「조용하지만 아직 못 닿음」으로는 걷지 않는다(부하로 프레임이 늦으면
  // 이동 도중에도 스크롤 이벤트가 150ms 넘게 비고, 그때는 마무리가 목적지로 먼저 옮길 뿐이다).
  let bottomLanding = false;
  let landingQuiet = 0;
  let landingDeadline = 0;
  const endLanding = () => {
    bottomLanding = false;
    if (landingQuiet !== 0) window.clearTimeout(landingQuiet);
    if (landingDeadline !== 0) window.clearTimeout(landingDeadline);
    landingQuiet = 0;
    landingDeadline = 0;
  };
  const land = () => {
    if (!bottomLanding) return;
    endLanding();
    if (distanceToBottom(scroller) > 0.5) {
      place(scroller.scrollHeight);
      remember();
    }
  };

  const onHandInput = (event: Event) => {
    lastHandInputAt = performance.now();
    // 위로 굴린 휠 · 터치는 사람이 이동을 넘겨받은 것이다: 바닥 마무리를 걷는다(아래로 굴린 휠은 같은 방향이라 그대로 둔다).
    if (event.type === "touchmove" || (event as WheelEvent).deltaY < 0) endLanding();
  };
  /** 키보드 스크롤(End · PageDown · 화살표 · 스페이스)은 사람의 손(휠 · 터치)이 아니다: 휠 직후여도 그 기억을 지운다. */
  const onKey = () => {
    lastHandInputAt = Number.NEGATIVE_INFINITY;
    endLanding();
  };
  /** 상자 안을 누름(스크롤 막대 끌기 포함): 사람이 넘겨받았다 — 바닥 마무리를 걷는다. */
  const onPointerDown = () => endLanding();
  const handScrolling = () => performance.now() > scriptedUntil && performance.now() - lastHandInputAt <= HAND_SCROLL_MS;

  /** 지금의 줄 높이 변화는 다른 손(가상 목록)의 몫이다 — 손대지 않는다. */
  const coOwnerHandles = () =>
    coOwner !== undefined &&
    coOwner.ownsScroll({ sinceMs: performance.now() - lastForeignScrollAt, direction: lastForeignDirection, byHand: handScrolling() });

  /**
   * 바뀐 뒤의 기준을 적는다. `keep`은 이 모듈이 방금 지킨 「보던 줄」이다: 그 줄이 아직 붙어 있으면 **처음 적은 창 높이를 그대로** 목표로
   * 둔다. scrollTop 은 정수로 놓이고 목록 상자의 가장자리는 소수(예: 141.33px)라 바로잡을 때마다 1px 아래의 나머지가 남는데, 바로잡은 뒤의
   * 자리를 다시 읽어 목표로 삼으면 그 나머지가 흔들릴 때마다 쌓인다(#5575 실측: 폰 폭 WebKit 에서 두 번 흔들려 2px). 사람이 스크롤하면
   * 그때 다시 읽는다.
   */
  const remember = (keep: Anchor | null = null) => {
    wasAtBottom = options.atBottom(scroller);
    lastViewport = scroller.clientHeight;
    lastContent = scroller.scrollHeight;
    lastTop = scroller.scrollTop;
    deferredContent = null;
    const kept = keep !== null && keep.token === prependToken() && findRow(keep.key) !== null;
    anchor = wasAtBottom ? null : kept ? keep : readAnchor();
  };
  const place = (top: number) => {
    scroller.scrollTop = top;
    placed = scroller.scrollTop;
  };

  /** 적어 둔 「보던 줄」을, 적은 뒤 scrollTop 이 옮겨진 만큼 옮긴 것: 스크롤은 줄을 그만큼 옮기는 것이 맞다. */
  const carried = (from: Anchor): Anchor => ({ ...from, top: from.top - (scroller.scrollTop - lastTop) });

  /** 적어 둔 「보던 줄」이 같은 화면 높이에 오도록 옮긴다. 옮겼으면 참. */
  const holdAnchor = (target: Anchor) => {
    if (target.token !== prependToken()) return false;
    const row = findRow(target.key);
    if (row === null) return false;
    const drift = row.getBoundingClientRect().top - target.top;
    if (Math.abs(drift) < 0.5) return false;
    place(scroller.scrollTop + drift);
    return true;
  };

  const onScroll = () => {
    const top = scroller.scrollTop;
    const own = placed !== null && Math.abs(top - placed) < 1;
    placed = null;
    if (own) {
      // 이 모듈이 놓은 스크롤이면 목표(보던 줄의 처음 창 높이)를 그대로 둔다.
      remember(anchor);
      return;
    }
    if (top !== lastTop) lastForeignDirection = top < lastTop ? "up" : "down";
    lastForeignScrollAt = performance.now();
    if (bottomLanding) {
      // 바닥에 닿았으면 끝. 아니면 스크롤이 조용해지기(이 스크롤이 마지막이기)를 기다려 마무리한다.
      if (distanceToBottom(scroller) <= 0.5) endLanding();
      else {
        if (landingQuiet !== 0) window.clearTimeout(landingQuiet);
        landingQuiet = window.setTimeout(land, SCROLLING_QUIET_MS);
      }
    }
    // 스크롤과 같은 프레임에 줄 높이가 바뀌었다(이 이벤트는 그 프레임의 ResizeObserver 보다 먼저 온다). 보던 줄은 이 스크롤이 옮긴 만큼만
    // 움직였어야 한다 — 나머지는 줄 높이 변화가 민 것이다. 여기서 다시 적으면 그 밀림이 새 기준에 섞여 사라지므로, 적어 둔 자리를 스크롤이
    // 옮긴 만큼만 옮겨 두고(높이 기록은 그대로) 바로잡기는 곧 올 ResizeObserver 에게 맡긴다: 바로잡는 곳이 한 군데여야 다시 확인(settle)이
    // 가상 목록의 처리 뒤에 걸린다. 다만 한 프레임을 기다려도 관찰자가 오지 않았으면(지켜보는 상자의 크기는 그대로인 채 내용 높이만
    // 바뀌었다 — 바깥 여백 같은 것) 맡긴 것을 거두고 다시 적는다: 붙들고 있으면 「바닥에 닿았다」를 영영 다시 읽지 못한다.
    const content = scroller.scrollHeight;
    const resized = content !== lastContent || scroller.clientHeight !== lastViewport;
    if (resized && !wasAtBottom && anchor !== null && deferredContent !== content && !coOwnerHandles()) {
      anchor = carried(anchor);
      lastTop = top;
      deferredContent = content;
      return;
    }
    remember();
  };

  // 다른 손이 있는 목록만: 바로잡은 뒤 몇 프레임 동안 같은 자리를 다시 확인한다(`ScrollCoOwner.settleFrames`).
  //   - 바닥: 사람이 그 사이 스크롤하면(바깥 스크롤) 멈춘다 — 바닥을 떠난 것이다.
  //   - 보던 줄: **지금 적혀 있는** 보던 줄을 본다. 사람이 그 사이 아래로 스크롤했으면 그 스크롤 뒤에 다시 적은 자리이고(사람이 옮긴 만큼은
  //     이미 들어 있다), rAF 시점에 그 자리에서 벗어나 있으면 스크립트(가상 목록의 두 번째 보정)가 옮긴 것이라 되돌린다. 사람이 위로
  //     올리기 시작했거나 스크립트가 스크롤을 옮기면 멈춘다 — 그때의 자리는 목록의 몫이다.
  const settleFrames = coOwner?.settleFrames ?? 0;
  /** 다시 확인할 자리: 바닥이거나 보던 줄. */
  let settleTarget: "bottom" | "anchor" | null = null;
  let settleLeft = 0;
  let settleFrame = 0;
  const settle = () => {
    settleFrame = 0;
    if (settleTarget === "bottom" && performance.now() - lastForeignScrollAt > SCROLLING_QUIET_MS) {
      if (distanceToBottom(scroller) > 0.5) place(scroller.scrollHeight);
      remember();
    } else if (settleTarget === "anchor" && anchor !== null && !coOwnerHandles()) {
      // 줄 높이가 또 바뀌어 있으면(이 프레임의 ResizeObserver 가 아직 보지 않았다) 그쪽에 맡긴다: 바로잡기는 거기 한 군데이고, 거기서
      // 다시 걸어야 다음 확인이 목록의 처리 뒤에 돈다.
      if (scroller.scrollHeight === lastContent && scroller.clientHeight === lastViewport) {
        const held = anchor;
        holdAnchor(held);
        remember(held);
      }
    } else {
      settleTarget = null;
      return;
    }
    settleLeft -= 1;
    if (settleLeft > 0) settleFrame = requestAnimationFrame(settle);
    else settleTarget = null;
  };
  const armSettle = (target: "bottom" | "anchor") => {
    if (settleFrames === 0) return;
    settleTarget = target;
    settleLeft = settleFrames;
    // 이미 걸려 있던 확인은 걷고 다시 건다: 앞의 확인이 rAF 안에서 스스로 이어 건 것이면 목록의 처리(이 프레임의 ResizeObserver 에서 건
    // rAF)보다 **앞에** 서 있어, 목록의 두 번째 보정을 보지 못하고 지나간다.
    if (settleFrame !== 0) cancelAnimationFrame(settleFrame);
    settleFrame = requestAnimationFrame(settle);
  };

  const observer = new ResizeObserver(() => {
    const viewport = scroller.clientHeight;
    const content = scroller.scrollHeight;
    if (wasAtBottom && (viewport < lastViewport || content !== lastContent)) {
      place(scroller.scrollHeight);
      remember();
      armSettle("bottom");
      return;
    }
    // 위를 읽던 중: 내용 높이가 바뀌었거나(줄이 자람·줆) 목록 상자의 크기가 바뀌었다(위·아래 가장자리 이동 — 배너·띠가 서고 짐).
    if (!wasAtBottom && (content !== lastContent || viewport !== lastViewport) && anchor !== null && !coOwnerHandles()) {
      // 적은 뒤 스크롤 이벤트 없이 scrollTop 이 달라져 있을 수 있다(스크립트가 이 프레임의 그리기 직전에 옮겼다 — 이벤트는 다음 프레임에 온다).
      // 다른 손이 없는 목록에서는 그 스크롤도 뜻한 이동이라 그만큼은 두고 줄 높이 변화만 바로잡는다(되돌리면 「메시지로 이동」을 무른다).
      // 가상 목록에서는 **밀림으로 본다**: 거기서 이벤트 없이 달라진 scrollTop 은 목록의 두 번째 보정일 수 있고, 여기서 그것을 뜻한 이동으로
      // 두면 그대로 남는다(게이트 실측: 휠로 내리는 중 위 밖 줄이 120px 줄 때 보던 줄이 120px 더 올라감).
      const held = coOwner === undefined ? carried(anchor) : anchor;
      holdAnchor(held);
      remember(held);
      armSettle("anchor");
      return;
    }
    remember();
  });

  // 스크롤 상자(창 높이) + 그 안의 내용 상자들(목록 내용의 높이 = scrollHeight).
  observer.observe(scroller);
  const watched = new Set<Element>();
  const watchContent = () => {
    for (const box of options.contentBoxes(scroller)) {
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
  scroller.addEventListener("wheel", onHandInput, { passive: true });
  scroller.addEventListener("touchmove", onHandInput, { passive: true });
  scroller.addEventListener("keydown", onKey);
  scroller.addEventListener("pointerdown", onPointerDown, { passive: true });
  return {
    expectBottom: () => {
      // 바닥에 있던 목록은 늘 하던 대로 둔다(가상 목록의 따라가기 + 위 바닥 붙이기). 바닥에서 보낸 글은 수리 전에도 따라갔으므로 이 수리의
      // 대상이 아니고, 손대지 않아야 #5583 이 잰 바닥 동작이 그대로다. 판정은 바뀌기 전의 위치다.
      if (wasAtBottom) return;
      anchor = null;
      wasAtBottom = true;
      place(scroller.scrollHeight);
      armSettle("bottom");
    },
    expectScripted: (destination = "elsewhere") => {
      scriptedUntil = performance.now() + SCRIPTED_WINDOW_MS;
      endLanding();
      if (destination === "bottom") {
        bottomLanding = true;
        landingDeadline = window.setTimeout(land, BOTTOM_LANDING_DEADLINE_MS);
      }
    },
    stop: () => {
      if (settleFrame !== 0) cancelAnimationFrame(settleFrame);
      endLanding();
      scroller.removeEventListener("scroll", onScroll);
      scroller.removeEventListener("wheel", onHandInput);
      scroller.removeEventListener("touchmove", onHandInput);
      scroller.removeEventListener("keydown", onKey);
      scroller.removeEventListener("pointerdown", onPointerDown);
      structure.disconnect();
      observer.disconnect();
    },
  };
}

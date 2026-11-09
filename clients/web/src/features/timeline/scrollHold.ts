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
  /** 스크롤러 위쪽에서 줄 위쪽까지(px). */
  top: number;
  /** 적을 때의 `firstItemIndex`. 다르면 위로 더 불러온 것이다. */
  first: number;
}

export interface ScrollHoldOptions {
  /** 지금의 `firstItemIndex`. */
  firstItemIndex: () => number;
}

export function holdScrollPosition(scroller: HTMLElement, options: ScrollHoldOptions): () => void {
  if (typeof ResizeObserver === "undefined") return () => {};
  const nearBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= AT_BOTTOM_SLACK_PX;
  const rowTop = (row: Element) => row.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  const readAnchor = (): Anchor | null => {
    for (const row of scroller.querySelectorAll<HTMLElement>("[data-index]")) {
      const top = rowTop(row);
      if (top + row.getBoundingClientRect().height > 0) return { index: row.dataset.index ?? "", top, first: options.firstItemIndex() };
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

  const remember = () => {
    wasAtBottom = nearBottom();
    lastViewport = scroller.clientHeight;
    lastContent = scroller.scrollHeight;
    anchor = wasAtBottom ? null : readAnchor();
  };
  const place = (top: number) => {
    scroller.scrollTop = top;
    placed = scroller.scrollTop;
  };

  const onScroll = () => {
    if (placed !== null && Math.abs(scroller.scrollTop - placed) < 1) {
      placed = null;
    } else {
      placed = null;
      lastForeignScrollAt = performance.now();
    }
    remember();
  };

  const observer = new ResizeObserver(() => {
    const viewport = scroller.clientHeight;
    const content = scroller.scrollHeight;
    if (wasAtBottom && (viewport < lastViewport || content !== lastContent)) {
      place(scroller.scrollHeight);
    } else if (
      !wasAtBottom &&
      content !== lastContent &&
      anchor !== null &&
      anchor.first === options.firstItemIndex() &&
      performance.now() - lastForeignScrollAt > SCROLLING_QUIET_MS
    ) {
      const row = scroller.querySelector(`[data-index="${CSS.escape(anchor.index)}"]`);
      if (row !== null) {
        const drift = rowTop(row) - anchor.top;
        if (Math.abs(drift) >= 0.5) place(scroller.scrollTop + drift);
      }
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
  return () => {
    scroller.removeEventListener("scroll", onScroll);
    structure.disconnect();
    observer.disconnect();
  };
}

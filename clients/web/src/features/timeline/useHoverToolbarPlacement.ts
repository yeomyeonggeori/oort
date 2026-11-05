import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import {
  applyToolbarPlacement,
  closestToolbarScrollContainer,
  neighborTextRects,
  placeToolbar,
  readToolbarPlacement,
  restToolbarRect,
  toolbarNeighbors,
} from "./hoverToolbarModel";

// =============================================================================
// 호버 툴바의 자리 잡기 (#1743 H-4 → #5179 → #5307 M1).
//
// 막대가 위 경계를 걸칠지, 아래 경계로 뒤집을지, 행 안쪽으로 밀지는 `placeToolbar`(모델)가 정한다. 이 훅은 **언제 재는가**를 맡는다.
//   ① 마운트 때 한 번(레이아웃 효과: 첫 그림 전에 자리가 정해진다).
//   ② 그 뒤 포인터가 행 위에 머문 채 레이아웃이 바뀌면 다시 — 스크롤러·포인터 행·앞뒤 이웃 행의 크기가 바뀔 때.
//      마운트 때 아래 자리가 스크롤러 안이었어도 입력창 위에 작업 띠가 서서 스크롤러가 줄면 막대가 스크롤러 밖(띠 밑)에 숨은 채 남던 결함(검수 5b M1)을 막는다.
//   ③ 메뉴가 열려 있는 동안은 얼린다: 열린 메뉴가 막대를 붙들고 있는 동안 자리가 옮겨 다니지 않는다.
//
// 다시 잴 때 막대는 이미 아래로 뒤집혔거나 밀리거나 비껴 서 있다. 모델의 `restToolbarRect`가 서 있는 상자에서 위 자리 상자를 되돌려 `placeToolbar`에 먹인다.
// 막대 요소를 지우거나 클래스를 바꿔 쳐다보지 않는다(클래스는 React의 것이다). 다시 잰 결과가 같으면 아무것도 바뀌지 않는다.
//
// 스크롤러를 못 찾으면 — 레이아웃을 못 재는 jsdom 시험이 그렇다 — 이웃 글자에는 손도 대지 않는다. `ResizeObserver`가 없는 환경도 마운트 때 한 번만 잰다.
// 스크롤은 따로 듣지 않는다: 스크롤러가 줄어 바닥에 붙는 일은 스크롤러의 크기 알림이 먼저 오고(타임라인이 같은 알림에서 바닥으로 붙인다), 포인터가 머문 채
// 스크롤하면 포인터 아래 행이 바뀌어 새 막대가 새로 마운트되며 마운트 때 잰다. (직접 문구 장부가 낱말 리터럴 「scroll」을 세기도 한다.)
// 인라인 style 속성은 CSP가 막으므로 밀림·비낌은 CSSOM 변수로 건다(`applyToolbarPlacement`).
// =============================================================================

export function useHoverToolbarPlacement(frozen: boolean) {
  const barRef = useRef<HTMLDivElement>(null);
  const [straddleBelow, setStraddleBelow] = useState(false);
  const frozenRef = useRef(frozen);
  useEffect(() => {
    frozenRef.current = frozen;
  }, [frozen]);

  // 마운트 때 한 번 재고, 레이아웃이 바뀌면 다시 잰다. 구독이 이 효과 안에 있는 이유: 잴 때마다 같은 스크롤러·행을 쓰므로 한 번 찾아 쥐고 있는다.
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const scroller = closestToolbarScrollContainer(bar);
    if (!scroller) return;
    const row = bar.closest('[data-testid="timeline-message"]');

    const measure = (): void => {
      const placed = readToolbarPlacement(bar);
      const rowRect = row ? row.getBoundingClientRect() : null;
      const neighbors = row ? toolbarNeighbors(row, scroller) : null;
      const placement = placeToolbar({
        bar: rowRect ? restToolbarRect({ bar: bar.getBoundingClientRect(), row: rowRect, placed }) : bar.getBoundingClientRect(),
        row: rowRect,
        scroller: scroller.getBoundingClientRect(),
        prevText: () => neighborTextRects(neighbors?.prev ?? null),
        selfText: () => neighborTextRects(row),
        nextText: () => neighborTextRects(neighbors?.next ?? null),
      });
      // 비껴 서기(가로 1~2px)는 위·아래 어느 자리에서도 같다. 변수는 막대 요소에 걸려 자리 이름이 바뀌어도(`straddleBelow`) 남는다.
      applyToolbarPlacement(bar, placement);
      setStraddleBelow(placement.below);
    };
    measure();

    // 행이 없으면(타임라인 밖) 위 자리 상자를 되돌릴 수 없다 — 마운트 때 한 번이 전부다.
    const Observer = (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    if (!row || !Observer) return;
    const barEl: HTMLDivElement = bar;
    const scrollerEl: HTMLElement = scroller;
    const rowEl: Element = row;

    // 알림이 올 때마다 다시 잰다. 관찰을 시작할 때의 처음 알림에도 재는데, 같은 자리가 나오면 아무것도 바뀌지 않는다(되돌려 다시 재도 흔들리지 않는다).
    const observed = new Set<Element>();
    const observer = new Observer(() => remeasure());

    /** 지켜볼 칸: 스크롤러(작업 띠가 서면 줄어든다), 포인터 행, 앞·뒤 이웃(그림이 불러와지거나 글이 고쳐져 높이가 바뀐다). 이웃은 잴 때마다 다시 센다. */
    function watch(): void {
      const next = toolbarNeighbors(rowEl, scrollerEl);
      const wanted = new Set<Element>([scrollerEl, rowEl]);
      if (next.prev) wanted.add(next.prev);
      if (next.next) wanted.add(next.next);
      for (const element of Array.from(observed)) {
        if (wanted.has(element)) continue;
        observer.unobserve(element);
        observed.delete(element);
      }
      for (const element of wanted) {
        if (observed.has(element)) continue;
        observed.add(element);
        observer.observe(element);
      }
    }

    // 다시 잴 때는 DOM 을 곧바로 맞춰야 한다(`flushSync`): 다음 잼이 읽는 막대가 방금 정한 자리여야 하고, 한 프레임이라도 옛 자리가 그려지지 않아야 한다.
    function remeasure(): void {
      if (frozenRef.current || !barEl.isConnected) return;
      flushSync(measure);
      watch();
    }
    watch();

    return () => {
      observer.disconnect();
    };
  }, []);

  return { barRef, straddleBelow };
}

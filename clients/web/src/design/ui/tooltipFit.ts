// =============================================================================
// 툴팁이 자기를 가둔 판 안에 머물게 하는 계산 (#4230).
//
// 공용 `Tooltip`은 트리거 옆에 `absolute`로 그려지고 한 줄(`white-space: nowrap`)이다. 대화 머리는 판(`app-pane`)이
// `overflow: clip`이라, 툴팁이 판 가장자리를 넘으면 **글자가 잘린다**(스크롤로도 닿지 않는다). 두 경우가 있다:
//   · 줄이 바뀐 아랫줄의 첫 단추(왼쪽 끝): 가운데 정렬 툴팁이 단추 왼쪽으로 반 폭만큼 나간다(계획 독 「계획 12단계 중 1단계 완료」).
//   · 이름을 글에 담는 ⋮ 단추(「{이름} 채널 메뉴」): 이름이 길면 판보다 넓다(접근성 이름과 같은 글이어야 해서 줄일 수 없다).
//
// 그래서 열릴 때 한 번 잰다: 툴팁을 자르는 가장 안쪽 가로 범위(창과, overflow가 visible이 아닌 조상들의 교집합) 안으로
// 밀어 넣고, 그 범위보다 넓으면 범위 폭에서 줄바꿈한다. 밀어 넣는 값과 상한은 CSS 변수로만 넘긴다(`--tooltip-shift`·
// `--tooltip-max`, `tokens.css`의 `tooltip-surface`가 읽는다): 이 코드베이스는 style 속성을 쓰지 않는다(slider의
// `--slider-fraction`과 같은 방식).
//
// 변수는 **단위 없는 숫자**(px 값)다: CSS가 `calc(var(--tooltip-shift, 0) * 1px)`로 곱한다. 직접 문구 장부(`direct-copy.mjs`)가
// 코드 안의 낱말 문자열(`"end"`, `"px"`)을 사용자 문구 후보로 세므로, 이 파일은 그런 문자열을 두지 않는다.
//
// 재는 값은 트리거(래퍼)의 상자와 툴팁의 `offsetWidth`다. 툴팁의 `getBoundingClientRect`는 나타남 애니메이션(95% 축소)에
// 영향을 받아 쓰지 않는다. 순수 계산(`tooltipFit`)과 DOM 읽기·쓰기(`fitTooltipElement`)를 나눈 이유는 jsdom이 상자를 못
// 재서, 계산은 숫자로 시험하고 DOM 부분은 상자를 가짜로 끼워 시험하기 위해서다(진짜 상자는 `gate:channel-header-fit`이 잰다).
// =============================================================================

export type TooltipAlign = "center" | "end";

/** 범위 가장자리와 툴팁 사이의 틈(px). 간격 눈금의 4. */
export const TOOLTIP_EDGE_PAD = 4;

/** 트리거 상자 안에서 툴팁이 기준으로 삼는 가로 위치(0 = 왼쪽 끝, 1 = 오른쪽 끝): 가운데 정렬은 가운데, `end`는 오른쪽 끝이다. */
const ANCHOR_RATIO: Readonly<Record<TooltipAlign, number>> = { center: 0.5, end: 1 };

/** 자르지 않는 `overflow-x` 값(`visible`)과, 스타일을 못 읽는 환경(jsdom)의 빈 값. 브라우저는 늘 낱말을 준다. */
const NOT_CLIPPING = /^(?:visible)?$/;

export const TOOLTIP_SHIFT_VAR = "--tooltip-shift";
export const TOOLTIP_MAX_VAR = "--tooltip-max";
/** 줄바꿈을 켜는 표지. CSS가 `[data-capped]`로 읽는다. */
export const TOOLTIP_CAPPED_ATTR = "data-capped";

export interface TooltipFit {
  /** 가로로 옮길 거리(px, 오른쪽이 양수). 가운데·오른쪽 끝 정렬 위치에서 잰다. */
  shift: number;
  /** 범위보다 넓을 때 줄바꿈할 폭(px). 안 넓으면 null. */
  maxWidth: number | null;
}

/**
 * 트리거(`anchor`)에 맞춘 툴팁(`width`)을 범위(`bounds`) 안에 놓으려면 얼마나 옮기고 줄여야 하는가.
 * 범위가 잴 수 없는 값이면(폭 0 이하) 건드리지 않는다.
 */
export function tooltipFit(
  anchor: { left: number; right: number },
  width: number,
  align: TooltipAlign,
  bounds: { left: number; right: number },
  pad: number = TOOLTIP_EDGE_PAD
): TooltipFit {
  const room = bounds.right - bounds.left - pad * 2;
  if (!(room > 0) || !(width > 0)) return { shift: 0, maxWidth: null };
  const maxWidth = width > room ? room : null;
  const used = maxWidth ?? width;
  // 기준 위치(비율)에 툴팁의 같은 비율 지점을 맞춘다: 가운데는 가운데끼리, 오른쪽 끝은 오른쪽 끝끼리.
  const natural = anchor.left + (anchor.right - anchor.left - used) * ANCHOR_RATIO[align];
  const left = Math.min(Math.max(natural, bounds.left + pad), bounds.right - pad - used);
  return { shift: left - natural, maxWidth };
}

/** 툴팁을 자르는 가로 범위: 창과, overflow가 visible이 아닌 모든 조상(`clip`·`hidden`·`auto`·`scroll`)의 교집합. */
export function clipRange(el: HTMLElement): { left: number; right: number } {
  let left = 0;
  let right = window.innerWidth;
  for (let node = el.parentElement; node !== null; node = node.parentElement) {
    if (NOT_CLIPPING.test(getComputedStyle(node).overflowX)) continue;
    const box = node.getBoundingClientRect();
    left = Math.max(left, box.left);
    right = Math.min(right, box.right);
  }
  return { left, right };
}

/**
 * 열린 툴팁을 범위 안에 놓는다. 먼저 이전에 넣은 값을 걷고 **자연 위치**에서 잰다(같은 요소를 다시 재도 같은 답).
 * 폭이 0이면(jsdom, 아직 안 그려짐) 아무것도 하지 않는다.
 */
export function fitTooltipElement(tip: HTMLElement, align: TooltipAlign): void {
  tip.style.removeProperty(TOOLTIP_SHIFT_VAR);
  tip.style.removeProperty(TOOLTIP_MAX_VAR);
  tip.removeAttribute(TOOLTIP_CAPPED_ATTR);
  const anchor = tip.parentElement?.getBoundingClientRect();
  if (anchor === undefined) return;
  const { shift, maxWidth } = tooltipFit(anchor, tip.offsetWidth, align, clipRange(tip));
  if (maxWidth !== null) {
    tip.setAttribute(TOOLTIP_CAPPED_ATTR, "");
    tip.style.setProperty(TOOLTIP_MAX_VAR, String(maxWidth));
  }
  if (shift !== 0) tip.style.setProperty(TOOLTIP_SHIFT_VAR, String(shift));
}

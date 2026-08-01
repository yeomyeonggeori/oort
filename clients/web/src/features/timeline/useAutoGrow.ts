import { useLayoutEffect, type RefObject } from "react";

// =============================================================================
// 쓰는 만큼 자라는 입력창 (B11 R2 M4).
//
// 1라운드의 수정 입력창은 `rows={2}` 고정, 스레드 컴포저는 `rows={1}` 고정이라
// 세 줄짜리 한국어 메시지를 고치는 일이 두 줄 창구를 스크롤하는 일이 됐다.
// 메인 컴포저는 이미 자란다(Composer.tsx).
//
// 다만 메인 컴포저처럼 `\n`을 세지는 않는다. 줄바꿈을 세는 방식은 **접힌 줄**을
// 못 본다 — 한국어 메시지는 줄바꿈 없이 한 문단으로 오고 창 폭에서 세 줄로
// 접히는 쪽이 흔하다. 그래서 여기서는 실제로 차지한 높이(`scrollHeight`)를
// 재고, 최소·최대 줄수 사이로 자른다. 최대를 넘으면 그때부터 스크롤한다.
// =============================================================================

export interface AutoGrowOptions {
  minRows: number;
  maxRows: number;
}

function pxOf(value: string, fallback: number): number {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * `value`가 바뀔 때마다 textarea의 높이를 내용에 맞춘다.
 *
 * `useLayoutEffect`인 것은 의도다: 페인트 뒤에 높이를 고치면 새 줄이 생기는
 * 순간마다 입력창이 한 프레임 깜빡인다.
 */
export function useAutoGrow(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
  { minRows, maxRows }: AutoGrowOptions
): void {
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const styles = window.getComputedStyle(node);
    // `line-height: normal`은 숫자로 답하지 않는다. 그때는 글자 크기의 1.5배로
    // 친다 — 이 앱의 본문 행간과 같은 값이다.
    const fontSize = pxOf(styles.fontSize, 16);
    const line = pxOf(styles.lineHeight, fontSize * 1.5);
    const frame =
      pxOf(styles.paddingTop, 0) +
      pxOf(styles.paddingBottom, 0) +
      pxOf(styles.borderTopWidth, 0) +
      pxOf(styles.borderBottomWidth, 0);

    // 줄이 줄어들 때도 따라 줄려면 먼저 놓아 주어야 한다: `scrollHeight`는
    // 지금 높이보다 작아지지 않는다.
    node.style.height = "auto";
    const min = line * minRows + frame;
    const max = line * maxRows + frame;
    const wanted = node.scrollHeight;
    node.style.height = `${Math.round(Math.min(max, Math.max(min, wanted)))}px`;
    node.style.overflowY = wanted > max ? "auto" : "hidden";
  }, [ref, value, minRows, maxRows]);
}

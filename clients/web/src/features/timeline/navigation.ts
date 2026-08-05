import type { Message } from "@momo/core/lib/api";

// =============================================================================
// 타임라인 항법의 산수 (U4-j · 진단 M-9).
//
// 컴포넌트에서 떼어 둔 이유는 이 두 함수가 **틀리는 방식이 조용하기** 때문이다:
// 개수를 하나 더 세거나 덜 세도 화면은 멀쩡해 보이고, 사람만 아래에 무엇이
// 쌓였는지 잘못 안다. 스크롤 위치는 virtuoso가 알고, 이 파일은 그 위치가 바뀐
// 뒤의 산수만 안다.
// =============================================================================

/**
 * 「바닥에 있다」로 쳐 주는 여유 (px).
 *
 * 0이면 마지막 행의 자기 여백 몇 픽셀, 또는 이미지 하나가 늦게 자라 생긴 오차
 * 만으로도 「바닥이 아님」이 되어, 아무도 스크롤하지 않았는데 항법 컨트롤이 떴다
 * 사라진다. 64px은 본문 세 줄이 채 안 되는 거리라, 이 여유 안에서는 마지막
 * 메시지가 여전히 눈에 들어와 있다.
 */
export const AT_BOTTOM_SLACK_PX = 64;

/** 마지막 메시지의 seq. 빈 채널이면 `null`. `messages`는 seq 오름차순이다. */
export function newestSeqOf(messages: readonly Message[]): number | null {
  const last = messages[messages.length - 1];
  return last === undefined ? null : last.seq;
}

/**
 * 기준선보다 새 메시지의 수.
 *
 * 꼬리에서 세다가 기준선에 닿으면 멈춘다 — 그래서 이 함수는 화면에 있는 메시지
 * 수가 아니라 **꼬리에 붙은 것**만 센다. 위로 더 불러온 옛 페이지(`?before`
 * prepend)는 seq가 기준선보다 작으므로 한 번도 세지 않는다. 「아래 새 메시지」가
 * 위로 스크롤할 때마다 늘어나는 것이 이 goal이 피해야 할 정확한 거짓말이다.
 */
export function countNewerThan(
  messages: readonly Message[],
  baseline: number
): number {
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message === undefined || message.seq <= baseline) break;
    count += 1;
  }
  return count;
}

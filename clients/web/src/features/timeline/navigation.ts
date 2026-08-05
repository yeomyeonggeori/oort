import { uuidEq, type Message } from "@momo/core/lib/api";

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
 * 기준선보다 새 메시지의 수. **내가 쓴 것은 빼고** (design-review M-3).
 *
 * 꼬리에서 세다가 기준선에 닿으면 멈춘다 — 그래서 이 함수는 화면에 있는 메시지
 * 수가 아니라 **꼬리에 붙은 것**만 센다. 위로 더 불러온 옛 페이지(`?before`
 * prepend)는 seq가 기준선보다 작으므로 한 번도 세지 않는다. 「아래 새 메시지」가
 * 위로 스크롤할 때마다 늘어나는 것이 이 goal이 피해야 할 정확한 거짓말이다.
 *
 * ## 저자를 보는 이유는 **낱말** 때문이다 (M-3)
 *
 * 이 수가 나가는 자리의 문장은 「새 메시지 N개 보기」이고, 그 낱말은 이 제품에서
 * 이미 뜻이 정해져 있다 — 안읽음 구분선의 「새 메시지 N개, 여기까지 읽음」. 거기서
 * N은 **내가 아직 읽지 않은 남의 말**이다. 같은 낱말이 두 자리에서 다른 것을 세면
 * 읽는 사람이 그 둘을 대조해야 하고, 무엇보다 위로 올라가 읽던 중에 내가 한 줄
 * 보내면 화면이 「새 메시지 1개」라며 **내가 방금 쓴 문장으로 가라고** 한다.
 *
 * 낙관적 메아리(`pending`)는 여기 오지 않는다 — 이 배열은 서버가 seq를 준 행들만
 * 든다. 그래서 이 결함은 **확정된 뒤에** 나타났고, 그만큼 알아채기 어려웠다.
 *
 * @param myMemberId 내 멤버 id. `undefined`면 저자를 모른다는 뜻이고 전부 센다 —
 *   행 액션이 없는 표면(작업 세션 기록)이 그 경우다. 모르면 빼지 않는 쪽이 안전
 *   하다: 남의 말을 안 세는 것이 내 말을 세는 것보다 나쁘다.
 */
export function countNewerThan(
  messages: readonly Message[],
  baseline: number,
  myMemberId?: string
): number {
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message === undefined || message.seq <= baseline) break;
    // `continue`이지 `break`가 아니다. 내 메시지는 세지 않을 뿐 꼬리를 끊지
    // 않는다 — 대화 중에 내가 한 줄 끼워 넣었다고 그 아래 남의 말이 안 보이는
    // 것은 이 함수가 고치려는 거짓말과 같은 종류다.
    if (uuidEq(message.authorMemberId, myMemberId)) continue;
    count += 1;
  }
  return count;
}

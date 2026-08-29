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

/**
 * 상단 「새 메시지 N개」 점프의 N.
 *
 * ## (a) 상단 필 ≠ (b) 하단 필 — 같은 낱말, 다른 시각
 *
 * (a) 상단은 채널을 연 순간의 **동결 스냅샷**이다. 구분선이 쓰는 서버
 * `unreadCount`(P7)와 같은 수다. 라이브로 아래에 붙는 신규는 세지 않는다.
 * 그 수는 하단 필 (b)가 말한다. 한 숫자로 둘을 세면 구분선은 5개인데 상단이
 * 「새 메시지 41개」라며 꼬리까지 끌어들이고, 낭독도 그 거짓을 읽는다
 * (design-review M-1(a)).
 *
 * (b) 하단은 `countNewerThan`: 바닥을 떠난 뒤 꼬리에 붙은 **남의 말**. 기준선은
 * 그 순간의 가장 새 seq이고, 내 확정 전송은 빼는 이유(M-3)가 여기 산다.
 *
 * 이 비대칭이 맞다. 위 필은 「그때 안 읽은 것」으로 구분선에 착지하고, 아래
 * 필은 「지금 아래에 쌓인 것」으로 최신에 착지한다.
 */
export function countUnreadJump(
  unreadCount: number | null | undefined
): number {
  if (unreadCount == null || unreadCount <= 0) return 0;
  return unreadCount;
}

/** 안읽음 구분선이 지금 창의 어디에 있는가. */
export type DividerViewportRelation = "above" | "in" | "below" | "absent";

/** 스트림에서 안읽음 구분선의 데이터 첨자. 없으면 `null`. */
export function unreadDividerIndexOf(
  items: readonly { kind: string }[]
): number | null {
  const index = items.findIndex((item) => item.kind === "unread");
  return index < 0 ? null : index;
}

/**
 * virtuoso `rangeChanged` / `itemContent` 번호를 데이터 배열 첨자로.
 *
 * `firstItemIndex`가 앞에 얹힌 번호면 빼고, 이미 첨자면 그대로 둔다.
 */
export function dataIndexFromVirtuoso(
  virtuosoIndex: number,
  firstItemIndex: number
): number {
  return virtuosoIndex >= firstItemIndex
    ? virtuosoIndex - firstItemIndex
    : virtuosoIndex;
}

/**
 * 구분선과 창의 관계. `dividerIndex`와 visible range는 **데이터 배열 첨자**.
 */
export function dividerViewportRelation(
  dividerIndex: number | null,
  visibleStart: number,
  visibleEnd: number
): DividerViewportRelation {
  if (dividerIndex === null) return "absent";
  if (dividerIndex < visibleStart) return "above";
  if (dividerIndex > visibleEnd) return "below";
  return "in";
}

/**
 * IO가 실측한 관계와 렌더 range를 합친다.
 *
 * virtuoso `increaseViewportBy` 때문에 range만 보면 창 600px 밖의 구분선도
 * 「안」이 된다. 구분선이 DOM에 있으면 IO가 이기고, 가상화로 빠져 있으면 range가
 * 위/아래만 정직하게 안다.
 */
export function reconcileDividerRelation(input: {
  dividerIndex: number | null;
  visibleStart: number | null;
  visibleEnd: number | null;
  observed: DividerViewportRelation | null;
}): DividerViewportRelation {
  if (input.dividerIndex === null) return "absent";
  if (
    input.observed === "above" ||
    input.observed === "in" ||
    input.observed === "below"
  ) {
    return input.observed;
  }
  if (input.visibleStart === null || input.visibleEnd === null) return "absent";
  return dividerViewportRelation(
    input.dividerIndex,
    input.visibleStart,
    input.visibleEnd
  );
}

/**
 * 채널 epoch 안의 래치 (design-review H-1).
 *
 * 구분선이 한 번 창에 들어오면 상단 필을 다시 세우지 않는다. 동결
 * `lastReadSeq`는 구분선용으로 남고, 필이 그 숫자를 들고 부활하는 길이 이
 * 래치가 닫는다. 「바닥 도달로 커서가 전진」은 구분선을 지나 아래로 읽는
 * 동안 `in`을 통과하는 것과 같다 — 첫 착지(epoch 직후 바닥)는 래치하지
 * 않는다. 채널을 갈아타면 epoch와 함께 풀린다.
 */
export function shouldLatchUnreadJump(
  relation: DividerViewportRelation
): boolean {
  return relation === "in";
}

/** 구분선이 창 **위쪽 밖**에 있고 동결 N이 있으며, 이 epoch에서 아직 래치되지 않았을 때만 상단 필이 선다. */
export function shouldShowJumpUnread(
  relation: DividerViewportRelation,
  unreadJumpCount: number,
  latched = false
): boolean {
  if (latched) return false;
  return relation === "above" && unreadJumpCount > 0;
}

/** 구분선 바로 아래 첫 메시지 seq. 상단 필 착지 정거장. */
export function firstUnreadMessageSeq(
  items: readonly { kind: string; message?: { seq: number } }[],
  dividerIndex: number | null
): number | null {
  if (dividerIndex === null) return null;
  for (let i = dividerIndex + 1; i < items.length; i++) {
    const item = items[i];
    if (item !== undefined && item.kind === "message" && item.message) {
      return item.message.seq;
    }
  }
  return null;
}

/** 점프 스크롤의 움직임. reduced-motion이면 즉시, 아니면 목적지가 보이게. */
export function timelineScrollBehavior(
  reducedMotion: boolean
): "auto" | "smooth" {
  return reducedMotion ? "auto" : "smooth";
}

/**
 * IntersectionObserver 한 줄로 위/안/아래를 가른다.
 *
 * `isIntersecting`이면 창 안(한 픽셀이어도 소멸). 아니면 root와 비교해 위/아래.
 */
export function relationFromIntersection(entry: {
  isIntersecting: boolean;
  rootBounds: Pick<DOMRectReadOnly, "top" | "bottom"> | null;
  boundingClientRect: Pick<DOMRectReadOnly, "top" | "bottom">;
}): DividerViewportRelation | null {
  if (entry.isIntersecting) return "in";
  const root = entry.rootBounds;
  if (root === null) return null;
  if (entry.boundingClientRect.bottom <= root.top) return "above";
  if (entry.boundingClientRect.top >= root.bottom) return "below";
  return "in";
}

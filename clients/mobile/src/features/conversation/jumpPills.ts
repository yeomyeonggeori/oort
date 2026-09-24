import {uuidEq, type Message} from '@momo/core/lib/api';
import type {DividerSegment} from '@momo/core/features/timeline/divider';

// =============================================================================
// 타임라인 점프 필의 산수와 문장 (#1892 — 웹 UnreadPill 의미론의 RN 이식).
//
// 웹에는 두 필이 있다: 위쪽 「안읽음으로」(`jump-unread`)와 아래쪽 「최신으로」
// (`jump-latest`). 폰은 진입 앵커와 안읽음 구분선뿐이었고, 그래서 위로 스크롤해
// 옛 대화를 읽던 사람이 돌아올 길은 손가락뿐이었다 — 웹 전용이던 축이 BF-A2 로
// 넓어진 자리다(#1891 리뷰 M-4).
//
// 여기 있는 것은 **웹의 판정을 그대로** 옮긴 것이다. 원본은
// `clients/web/src/features/timeline/navigation.ts` 와 `UnreadPill.tsx` 이고, 이
// 파일은 그 둘을 import 할 수 없는 쪽(폰은 웹을 import 하지 않는다 — ADR-0137 D3,
// `projectShape.test.ts`)에서 같은 규칙을 세운다. 코어로 올리는 것은 웹을 함께
// 바꾸는 일이라 이 티켓의 범위 밖이다. 두 벌이 갈라지지 않게 문장은
// `__tests__/unreadJumpPills.test.tsx` 가 웹 원본 파일을 **읽어서** 맞춘다.
//
// 세 규칙:
//
//   **래치** — 이 방문에서 사람이 구분선을 한 번 봤거나(창 안에 들어왔다) 위 필을
//     눌렀으면, 위 필은 다시 서지 않는다. 그 사람은 이미 경계를 안다. 방을 옮기면
//     풀린다.
//   **동결 N** — 위 필의 N 은 방을 연 순간의 안읽음 수, 구분선에 적힌 바로 그 수다.
//     라이브로 아래에 붙는 새 메시지는 위 필에 섞지 않는다. 그 수는 아래 필이 센다.
//   **동사 라벨** — 「새 메시지 N개 보기」「최신 메시지로 이동」. 누르면 무슨 일이
//     일어나는지를 말한다. 방향은 화살표가 진다.
// =============================================================================

/**
 * 기준선보다 새 메시지의 수. **내가 쓴 것은 빼고** (웹 design-review M-3).
 *
 * 꼬리에서 세다가 기준선에 닿으면 멈춘다. 위로 더 불러온 옛 페이지는 seq 가
 * 기준선보다 작으므로 세지 않는다 — 「아래 새 메시지」가 위로 스크롤할 때마다
 * 늘어나는 것이 이 수가 피해야 할 거짓말이다. 내 확정 전송은 `continue` 로 건너
 * 뛴다(꼬리를 끊지 않는다): 이 수가 나가는 문장의 「새 메시지」는 구분선에서 이미
 * **내가 아직 안 읽은 남의 말**을 뜻한다.
 *
 * @param myMemberId `undefined` 면 저자를 모른다는 뜻이고 전부 센다. 남의 말을 안
 *   세는 것이 내 말을 세는 것보다 나쁘다.
 */
export function countNewerThan(
  messages: readonly Message[],
  baseline: number,
  myMemberId?: string,
): number {
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message === undefined || message.seq <= baseline) break;
    if (uuidEq(message.authorMemberId, myMemberId)) continue;
    count += 1;
  }
  return count;
}

/**
 * 위 필의 N. 방을 연 순간의 동결 스냅샷 — 구분선과 같은 수다.
 *
 * 라이브 꼬리를 여기 섞으면 구분선은 5개라는데 위 필은 「새 메시지 41개」라며
 * 꼬리까지 끌어들이고, 낭독도 그 거짓을 읽는다(웹 design-review M-1(a)).
 */
export function countUnreadJump(unreadCount: number | null | undefined): number {
  if (unreadCount == null || unreadCount <= 0) return 0;
  return unreadCount;
}

/** 안읽음 구분선이 지금 창의 어디에 있는가. */
export type DividerViewportRelation = 'above' | 'in' | 'below' | 'absent';

/**
 * 구분선과 창의 관계를 **목록이 실제로 보인다고 한 행들**로 판정한다.
 *
 * 웹은 IntersectionObserver 가 실측한 관계와 virtuoso 의 렌더 범위를 합쳐야 했다
 * (오버스캔 때문에 범위만으로는 창 밖 600px 도 「안」이 된다). 폰의 입력은
 * `onViewableItemsChanged` 이고, 그것은 이미 측정된 셀 위치와 스크롤 오프셋으로
 * 계산한 **보이는** 행이다 — 마운트만 된 행이 아니다. 그래서 둘을 합칠 필요가
 * 없고, 이 함수 하나가 웹의 `relationFromIntersection` 자리에 선다.
 *
 * 아직 아무 행도 보고되지 않았으면 `null` 이다 — 「모른다」를 「없다」로 접지
 * 않는다.
 */
export function dividerRelation(
  dividerIndex: number | null,
  viewableIndices: readonly number[],
): DividerViewportRelation | null {
  if (dividerIndex === null) return 'absent';
  if (viewableIndices.length === 0) return null;
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  for (const index of viewableIndices) {
    if (index === dividerIndex) return 'in';
    if (index < first) first = index;
    if (index > last) last = index;
  }
  if (dividerIndex < first) return 'above';
  if (dividerIndex > last) return 'below';
  // 보이는 행들 사이에 끼어 있는데 그 자신은 안 보인다 — 한 픽셀이라도 겹치면
  // 보이는 것으로 치는 설정이라 실제로는 일어나지 않는다. 일어나면 안이다.
  return 'in';
}

/**
 * 위 필이 서는가: 구분선이 창 **위쪽 밖**에 있고, 동결 N 이 있고, 이 방문에서
 * 아직 래치되지 않았을 때만.
 */
export function shouldShowJumpUnread(
  relation: DividerViewportRelation | null,
  unreadJumpCount: number,
  latched: boolean,
): boolean {
  if (latched) return false;
  return relation === 'above' && unreadJumpCount > 0;
}

// ---- 문장 --------------------------------------------------------------------
//
// 웹 `UnreadPill.tsx` 의 네 함수와 같은 낱말이다. 폰은 숫자를 조각으로 받아 자릿폭을
// 고정해 칠한다 — 구분선(`unreadDividerSegments`)과 같은 문법이고, 웹의
// `data-numeric` 이 하는 일이다.

/** 아래 필. 쌓인 게 있으면 그 수를, 없으면 목적지를 말한다. */
export function jumpLatestSegments(newCount: number): DividerSegment[] {
  if (newCount > 0) {
    return [
      {kind: 'prose', text: '새 메시지 '},
      {kind: 'figure', text: `${newCount}`},
      {kind: 'prose', text: '개 보기'},
    ];
  }
  return [{kind: 'prose', text: '최신 메시지로 이동'}];
}

/** 위 필. 아래 필과 같은 낱말이고, 방향은 화살표가 진다 (웹 design-review L-1). */
export function jumpUnreadSegments(count: number): DividerSegment[] {
  return jumpLatestSegments(count);
}

/** 보이는 문장과 같은 이름. 다른 이름을 붙이면 낭독이 화면과 갈라진다. */
export function jumpLatestAccessibilityLabel(newCount: number): string {
  return newCount > 0 ? `새 메시지 ${newCount}개 보기` : '최신 메시지로 이동';
}

/**
 * 위 필만 「위쪽의」를 붙인다. N 이 동결이라 그 방향이 참이고, 두 필의 이름이
 * 숫자만 다른 낭독을 가른다.
 */
export function jumpUnreadAccessibilityLabel(count: number): string {
  return `위쪽의 새 메시지 ${count}개 보기`;
}

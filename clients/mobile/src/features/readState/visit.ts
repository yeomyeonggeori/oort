import type {ReadState} from '@momo/core/lib/api';
import {
  composedUnreadCount,
  unreadDividerCursorSeq,
} from '@momo/core/features/readState/model';

// =============================================================================
// 한 방문의 안읽음 경계 (ADR-0178 D3·D6, #1964 R1 H-1).
//
// 대화 화면은 방을 연 순간의 경계를 얼려 두고 그 방문 내내 그린다. 커서가 전진해도
// 구분선이 사람 밑에서 사라지지 않게 하려는 것이다. 다만 **얼린 뒤에 도착한 마크는
// 받아들여야 한다.** 첫 판은 얼린 것을 끝까지 들고 갔다. 그래서 폰이 캐시로 방을 열면
// (앱 재개·켜진 앱에서 푸시 탭) 데스크탑이 방금 건 마크가 스냅샷에 들어오지 못했다.
// 그 상태에서 명시 열람이 서버에서 마크를 지웠고, 마크는 한 번도 그려지지 않았다
// (design-review 2593 R1 H-1, 실측 재현).
//
// 규칙은 웹 `clients/web/src/features/chat/openedReadState.ts` 의 `foldInVisitMark`
// 와 같은 방향이다.
//
//   **방을 열 때** 폰이 든 행으로 얼린다. 행이 아직 없으면 첫 행이 경계가 된다.
//   **마크를 싣고 온 행**(이 방문에서 건 것이든 다른 기기가 건 것이든)은 경계를
//     대신한다.
//   **마크 없는 행**은 경계를 건드리지 않는다. 그 행이 비어 있는 까닭은 이 방문의
//     명시 열람이 방금 지웠거나, 이 화면이 커서를 보고했기 때문이다. 둘 다 사람이
//     읽던 경계를 지울 이유가 아니다.
//
// ## 웹과 다른 한 가지, 그리고 그것이 이 파일의 모양이다
//
// 웹은 연 순간의 커서·head 를 그대로 두고 **마크 값만** 갈아 끼운다. 그러려면 마크
// 필드를 이름으로 읽어야 한다. 폰은 그 필드를 `src/` 어디에서도 부르지 않는다
// (`__tests__/markUnreadConsumption.test.tsx` 의 게이트). 합성은 코어 한 곳에서만
// 하고 폰은 그 결과만 소비한다.
//
// 그래서 폰은 마크를 실은 행이 오면 **그 행의 합성값 한 쌍**(구분선 커서, 수)으로
// 경계를 바꾼다. 구분선이 서는 자리는 웹과 같다. 다른 것은 둘뿐이다.
//   - 수 N 이 그 사이 도착한 메시지까지 셀 수 있다. 웹은 연 순간의 head 까지만 센다.
//   - 연 뒤에 도착한 메시지에 다른 기기가 마크를 걸면 폰은 그 자리에 구분선을
//     그린다. 웹은 얼린 head 가 그 메시지보다 앞이라 수가 0 이 되고 아무것도 그리지
//     않는다.
// =============================================================================

/** 한 방문의 경계. `Timeline` 에 그대로 건넨다. */
export interface VisitBoundary {
  channelId: string;
  /** `buildTimelineItems` 에 건넬 커서. 구분선은 이 seq 다음 메시지 위에 선다. */
  lastReadSeq: number;
  /** 구분선에 적는 수. */
  unreadCount: number;
}

/**
 * 이 행의 마크가 안읽음 시작을 커서보다 앞으로 당기는가.
 *
 * 코어의 합성 결과로만 묻는다. `unreadDividerCursorSeq` 가 행 자신의 커서와 다르면
 * 합성이 마크를 썼다는 뜻이다. 마크가 없거나 커서 뒤에 있으면(D3 의 `min` 이 버린다)
 * 거짓이다. 그런 마크는 합성에 아무 영향이 없으므로, 받아들여도 화면은 같다.
 */
export function carriesMark(read: ReadState): boolean {
  return unreadDividerCursorSeq(read) !== read.lastReadSeq;
}

/** 행 하나를 경계로 얼린다. 두 수 모두 코어 D3 단일점에서 나온다. */
export function boundaryOf(channelId: string, read: ReadState): VisitBoundary {
  return {
    channelId,
    lastReadSeq: unreadDividerCursorSeq(read),
    unreadCount: composedUnreadCount(read),
  };
}

/**
 * 살아 있는 행을 한 번 더 보고 이 방문의 경계를 정한다. 렌더마다 부른다.
 *
 * - 다른 방의 경계이거나 아직 경계가 없으면 이 행으로 얼린다. 행이 없으면 `null`
 *   이고, 그때는 구분선을 그리지 않는다.
 * - 행이 마크를 싣고 왔으면 그 행이 경계를 대신한다. 값이 같으면 같은 객체를
 *   돌려준다.
 * - 그 밖에는 경계를 그대로 둔다.
 */
export function foldVisitBoundary(
  current: VisitBoundary | null,
  channelId: string,
  live: ReadState | null,
): VisitBoundary | null {
  if (current === null || current.channelId !== channelId) {
    return live === null ? null : boundaryOf(channelId, live);
  }
  if (live !== null && carriesMark(live)) {
    const next = boundaryOf(channelId, live);
    return next.lastReadSeq === current.lastReadSeq &&
      next.unreadCount === current.unreadCount
      ? current
      : next;
  }
  return current;
}

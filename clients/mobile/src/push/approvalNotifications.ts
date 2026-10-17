import {
  dismissNotificationAsync,
  getPresentedNotificationsAsync,
  type Notification,
} from 'expo-notifications';

import {parsePushEnvelope} from './envelope';

// =============================================================================
// 결정된 승인의 알림을 알림 센터에서 걷는다 (#3926, ADR-0204 D6 마지막 줄).
//
// 승인 푸시의 「승인」·「거절」 버튼은 그 승인이 결정된 뒤에도 알림 센터에 산 채로
// 남았다. 앱 안에서 결정했든, 다른 기기가 결정했든, 같은 승인의 알림 하나를 눌러
// 결정했든 마찬가지다. 남은 버튼을 누르면 서버가 409(이미 결정됨)로 답할 뿐이라
// 해롭지는 않지만, 잠금 화면이 이미 끝난 일을 「아직 처리할 것」으로 말한다.
//
// 이 파일은 그 동작 하나다. 부르는 곳은 셋이고, 셋 모두 이 함수를 같은 인자로 부른다.
//
//   앱 안 결정                  `features/inbox/ApprovalDecision.tsx`
//   알림 버튼                   `push/notifications.ts` `decideFromNotification`
//   다른 곳에서 결정된 것       `push/settledApprovalNotifications.ts`(원장 관찰자)
//
// 이 파일은 일부러 세션·쿼리·코어 API를 import하지 않는다. 결정을 보내는 파일
// (`notifications.ts`)과 결정 컨트롤(`ApprovalDecision.tsx`)이 이 동작을 쓰려고 무거운
// 의존을 끌고 오지 않게 하려는 것이다.
//
// ## 「그 승인의 알림만」
//
// 배달된 알림마다 봉투(`parsePushEnvelope`)를 다시 읽어 `momo.approval_id`가 같은
// 것만 걷는다. 봉투를 읽지 못하는 알림은 걷지 않는다 — 무엇인지 모르는 것을 지우는
// 쪽이 틀렸을 때 더 비싸다. 다른 승인의 알림, 메시지·멘션·작업 알림은 그대로다.
// =============================================================================

const LOG = '[push]';

/**
 * 배달된 알림 중 이 승인의 것. 순수 함수라 알림 센터 없이 못박을 수 있다.
 *
 * 비교는 소문자로 접어서 한다. 봉투의 id는 파서가 소문자로 접지만, 원장의
 * `Approval.id`는 대문자로 올 수 있고(`approvals.test`의 와이어 형상) 같은 UUID다.
 */
export function approvalNotificationIds(
  presented: readonly Notification[],
  approvalId: string,
): string[] {
  const wanted = approvalId.toLowerCase();
  const ids: string[] = [];
  for (const notification of presented) {
    const trigger = notification.request.trigger as {payload?: unknown} | null;
    const envelope = parsePushEnvelope(trigger?.payload);
    if (envelope !== null && envelope.approvalId === wanted) {
      ids.push(notification.request.identifier);
    }
  }
  return ids;
}

/**
 * 이 승인의 배달된 알림을 걷는다. 걷은 수를 돌려주고, **절대 던지지 않는다.**
 *
 * 결정은 이미 원장에 적혔다. 알림을 못 걷은 일이 기록된 결정을 실패로 바꾸면
 * 안 되므로, 알림 센터를 못 읽거나 하나를 못 지워도 경고만 남기고 나머지를
 * 계속한다. 모듈이 없는 빌드(`getPresentedNotificationsAsync`가 던진다)에서도
 * 마찬가지다.
 */
export async function dismissApprovalNotifications(
  approvalId: string,
): Promise<number> {
  try {
    const presented = await getPresentedNotificationsAsync();
    const ids = approvalNotificationIds(presented, approvalId);
    if (ids.length === 0) return 0;
    const results = await Promise.allSettled(
      ids.map(identifier => dismissNotificationAsync(identifier)),
    );
    let dismissed = 0;
    for (const result of results) {
      if (result.status === 'fulfilled') {
        dismissed += 1;
      } else {
        console.warn(
          `${LOG} could not dismiss a decided approval's notification`,
          result.reason,
        );
      }
    }
    if (dismissed > 0) {
      console.log(
        `${LOG} dismissed ${dismissed} notification(s) of decided approval …${approvalId.slice(-8)}`,
      );
    }
    return dismissed;
  } catch (cause) {
    console.warn(`${LOG} could not read the delivered notifications`, cause);
    return 0;
  }
}

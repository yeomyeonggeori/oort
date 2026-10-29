import {uuidEq} from '@momo/core/lib/api';
import {
  setNotificationHandler,
  type Notification,
  type NotificationBehavior,
} from 'expo-notifications';

import {parsePushEnvelope, pushPayloadOfRequest, threadRootId} from './envelope';
import {viewedConversation, type ViewedConversation} from './viewedConversation';

// =============================================================================
// 앱이 앞에 떠 있는 동안 온 푸시를 어떻게 보일 것인가 (#4310, #4295 후속).
//
// ## 처리기가 없으면 알림이 사라진다
//
// expo-notifications 57.0.8 의 iOS 는 JS 처리기가 없으면 `willPresent` 를
// `completionHandler([])` 로 끝낸다(`NotificationCenterManager`: 델리게이트가 아무도 「처리했다」고
// 답하지 않으면 빈 옵션). 처리기 모듈은 JS 가 `setNotificationHandler` 로 **구독하는 순간에야**
// 델리게이트에 붙는다(`HandlerModule.OnStartObserving`). 그래서 이 앱은 열려 있는 동안 온 푸시를
// 배너도 목록도 소리도 없이 잃었다 — 다른 대화를 보고 있어도 마찬가지다.
//
// 그래서 이 파일의 `installForegroundNotificationHandler` 는 **세션·화면과 무관하게, JS 가 도는 가장
// 이른 자리에서** 한 번 건다: `index.js` 의 모듈 평가 시점, `AppRegistry.registerComponent` 보다 앞이다.
// React 트리가 서기 전이고 첫 렌더나 `useEffect` 를 기다리지도 않는다. (1단계에서는 `App.tsx` 의 시작
// effect 에 있었다 — 첫 렌더가 커밋된 뒤라서 그 사이에 도착한 푸시는 같은 증상으로 사라질 수 있었다.
// `PushProvider` 는 로그인 복원이 끝난 뒤에야 서므로 더 늦다.) 하네스 루트(`-momoMeasure`·`-momoSessionGate`)도
// 같은 `index.js` 를 거치므로 거기서도 같은 처리기가 걸린다.
//
// **그래도 남는 틈:** JS 번들이 로드되기 **전**에 도착한 푸시는 이 처리기가 아직 없어서 iOS 기본(`[]`)으로
// 사라진다. 그 틈은 네이티브 쪽 기본 처리기가 있어야 닫히며 이 변경의 범위 밖이다(별도 이슈).
//
// `setNotificationHandler` 는 부를 때마다 앞의 처리기를 **갈아 끼우므로** 다른 곳에서 한 번 더 부르면 이
// 규칙이 조용히 꺼진다 — 호출 자리가 이 앱에 하나뿐(`index.js`)임을 `foregroundPresentation.test.tsx`
// 가 소스에서 센다.
//
// ## 규칙: 보고 있는 대화의 알림만 숨긴다 — 승인 요청은 빼고
//
//   - 같은 워크스페이스·같은 채널을 보고 있고, 알림이 스레드 답글이면 **같은 스레드** 가 열려
//     있을 때만 숨긴다(배너·소리·알림 센터 목록 모두 없음).
//   - **승인 요청(`momo.approval`·`momo.approval.open`)은 같은 방을 보고 있어도 보인다.** 행동이 필요한
//     알림이라 예외다(#2592 권고안 A, 기획 결정 1). 숨기는 규칙은 이미 눈앞에 있는 것을 겹쳐 띄우지 않으려는
//     것인데, 승인은 누군가 결정해야 끝나는 일이다.
//   - 그 밖에는 iOS 배너 + 알림 센터 목록으로 보이고, 소리는 페이로드의 `aps.sound` 를 따른다.
//   - **봉투를 못 읽으면 보인다.** 숨기는 쪽으로 실패하지 않는다.
//
// 음소거·방해 금지·일시 중지는 서버가 이미 판정해서 보낸 것이다. 폰이 다시 판정하지 않는다 —
// 도착한 것은 보인다.
//
// ## 「같은 서버」는 비교하지 않는다
//
// 봉투의 `server_id` 는 알림을 쏘는 서버의 설정값(`PUSH_RELAY_SERVER_ID`)이라 이 앱이 자기 서버에서
// 읽을 방법이 없다(어떤 API 도 돌려주지 않고, 이 앱은 한 번에 한 서버에만 로그인한다). 워크스페이스·채널·
// 스레드는 서버가 만든 UUID 라 다른 서버의 방과 겹치지 않으므로 그 비교가 서버 비교를 겸한다.
//
// ## 처리기는 던지지도, 기다리지도 않는다
//
// 처리기가 던지거나 3초 안에 답하지 않으면 알림은 **버려진다**(`NotificationsHandler`: `handleError`
// 로 가고 네이티브의 `handleNotificationAsync` 가 불리지 않는다). 그건 조용히 숨기는 쪽으로의 실패라서,
// 결정 전체를 try/catch 로 감싸 어떤 예외든 「보임」으로 답한다. 결정은 메모리만 읽는 동기 계산이다.
//
// ## 배지는 건드리지 않는다
//
// `shouldSetBadge` 는 두 갈래 모두 false 다. 처리기가 없던 때의 `completionHandler([])` 에는 `.badge` 가
// 없었으니 앞에 있는 동안 iOS 는 푸시의 `aps.badge` 를 한 번도 적용하지 않았다. false 는 그 동작을
// 그대로 둔다. 앞에 있는 동안 아이콘 숫자의 주인은 `appBadge.ts`(서버 읽음 투영의 합) 하나다.
// =============================================================================

const LOG = '[push]';

/** 보인다: iOS 배너 + 알림 센터 목록 + 페이로드의 소리. 배지는 건드리지 않는다. */
const SHOWN: NotificationBehavior = Object.freeze({
  shouldShowBanner: true,
  shouldShowList: true,
  shouldPlaySound: true,
  shouldSetBadge: false,
});

/** 보이지 않는다: 배너도, 알림 센터 목록에 남기는 것도, 소리도 없다. */
const HIDDEN: NotificationBehavior = Object.freeze({
  shouldShowBanner: false,
  shouldShowList: false,
  shouldPlaySound: false,
  shouldSetBadge: false,
});

export type ForegroundDecision =
  | {
      show: true;
      /**
       * 왜 보이는가. 로그와 시험이 읽는 한 낱말이고, 화면을 고르는 값이 아니다.
       *   unreadable          봉투를 못 읽었다(스키마·어휘가 다른 서버, 우리 것이 아닌 알림).
       *   not-viewing         앞에 있는 대화가 없다(목록·인박스·설정, 또는 앱이 앞이 아니다).
       *   other-workspace     다른 워크스페이스의 알림이다.
       *   other-conversation  다른 채널의 알림이다.
       *   other-thread        같은 채널이지만 열려 있지 않은 스레드의 답글이다.
       *   approval            승인 요청이다 — 같은 방을 보고 있어도 보인다(행동이 필요한 알림).
       */
      why:
        | 'unreadable'
        | 'not-viewing'
        | 'other-workspace'
        | 'other-conversation'
        | 'other-thread'
        | 'approval';
    }
  | {show: false; why: 'viewing'};

/**
 * 알림 한 건을 보일지. 순수하다 — 화면 상태는 인자로 받는다.
 *
 * 봉투 ids 는 파서가 소문자로 접어 돌려주지만 화면의 ids 는 서버가 준 그대로라서 `uuidEq` 로 비교한다.
 */
export function decideForeground(
  payload: unknown,
  viewing: ViewedConversation | null,
): ForegroundDecision {
  const envelope = parsePushEnvelope(payload);
  if (envelope === null) return {show: true, why: 'unreadable'};
  if (viewing === null) return {show: true, why: 'not-viewing'};
  if (!uuidEq(envelope.workspaceId, viewing.workspaceId)) {
    return {show: true, why: 'other-workspace'};
  }
  if (!uuidEq(envelope.channelId, viewing.channelId)) {
    return {show: true, why: 'other-conversation'};
  }
  // 스레드 답글은 **그 스레드가 열려 있을 때만** 보고 있는 것이다. 채널 본류를 보는 중이거나 다른
  // 스레드를 열어 둔 사람에게 다른 스레드의 새 답글은 새 소식이다.
  const root = threadRootId(envelope);
  if (
    root !== null &&
    (viewing.threadRootId === null || !uuidEq(root, viewing.threadRootId))
  ) {
    return {show: true, why: 'other-thread'};
  }
  // 여기까지 오면 보고 있는 대화다. 단 승인 요청은 예외로 보인다 — 행동이 필요한 알림이다(#2592 권고안 A).
  // `approvalId` 는 승인 카테고리 둘(`momo.approval`·`momo.approval.open`)에만 실리고 그 밖의 카테고리에
  // 실려 있으면 파서가 봉투째 거절한다(`parsePushEnvelope` 의 쌍조건). 그래서 승인 id 가 있다 = 승인 요청이다.
  if (envelope.approvalId !== null) return {show: true, why: 'approval'};
  return {show: false, why: 'viewing'};
}

/**
 * expo-notifications 가 알림마다 부르는 처리기의 본체. 어떤 경우에도 던지지 않는다.
 */
export async function presentForeground(
  notification: Notification,
): Promise<NotificationBehavior> {
  try {
    const decision = decideForeground(
      pushPayloadOfRequest(notification.request),
      viewedConversation(),
    );
    // 기기 확인(docs/cicd/11)이 grep 하는 줄. 아이디도 본문도 적지 않는다 — 결과와 이유만.
    console.log(
      `${LOG} foreground notification -> ${decision.show ? 'shown' : 'hidden'} (${decision.why})`,
    );
    return decision.show ? SHOWN : HIDDEN;
  } catch (cause) {
    // 판정이 터져도 알림은 보인다. 숨기는 쪽으로 실패하지 않는다.
    console.warn(
      `${LOG} foreground notification decision failed -> shown`,
      cause instanceof Error ? cause.message : String(cause),
    );
    return SHOWN;
  }
}

/**
 * 처리기를 건다. `index.js` 의 모듈 평가 시점에 **한 번** 부른다(머리말). 돌려주는 함수는 처리기를
 * 거두는 쪽이며, 앱 수명과 같은 `index.js` 는 쓰지 않는다 — 시험이 쓴다.
 *
 * 거는 데 실패해도 앱 시작을 막지 않는다 — 배너를 못 띄우는 것이 앱을 못 여는 것보다 낫다.
 */
export function installForegroundNotificationHandler(): () => void {
  try {
    setNotificationHandler({
      handleNotification: presentForeground,
      // 알림 본문이 실릴 수 있어 오류 객체째 남기지 않는다(`NotificationTimeoutError.info`). 오류 자리에
      // 무엇이 와도 이 줄이 던지지 않는다(`handleError` 가 던지면 로그 한 줄 때문에 또 하나의 실패가 된다).
      handleError: (_id, error) =>
        console.warn(
          `${LOG} foreground notification was not presented: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
    });
  } catch (cause) {
    console.error(`${LOG} foreground notification handler not installed`, cause);
    return () => {};
  }
  return () => setNotificationHandler(null);
}

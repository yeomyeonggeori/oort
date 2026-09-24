import {uuidEq, type Channel, type Message} from '@momo/core/lib/api';
import {
  DEFAULT_ACTION_IDENTIFIER,
  type NotificationResponse,
} from 'expo-notifications';

import type {PushCategory} from './contract';
import {parsePushEnvelope, threadRootId} from './envelope';

// =============================================================================
// 알림 본문을 누르면 어디로 가는가 (#2569, ADR-0187 D4).
//
// 여태 본문 탭은 앱만 열었다(`handlePushResponse` 의 `opened`). 이 파일은 그
// 탭이 **무엇을 가리키는지**만 정한다 — 어떻게 도착했는지(콜드 런치·백그라운드
// ·포그라운드)는 `PushProvider` 의 몫이고, 화면을 여는 것은 셸의 몫이다.
// `deeplink/deviceLink.ts` 가 링크에 대해 하는 일과 같은 나눔이다.
//
// ## 알림은 식별자만 나른다 (ADR-0120 D2-A)
//
// 목적지는 봉투에 이미 있는 id 로만 짓는다: 채널·메시지·스레드 루트
// (`aps.thread-id` 가 채널 id 와 다를 때)·승인. 본문도 제목도 쓰지 않는다 —
// 그것은 자기 서버에서 다시 읽는 것이지 알림이 들고 오는 것이 아니다. 그래서 이
// 파일에는 페이로드에 무엇을 더할 이유가 없다.
//
// 승인 카드는 **메시지다**. 판정이 승인을 `a.request_message_id = message_id` 로
// 묶어 보내므로(`momo-push/src/judgment.rs`), 메시지로 착지하는 것이 곧 그
// 카드로 착지하는 것이다. `approvalId` 는 그 사실을 들고 다닐 뿐 두 번째 길이
// 아니다.
//
// ## 조용히 실패하지 않는다
//
// 못 가는 이유마다 **한 문장**이 있다. 앱만 열리고 아무 말이 없으면, 사람은
// 알림이 가리키던 것을 찾아 목록을 뒤지거나 알림이 거짓말을 했다고 결론 낸다.
// =============================================================================

/** 알림이 가리키는 곳. 전부 봉투에 있던 식별자다. */
export interface NotificationTarget {
  channelId: string;
  /** 알림의 그 메시지. 승인 알림이면 승인 카드 자체다. */
  messageId: string;
  /** 답글이면 그 스레드의 루트. 채널 본류의 메시지면 null. */
  threadRootId: string | null;
  /** 승인 알림일 때만. 카드가 `messageId` 자리에 있다. */
  approvalId: string | null;
  category: PushCategory;
}

export type TapArrival =
  | {kind: 'target'; target: NotificationTarget}
  /**
   * 열 수 없다는 것만은 확실한 탭.
   *
   * `unreadable` 은 봉투가 이 앱이 아는 모양이 아닐 때(스키마·어휘가 다른
   * 서버), `other-workspace` 는 지금 로그인한 워크스페이스의 알림이 아닐 때다.
   * 후자는 보안 경계이기도 하다 — 떠난 워크스페이스의 알림이 지금 워크스페이스의
   * 대화를 열면 안 된다(`handlePushResponse` 의 같은 검사와 같은 이유).
   */
  | {kind: 'unavailable'; reason: 'unreadable' | 'other-workspace'};

/**
 * 한 번의 응답이 가리키는 곳. **본문 탭이 아니면 null** 이다.
 *
 * 승인·거절·빠른 답장 버튼은 여기서 다루지 않는다. 그것들은 앱을 앞으로 부르지
 * 않고(`categories.ts` 의 `opensAppToForeground: false`) 자기 일을 한다 — 거기서
 * 화면을 옮기는 것은 사람이 누른 것이 아니다.
 */
export function tapArrival(
  response: NotificationResponse | null | undefined,
  signedInWorkspaceId: string,
): TapArrival | null {
  if (!response || response.actionIdentifier !== DEFAULT_ACTION_IDENTIFIER) {
    return null;
  }
  const trigger = response.notification.request.trigger as
    | {payload?: unknown}
    | null;
  const envelope = parsePushEnvelope(trigger?.payload);
  if (!envelope) return {kind: 'unavailable', reason: 'unreadable'};
  if (envelope.workspaceId !== signedInWorkspaceId.toLowerCase()) {
    return {kind: 'unavailable', reason: 'other-workspace'};
  }
  return {
    kind: 'target',
    target: {
      channelId: envelope.channelId,
      messageId: envelope.messageId,
      threadRootId: threadRootId(envelope),
      approvalId: envelope.approvalId,
      category: envelope.category,
    },
  };
}

/**
 * 한 응답을 한 번만 세는 열쇠.
 *
 * 콜드 런치의 탭은 두 길로 올 수 있다 — 네이티브가 들고 있던 마지막 응답과,
 * 리스너가 붙은 뒤의 이벤트. 같은 탭이 두 번 착지하면 두 번째가 첫 번째 위에서
 * 화면을 다시 흔든다. 날짜까지 넣는 이유: 알림 id 는 APNs collapse id 라 같은
 * 메시지의 재전송이 같은 id 를 쓴다.
 */
export function tapResponseKey(response: NotificationResponse): string {
  return [
    response.notification.request.identifier,
    String(response.notification.date),
    response.actionIdentifier,
  ].join('|');
}

/**
 * 탭이 갈 수 없을 때의 한 문장 (#2569 수용기준 2).
 *
 * 문장마다 **무엇이 없는지**를 말한다. 「열 수 없습니다」 한 벌로 뭉개면, 권한이
 * 없는 사람과 링크가 잘못된 사람이 같은 말을 듣고 둘 다 무엇을 해야 할지 모른다.
 */
export const NOTIFICATION_TAP_COPY = {
  unreadable: '이 알림이 가리키는 곳을 읽지 못해 앱만 열었습니다.',
  otherWorkspace: '이 알림은 다른 워크스페이스의 것이라 여기서 열 수 없습니다.',
  channelGone: '이 알림의 대화가 없어졌거나 볼 권한이 없습니다.',
  // 목록 조회 실패는 여기 문장이 없다 (#2584 리뷰 M-1). 그 사실은 목록 자리의
  // `ErrorState` 한 상자가 말하고(`CHANNEL_LIST_FAILED`), 탭은 그 「다시 시도」가
  // 성공할 때까지 기다린다(`useNotificationTapRouting`).
  messageDeleted: '이 알림의 메시지는 삭제됐습니다.',
  threadRootNotLoaded:
    '스레드 첫 메시지를 이 화면에서 찾지 못해 채널에서 답글 위치로 이동했습니다.',
} as const;

/** `unavailable` 한 갈래의 문장. */
export function unavailableCopy(
  reason: Extract<TapArrival, {kind: 'unavailable'}>['reason'],
): string {
  return reason === 'other-workspace'
    ? NOTIFICATION_TAP_COPY.otherWorkspace
    : NOTIFICATION_TAP_COPY.unreadable;
}

/**
 * 목록에서 열 수 있는 그 채널, 없으면 null.
 *
 * 서버의 채널 목록은 **멤버십으로 걸러져** 온다(`list_workspace_channels` 가
 * `left_at IS NULL` 인 멤버십과 조인한다). 그래서 목록에 없다는 것은 그 방이
 * 사라졌거나, 이 사람이 거기서 나왔다는 뜻이다 — 둘 다 「볼 수 없다」이고, 이
 * 판정에 두 번째 요청은 필요 없다. 보관된 방은 사이드바가 이미 목록에서 빼므로
 * (`useChannels`) 여기서도 없는 방이다.
 */
export function openableChannel(
  channels: readonly Channel[] | undefined,
  channelId: string,
): Channel | null {
  return (
    channels?.find(
      channel =>
        uuidEq(channel.id, channelId) && channel.archivedAtMs === undefined,
    ) ?? null
  );
}

/** 대화 화면이 알림 한 번에 대해 받는 것. 탭마다 `token` 이 새로 선다. */
export interface NotificationLanding {
  messageId: string;
  threadRootId: string | null;
  token: number;
}

export interface NotificationLandingPlan {
  /** 채널 위에 열 스레드. 루트가 로드돼 있을 때만 선다 — 없는 루트를 지어내지 않는다. */
  thread: Message | null;
  /** 채널 타임라인에서 그 메시지로 점프하는가. 스레드를 열면 착지는 스레드 안에서 한다. */
  jumpInChannel: boolean;
  /**
   * 착지와 함께 말할 한 문장. 없으면 null.
   *
   * 스레드를 열면 스레드 **안에** 선다 — 채널 쪽 자리는 스레드 판이 덮으므로, 거기
   * 세우면 스레드를 닫기 전까지 아무도 못 읽는다.
   */
  notice: string | null;
}

/**
 * 첫 페이지가 도착한 채널에서, 알림 하나를 어떻게 보여 줄 것인가.
 *
 * 순수하다 — 화면은 이 답을 그대로 실행하고, 이 판정은 화면 없이 시험된다.
 *
 * - 답글이고 루트가 로드돼 있으면 **스레드를 연다.** 답글은 스레드 안에서
 *   `loadReplies` 가 가져오므로, 착지도 거기서 한다.
 * - 답글인데 루트가 로드된 범위 밖이면, 답글 자체는 채널의 행이므로(서버의 채널
 *   히스토리는 답글을 거르지 않는다) **채널에서 그 답글에 착지**하고 스레드를
 *   못 연 이유를 말한다.
 * - 그 메시지가 로드된 범위에 없으면 점프가 빈손으로 돌아오고, 그 문장은 점프
 *   기계가 이미 갖고 있다(`jumpMissedNotice(…, 'notification')`) — 두 번째 문장을
 *   세우지 않는다.
 * - 지워진 메시지면 묘비(또는 그 묘비를 대신해 선 접힌 행)에 착지하고, 지워졌다고
 *   한 문장으로 말한다. **스레드 안에서도 같다** (#2584 리뷰 N-2). 알 수 있는 것은
 *   첫 페이지에 그 답글이 있을 때다(채널 히스토리는 답글을 거르지 않으므로 대개
 *   있다). 없으면 스레드가 불러온 묘비가 스스로 말한다.
 */
export function planNotificationLanding(
  messages: readonly Message[],
  landing: Pick<NotificationLanding, 'messageId' | 'threadRootId'>,
): NotificationLandingPlan {
  const target = messages.find(message => uuidEq(message.id, landing.messageId));
  const deleted = target?.state === 'deleted';
  if (landing.threadRootId !== null) {
    const rootId = landing.threadRootId;
    const root = messages.find(message => uuidEq(message.id, rootId)) ?? null;
    if (root) {
      // 채널과 **같은 문장**이다 (#2584 리뷰 N-2). 첫 판은 「묘비가 스스로 말한다」를
      // 근거로 여기서만 입을 다물었는데, 그 근거는 채널에서도 똑같이 성립한다 —
      // 한쪽만 말하면 같은 사실에 두 처리가 된다. 문장은 화면이 스레드 안에 세운다.
      return {
        thread: root,
        jumpInChannel: false,
        notice: deleted ? NOTIFICATION_TAP_COPY.messageDeleted : null,
      };
    }
    return {
      thread: null,
      jumpInChannel: true,
      notice:
        target === undefined
          ? null
          : deleted
            ? NOTIFICATION_TAP_COPY.messageDeleted
            : NOTIFICATION_TAP_COPY.threadRootNotLoaded,
    };
  }
  return {
    thread: null,
    jumpInChannel: true,
    notice: deleted ? NOTIFICATION_TAP_COPY.messageDeleted : null,
  };
}

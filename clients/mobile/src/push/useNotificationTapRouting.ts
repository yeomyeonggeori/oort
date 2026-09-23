import {channelLabel} from '@momo/core/features/workspace/directory';
import {useCallback, useEffect, useRef, useState} from 'react';
import {AccessibilityInfo} from 'react-native';

import {useInvalidateApprovals} from '../features/inbox/useInbox';
import {useChannels, useDirectory} from '../features/workspace/queries';
import type {NavAction} from '../nav/state';
import {useSession} from '../session/useSession';
import {usePushArrival} from './PushProvider';
import {
  NOTIFICATION_TAP_COPY,
  openableChannel,
  unavailableCopy,
} from './tapArrival';

// =============================================================================
// 본문 탭 하나를 셸의 항법 하나로 (#2569).
//
// `PushProvider` 가 탭을 받고(세 길 중 어느 것으로 왔든), 이 훅이 그것을 **열 수
// 있는 대화**로 바꾼다. 셸에 두는 이유는 하나다: 제목을 지으려면 채널 목록과
// 명부가 있어야 하고(`channelLabel` — DM 의 제목은 상대의 이름이다), 그 둘은
// 셸 안에서만 살아 있다.
//
// ## 첫 읽기를 기다린다
//
// 콜드 런치의 탭은 채널 목록보다 먼저 도착한다. 그때 「목록에 없다」고 판정하면
// 아직 오는 중인 방을 없다고 말하게 된다. 그래서 채널과 명부의 **첫 답**이 올
// 때까지 탭을 들고 있는다.
//
// ## 목록에 없으면 한 번 더 묻는다
//
// 목록은 캐시다. 방금 누가 만든 DM 은 아직 거기 없을 수 있다. 「없어졌거나 볼
// 권한이 없습니다」는 되돌릴 수 없는 말이 아니지만 틀리면 사람을 헛걸음시키므로,
// 캐시가 모른다고 할 때 서버에 한 번 다시 묻고, 그래도 없을 때만 말한다. 다시 묻기가
// 실패하면 **그 사실을** 말한다 — 연결이 끊긴 것을 권한 문제로 바꿔 말하지 않는다.
//
// ## 못 가면 대화 목록에서 말한다
//
// 대화를 열 수 없을 때 사람을 두는 자리는 그 대화가 **있었어야 할 곳**, 대화
// 목록이다. 문장은 목록 머리에 인라인으로 서고(토스트가 아니다 — 디자인 시스템
// §4), 사람이 방금 한 행동의 영수증이므로 닫을 수 있다(`NoticeBlock.onDismiss`).
// =============================================================================

export interface NotificationTapRouting {
  /** 탭이 갈 수 없었던 이유, 한 문장. 없으면 null. */
  notice: string | null;
  dismissNotice: () => void;
}

export function useNotificationTapRouting(
  dispatch: (action: NavAction) => void,
): NotificationTapRouting {
  const {member, workspaceId} = useSession();
  const pushArrival = usePushArrival();
  const channels = useChannels(workspaceId);
  const roster = useDirectory(workspaceId);
  const invalidateApprovals = useInvalidateApprovals();
  const [notice, setNotice] = useState<string | null>(null);

  // 비동기 판정이 끝나는 순간의 명부로 제목을 짓는다. 효과가 시작될 때의 것을
  // 붙들면, 다시 묻는 사이에 도착한 명부가 헤더에 반영되지 않는다.
  const directoryRef = useRef(roster.directory);
  directoryRef.current = roster.directory;

  /** 마지막으로 **맡은** 탭. 판정이 끝나기 전에 새 탭이 오면 옛 판정은 버린다. */
  const handledRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  const fail = useCallback(
    (sentence: string) => {
      setNotice(sentence);
      dispatch({type: 'selectTab', tab: 'channels'});
      // 이 문장은 사람이 누른 곳과 다른 화면에 선다. 화면을 보지 않는 사람에게는
      // 알림을 눌렀는데 아무 일도 없었던 것과 같으므로 소리로도 말한다.
      AccessibilityInfo.announceForAccessibility(sentence);
    },
    [dispatch],
  );

  const firstReadIn = !channels.isPending && !roster.isPending;
  const channelList = channels.data;
  const refetchChannels = channels.refetch;

  useEffect(() => {
    if (pushArrival === null || handledRef.current === pushArrival.token) {
      return;
    }
    const {token, arrival} = pushArrival;
    if (arrival.kind === 'unavailable') {
      handledRef.current = token;
      fail(unavailableCopy(arrival.reason));
      return;
    }
    if (!firstReadIn) return;
    handledRef.current = token;
    const {target} = arrival;
    const stillCurrent = () =>
      mountedRef.current && handledRef.current === token;

    void (async () => {
      let channel = openableChannel(channelList, target.channelId);
      if (channel === null) {
        const refreshed = await refetchChannels();
        if (!stillCurrent()) return;
        if (refreshed.isError) {
          fail(NOTIFICATION_TAP_COPY.listFailed);
          return;
        }
        channel = openableChannel(refreshed.data, target.channelId);
      }
      if (channel === null) {
        fail(NOTIFICATION_TAP_COPY.channelGone);
        return;
      }
      // 승인 카드의 컨트롤은 대기 원장에서 온다(`usePendingApprovals`). 그 캐시는
      // 이 알림보다 먼저 읽혔을 수 있고, 그러면 방금 도착한 승인이 카드에서 「인박스나
      // 데스크톱에서」라고 말한다 — 결정하라고 부른 알림이 결정할 수 없는 카드로
      // 데려가는 셈이다.
      if (target.approvalId !== null) invalidateApprovals();
      setNotice(null);
      dispatch({
        type: 'openFromNotification',
        conversation: {
          channelId: channel.id,
          title: channelLabel(channel, directoryRef.current, member.id),
          notification: {
            messageId: target.messageId,
            threadRootId: target.threadRootId,
            token,
          },
        },
      });
    })();
  }, [
    pushArrival,
    firstReadIn,
    channelList,
    refetchChannels,
    fail,
    invalidateApprovals,
    dispatch,
    member.id,
  ]);

  const dismissNotice = useCallback(() => setNotice(null), []);
  return {notice, dismissNotice};
}

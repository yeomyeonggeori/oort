import {channelLabel} from '@momo/core/features/workspace/directory';
import {useCallback, useEffect, useRef, useState} from 'react';
import {AccessibilityInfo} from 'react-native';

import {useInvalidateApprovals} from '../features/inbox/useInbox';
import {CHANNEL_LIST_FAILED} from '../features/sidebar/rows';
import {useChannels, useDirectory} from '../features/workspace/queries';
import type {NavAction, OpenConversation, Tab} from '../nav/state';
import {useSession} from '../session/useSession';
import {usePushArrival} from './PushProvider';
import {
  NOTIFICATION_TAP_COPY,
  openableChannel,
  unavailableCopy,
  type NotificationTarget,
} from './tapArrival';

// =============================================================================
// 본문 탭 하나를 셸의 항법 하나로 (#2569).
//
// `PushProvider` 가 탭을 받고(세 길 중 어느 것으로 왔든), 이 훅이 그것을 **열 수
// 있는 대화**로 바꾼다. 셸에 두는 이유는 하나다: 제목을 지으려면 채널 목록과
// 명부가 있어야 하고(`channelLabel` — DM 의 제목은 상대의 이름이다), 그 둘은
// 셸 안에서만 살아 있다.
//
// ## 탭은 답이 나올 때까지 들고 있는다 (#2584 리뷰 M-1)
//
// 첫 판은 탭을 받자마자 「맡았다」고 적고 비동기로 판정했다. 그래서 목록 조회가
// 실패하면 그 자리에서 「불러오지 못해 열지 못했습니다」라는 상자를 세웠고, 목록은
// 목록대로 자기 오류 상자(「채널을 불러오지 못했습니다」·다시 시도)를 세웠다 — 한
// 사실에 상자 둘, 명사 둘. 더 나쁜 것은 「다시 시도」가 성공해도 탭은 이미 소진돼
// 착지가 다시 오지 않았다는 것이다.
//
// 이제 탭은 **답이 나올 때까지** 대기한다. #1209 의 `awaitingJump` 와 같은 모양이다:
//
//   목록에 그 방이 있다            → 착지한다.
//   목록 조회가 실패했다            → 아무 상자도 더 세우지 않는다. 실패는 목록의
//                                    `ErrorState` 가 말하고, 그 「다시 시도」가
//                                    성공하는 순간 이 탭이 착지한다.
//   목록이 탭 **뒤에** 읽혔는데 없다 → 「없어졌거나 볼 권한이 없습니다」.
//   목록이 탭보다 **앞에** 읽혔다    → 캐시다. 방금 생긴 DM 일 수 있으므로 한 번 더
//                                    묻고, 그 답이 위의 셋 중 하나가 된다.
//
// 「뒤에 읽혔다」는 react-query 의 `dataUpdatedAt` 과 탭이 닿은 시각으로 잰다. 그래서
// 「한 번 더 묻는다」는 규칙이 따로 들고 있는 상태 없이 성립한다.
//
// ## 대기 탭을 버리는 때
//
//   - 새 탭이 온다 — 새 탭이 대체한다.
//   - 사람이 **다른 대화를 연다**, 또는 탭을 옮긴다 — 사람이 이미 다른 곳을 골랐다.
//     그 뒤에 목록이 돌아왔다고 끌어가면, 사람이 방금 한 선택을 알림이 덮는다.
//
// 반대로 사람이 목록에서 기다리기만 하면 탭은 남는다. 진짜 오프라인에서는 쿼리가
// 멈춰 있고(`isPending`), 연결이 돌아와 첫 답이 오면 그때 착지한다.
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

/** 셸이 지금 서 있는 자리. 대기 탭이 「사람이 다른 곳을 골랐다」를 알아보는 데 쓴다. */
export interface NotificationTapNav {
  tab: Tab;
  conversation: OpenConversation | null;
}

interface PendingTap {
  token: number;
  target: NotificationTarget;
  /** 탭이 셸에 닿은 시각. 이 뒤에 읽힌 목록만 「없다」를 말할 자격이 있다. */
  arrivedAtMs: number;
  /** 탭이 닿았을 때의 자리. 사람이 여기서 다른 곳으로 옮기면 대기를 접는다. */
  nav: NotificationTapNav;
  /** 목록 실패를 이 탭에 대해 이미 알렸는가. 한 탭에 한 번만 말한다. */
  failureSaid: boolean;
}

export function useNotificationTapRouting(
  dispatch: (action: NavAction) => void,
  nav: NotificationTapNav,
): NotificationTapRouting {
  const {member, workspaceId} = useSession();
  const pushArrival = usePushArrival();
  const channels = useChannels(workspaceId);
  const roster = useDirectory(workspaceId);
  const invalidateApprovals = useInvalidateApprovals();
  const [notice, setNotice] = useState<string | null>(null);

  // 판정이 끝나는 순간의 명부로 제목을 짓는다. 탭이 닿을 때의 것을 붙들면, 기다리는
  // 사이에 도착한 명부가 헤더에 반영되지 않는다.
  const directoryRef = useRef(roster.directory);
  directoryRef.current = roster.directory;

  /** 마지막으로 **받은** 탭의 토큰. 같은 탭을 두 번 받지 않는다. */
  const seenTokenRef = useRef<number | null>(null);
  /** 답을 기다리는 탭. 하나뿐이다 — 새 탭이 오면 대체된다. */
  const pendingRef = useRef<PendingTap | null>(null);

  const fail = useCallback(
    (sentence: string) => {
      setNotice(sentence);
      dispatch({type: 'selectTab', tab: 'home'});
      // 이 문장은 사람이 누른 곳과 다른 화면에 선다. 화면을 보지 않는 사람에게는
      // 알림을 눌렀는데 아무 일도 없었던 것과 같으므로 소리로도 말한다.
      AccessibilityInfo.announceForAccessibility(sentence);
    },
    [dispatch],
  );

  const firstReadIn = !channels.isPending && !roster.isPending;
  const channelList = channels.data;
  const listFailed = channels.isError;
  const listFetching = channels.isFetching;
  const listReadAtMs = channels.dataUpdatedAt;
  const refetchChannels = channels.refetch;
  const navTab = nav.tab;
  const navConversation = nav.conversation;

  useEffect(() => {
    // ---- 받기 -------------------------------------------------------------
    if (pushArrival !== null && seenTokenRef.current !== pushArrival.token) {
      seenTokenRef.current = pushArrival.token;
      const {token, arrival} = pushArrival;
      if (arrival.kind === 'unavailable') {
        pendingRef.current = null;
        fail(unavailableCopy(arrival.reason));
        return;
      }
      // 앞선 탭의 영수증은 이 탭에 대한 말이 아니다.
      setNotice(null);
      pendingRef.current = {
        token,
        target: arrival.target,
        arrivedAtMs: Date.now(),
        nav: {tab: navTab, conversation: navConversation},
        failureSaid: false,
      };
    }

    const pending = pendingRef.current;
    if (pending === null) return;

    // ---- 사람이 다른 곳을 골랐다 --------------------------------------------
    const movedTab = navTab !== pending.nav.tab;
    const openedAnother =
      navConversation !== null && navConversation !== pending.nav.conversation;
    if (movedTab || openedAnother) {
      pendingRef.current = null;
      return;
    }

    // 첫 답이 아직이다(또는 오프라인이라 쿼리가 멈춰 있다). 오면 다시 돈다.
    if (!firstReadIn) return;

    const {target} = pending;
    const channel = openableChannel(channelList, target.channelId);
    if (channel !== null) {
      pendingRef.current = null;
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
            token: pending.token,
          },
        },
      });
      return;
    }

    if (listFailed) {
      // 한 사실은 한 상자다. 실패는 목록의 `ErrorState` 가 말하고 그 「다시
      // 시도」가 이 탭을 착지시킨다 — 여기서는 그 상자가 **보이고 들리게** 할 뿐이다.
      // 탭은 들고 있는다.
      if (!pending.failureSaid) {
        pending.failureSaid = true;
        dispatch({type: 'selectTab', tab: 'home'});
        // 방금의 자리 옮김은 사람의 선택이 아니다. 그것을 기준점으로 삼는다.
        pending.nav = {tab: 'home', conversation: null};
        AccessibilityInfo.announceForAccessibility(CHANNEL_LIST_FAILED);
      }
      return;
    }

    // 묻는 중이다. 그 답이 판정한다.
    if (listFetching) return;

    if (listReadAtMs >= pending.arrivedAtMs) {
      // 탭 뒤에 읽힌 목록에 그 방이 없다. 서버의 목록은 멤버십으로 걸러져 오므로
      // (`openableChannel` 머리말) 사라졌거나 이 사람이 거기서 나왔다는 뜻이다.
      pendingRef.current = null;
      fail(NOTIFICATION_TAP_COPY.channelGone);
      return;
    }

    // 목록은 탭보다 앞의 캐시다. 방금 생긴 DM 일 수 있으니 한 번 더 묻는다 — 그
    // 답이 오면(`dataUpdatedAt` 이 오르거나 실패하거나) 이 효과가 다시 돈다.
    void refetchChannels();
  }, [
    pushArrival,
    navTab,
    navConversation,
    firstReadIn,
    channelList,
    listFailed,
    listFetching,
    listReadAtMs,
    refetchChannels,
    fail,
    invalidateApprovals,
    dispatch,
    member.id,
  ]);

  const dismissNotice = useCallback(() => setNotice(null), []);
  return {notice, dismissNotice};
}

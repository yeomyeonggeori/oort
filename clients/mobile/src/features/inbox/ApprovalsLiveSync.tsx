import {agentSubscriptionPairs} from '@momo/core/features/agents/agentRail';
import {useEffect, useMemo} from 'react';
import {useRealtime} from '../../realtime/RealtimeProvider';
import {useSession} from '../../session/useSession';
import {usePendingApprovalLedgerKeeper} from '../conversation/usePendingApprovals';
import {useChannels, useDirectory} from '../workspace/queries';
import {useInvalidateApprovals} from './useInbox';

// =============================================================================
// 새 승인 카드가 올라오면 승인 원장이 **바로** 다시 읽힌다 (#5125, 웹 `ApprovalsLiveSync` #3738 과 같은 규칙).
//
// Renders nothing. 홈 「작업 중」 카드·에이전트 탭·대화 화면은 승인 원장 하나를 읽고(`usePendingApprovals.ts`), 그 원장이 폰에서는
// 레일의 `run_status` 변화·알림 탭·결정 뒤·인박스 열기로만 다시 읽혔다. 그런데 서버는 승인에 걸린 run 을 레일 프레임으로 알리지 않아서
// (중간 프레임은 늘 `running`) 승인이 생긴 순간에는 위 길이 하나도 울리지 않았고, 화면이 바뀌는 시각이 우연이었다.
//
// 승인 카드는 채널의 `approval_request` 메시지다. 이 신호는 **모든 에이전트 종류**에게 있다: 호스티드 에이전트만 원장 행
// (`agent.run.event`, migration 128)을 받고, 관리형·Agent Port 승인에는 그 프레임이 없다. 카드 메시지는 카드가 서는 모든 경우에 온다.
// 그 메시지가 오면(새 카드든 결정·만료로 status 가 바뀐 편집이든) 원장을 한 번 무효화한다. 같은 신호가 몰려도(재접속 되쏘기) 250ms 로
// 합쳐 한 번만 묻는다.
//
// ## 새 구독이 없다
//
// 에이전트 레일(`AgentWorkingRail`)이 이미 에이전트가 있는 채널마다 채널 구독을 갖고 있다(`subscribeRunEvents`, 진행 읽기를 깨운다).
// 같은 refcount 라서 여기서 핸들러를 더 달아도 소켓의 구독 수는 늘지 않는다. 대상도 **같은 쌍 목록**(`agentSubscriptionPairs`,
// 32쌍 상한)에서 뽑는다: 승인은 에이전트가 올리므로 에이전트가 없는 채널에는 카드가 서지 않는다. 상한 밖의 에이전트는 프레임이 오지 않고
// 원장의 30초 폴링이 잡는다(`PENDING_APPROVALS_POLL_MS`).
//
// ## 소켓을 따라간다
//
// `subscriptionsWanted` 는 백그라운드 정책의 답이다(`AgentWorkingRail` 과 같은 이유): 소켓을 내린 동안 구독을 붙들고 있으면 돌아올
// 때 한꺼번에 다시 붙는다. 돌아와 다시 붙는 구독의 `onSubscribed` 가 한 번 더 원장을 다시 읽는다 — 끊긴 동안 놓친 카드를 고친다.
// =============================================================================

const DEBOUNCE_MS = 250;

export function ApprovalsLiveSync(): null {
  const {workspaceId} = useSession();
  const {rail, subscriptionsWanted} = useRealtime();
  const channelsQuery = useChannels(workspaceId);
  const directoryQuery = useDirectory(workspaceId);
  const invalidateApprovals = useInvalidateApprovals();
  // 원장을 앞으로 올 때·30초마다 다시 읽는 일도 여기서 한 번만 건다(`usePendingApprovalLedgerKeeper`). 프레임 구독의 켜는 조건도 같은 곳에서 온다.
  const provided = usePendingApprovalLedgerKeeper();

  const {channels, dms} = channelsQuery.groups;
  const members = directoryQuery.directory.members;

  // 구독 이펙트는 배열이 아니라 **키**에 의존한다(`AgentWorkingRail` 과 같은 이유): 명부를 다시 읽을 때마다 같은 멤버십의 새 배열이 만들어지고,
  // 그때마다 구독을 걷었다 다시 거는 것은 그 사이의 프레임을 버리는 일이다. 접은 id 의 중복 없는 정렬 목록이라 키가 곧 목록이다.
  const channelIdsKey = useMemo(
    () =>
      [
        ...new Set(
          agentSubscriptionPairs([...channels, ...dms], members).map(pair =>
            pair.channelId.toLowerCase(),
          ),
        ),
      ]
        .sort()
        .join(','),
    [channels, dms, members],
  );

  useEffect(() => {
    if (!provided || !rail || !subscriptionsWanted || channelIdsKey === '') {
      return;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const refresh = () => {
      if (timer !== null) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        timer = null;
        invalidateApprovals();
      }, DEBOUNCE_MS);
    };
    const stops = channelIdsKey.split(',').map(channelId =>
      rail.subscribeChannel(workspaceId, channelId, {
        // 재접속 때 놓친 프레임이 있을 수 있다: 한 번 다시 읽는다.
        onSubscribed: refresh,
        onMessage: event => {
          if (event.payload.type === 'approval_request') {
            refresh();
          }
        },
      }),
    );
    return () => {
      for (const stop of stops) {
        stop();
      }
      if (timer !== null) {
        clearTimeout(timer);
      }
    };
  }, [provided, rail, subscriptionsWanted, channelIdsKey, workspaceId, invalidateApprovals]);

  return null;
}

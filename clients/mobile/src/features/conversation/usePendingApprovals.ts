import {fetchApprovals} from '@momo/core/lib/api';
import {isSurfaceProvided} from '@momo/core/features/capabilities/serverSurfaces';
import {useQuery} from '@tanstack/react-query';
import {useMemo} from 'react';
import {useSession} from '../../session/useSession';
import {approvalGates, type ApprovalGate} from './approvalGate';

// =============================================================================
// 이 대화의 대기 승인
// =============================================================================
//
// `approvalGate.ts` 가 「왜 원장을 봐야 하는가」를 든다. 이 파일은 그것을 어떻게
// 가져오는가만 정한다.
//
// ## 인박스와 **같은 캐시**를 쓴다
//
// `queryKey` 가 `['approvals', workspaceId, 'pending']` 로 인박스의
// `useNeedsAction` 과 같다(`features/inbox/useInbox.ts`). 같은 키를 쓰면 React
// Query 가 하나의 항목을 공유하므로, 인박스에서 결정하고 대화로 돌아오면 그
// 카드의 컨트롤이 **이미** 사라져 있다. 키를 따로 팠다면 두 화면이 같은 사실에
// 대해 서로 다른 시각을 갖고, 그 어긋남은 「이미 결정된 것을 또 누를 수 있다」로
// 나타난다.
//
// 무효화도 인박스가 쓰는 `useInvalidateApprovals` 를 그대로 쓴다 — 그 훅이 이
// 키를 무효화한다.
//
// ## 서버가 안 실었으면 아예 안 부른다
//
// `serverSurfaces` 표가 정본이다. 인박스는 그 표로 탭 자체를 감추고, 여기서는
// 쿼리를 끈다 — 없는 경로를 반복해서 두드리는 대신, 카드가 예전처럼 「데스크톱에서
// 하세요」라고 말한다. 그 표의 한 줄이 바뀌는 날 이 화면은 고칠 것이 없다.
// =============================================================================

/** 인박스와 공유하는 캐시 항목. 키가 갈라지면 두 화면이 다른 사실을 본다. */
export function pendingApprovalsKey(workspaceId: string): readonly unknown[] {
  return ['approvals', workspaceId, 'pending'];
}

export interface PendingApprovals {
  /** 이 채널의 대기 승인, `approvalId` 로 찾을 수 있게. */
  gates: ReadonlyMap<string, ApprovalGate>;
  /** 서버가 승인 경로를 실었는가. 안 실었으면 카드는 예전 문장을 유지한다. */
  provided: boolean;
}

const EMPTY: ReadonlyMap<string, ApprovalGate> = new Map();

export function usePendingApprovals(channelId: string): PendingApprovals {
  const {workspaceId} = useSession();
  const provided = isSurfaceProvided('approvals');
  const query = useQuery({
    queryKey: pendingApprovalsKey(workspaceId),
    queryFn: () => fetchApprovals(workspaceId, 'pending'),
    enabled: provided && workspaceId !== '',
  });

  const gates = useMemo(
    () =>
      query.data === undefined
        ? EMPTY
        : approvalGates(query.data, channelId),
    [query.data, channelId],
  );

  return {gates, provided};
}

import {fetchApprovals} from '@momo/core/lib/api';
import {
  isSurfaceProvided,
  serverSaysAbsent,
} from '@momo/core/features/capabilities/serverSurfaces';
import {useQuery} from '@tanstack/react-query';
import {useMemo} from 'react';
import {useSession} from '../../session/useSession';
import type {ApprovalWait} from '@momo/core/features/agents/workingSignal';
import {
  approvalGates,
  approvalWaits,
  workspaceApprovalWaits,
  type ApprovalGate,
} from './approvalGate';

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
//
// ## 이 캐시가 제때 바뀌는 길 (#5125)
//
// 홈 「작업 중」 카드·에이전트 탭·대화 화면은 모두 이 원장 하나를 읽는다. 폰에는 원장을 갱신하는 길이 레일의
// `run_status` 변화(서버는 승인에 걸린 run 을 그 프레임으로 알리지 않는다)·알림 탭·결정 뒤·인박스 열기뿐이어서,
// 승인이 생기거나 결정된 뒤 화면이 바뀌는 시각이 우연에 묶여 있었다. 길은 셋이다.
//
//   1. 승인 카드 프레임 — `inbox/ApprovalsLiveSync`. 1차이고 가장 빠르다(웹의 같은 이름과 같은 규칙).
//   2. 앱이 앞으로 올 때 — `refetchOnWindowFocus`. 전역 기본은 꺼 있다(배너 하나로 focus 가 흔들린다, `queryClient.ts`).
//      이 쿼리만 켜는 것은 `staleTime` 이 막아 주기 때문이다: 마지막으로 읽은 지 30초 안이면 배너 왕복은 다시 읽지 않는다.
//   3. 앞에 있는 동안 30초마다 — 그물이다. 프레임이 없는 승인(레일이 듣는 32쌍 밖의 에이전트)과 놓친 프레임을 잡는다.
//      뒤로 가면 멈춘다: `refetchIntervalInBackground` 기본값이 꺼져 있고 `focusManager` 가 `AppState` 에 이어져 있다(`App.tsx`).
//
// 2·3 은 **읽는 쪽 훅이 아니라 셸에 한 번만** 건다(`usePendingApprovalLedgerKeeper`, `ApprovalsLiveSync` 가 부른다). react-query 는
// 관측자마다 자기 타이머를 가지므로 읽는 훅마다 주기를 달면 열린 화면(홈·에이전트 탭·대화) 수만큼 같은 요청이 는다. 읽는 쪽은 캐시만 읽는다.
// =============================================================================

/**
 * 대기 승인 원장을 다시 읽는 주기. 웹 `PENDING_APPROVALS_POLL_MS` 와 같은 숫자·같은 뜻이다: 프레임이 1차이고 이것은 그물이다.
 * 어느 쪽이든 이 주기보다 오래 모르는 일은 없다(앱이 앞에 있는 동안).
 */
export const PENDING_APPROVALS_POLL_MS = 30_000;

/** 인박스와 공유하는 캐시 항목. 키가 갈라지면 두 화면이 다른 사실을 본다. */
export function pendingApprovalsKey(workspaceId: string): readonly unknown[] {
  return ['approvals', workspaceId, 'pending'];
}

export interface PendingApprovals {
  /** 이 채널의 대기 승인, `approvalId` 로 찾을 수 있게. */
  gates: ReadonlyMap<string, ApprovalGate>;
  /**
   * 이 채널에서 사람을 기다리는 승인(`applyApprovalWaits` 의 재료, #5066). 자리표시와 레일이 「승인 필요」 중인 에이전트를
   * 「작업 중」·「답하는 중」이라고 말하지 않게 하는 근거다.
   */
  waits: readonly ApprovalWait[];
  /** 서버가 승인 경로를 실었는가. 안 실었으면 카드는 예전 문장을 유지한다. */
  provided: boolean;
}

const EMPTY: ReadonlyMap<string, ApprovalGate> = new Map();
const NO_WAITS: readonly ApprovalWait[] = [];

/**
 * 대기 승인 원장 쿼리 **한 벌**. 읽는 훅과 지키는 훅이 같은 이 옵션을 펼쳐 쓴다 — 키·함수·켜는 조건이 갈라지면 서로 다른 캐시 항목을
 * 읽어 대화 화면과 홈이 서로 다른 사실을 본다.
 */
function pendingApprovalsQuery(workspaceId: string, provided: boolean) {
  return {
    queryKey: pendingApprovalsKey(workspaceId),
    queryFn: () => fetchApprovals(workspaceId, 'pending'),
    enabled: provided && workspaceId !== '',
  };
}

/** 이 파일의 읽는 훅 둘이 **같은** 쿼리를 읽는다. 다시 읽는 주기는 여기 없다(위 「이 캐시가 제때 바뀌는 길」). */
function usePendingApprovalLedger() {
  const {workspaceId} = useSession();
  const provided = isSurfaceProvided('approvals');
  const query = useQuery(pendingApprovalsQuery(workspaceId, provided));
  return {approvals: query.data, provided};
}

/**
 * 원장을 제때 바꾸는 쪽 — **셸에 한 번만** 건다(`ApprovalsLiveSync`). 같은 캐시 항목의 관측자 하나가 앞으로 올 때와 앞에 있는 동안
 * 30초마다 다시 읽는 일을 맡는다. 돌려주는 값은 서버가 승인 경로를 실었는가(`serverSurfaces` 표)이고, 프레임 구독을 거는 조건이 쿼리를
 * 켜는 조건과 **같은 한 곳**에서 나온다 — 쿼리가 꺼 있는데 프레임 구독만 서 있으면 아무도 읽지 않는 구독이다.
 *
 * 서버가 이 경로를 모른다고 답하면(404/405/501, `absent`) 더는 두드리지 않는다 — 같은 404 를 30초마다 받을 이유가 없다. 그 밖의 오류는
 * 직전 답을 둔 채 다음 주기에 다시 읽는다.
 */
export function usePendingApprovalLedgerKeeper(): boolean {
  const {workspaceId} = useSession();
  const provided = isSurfaceProvided('approvals');
  useQuery({
    ...pendingApprovalsQuery(workspaceId, provided),
    refetchOnWindowFocus: true,
    refetchInterval: current =>
      serverSaysAbsent(current.state.error) ? false : PENDING_APPROVALS_POLL_MS,
  });
  return provided;
}

export function usePendingApprovals(channelId: string): PendingApprovals {
  const {approvals, provided} = usePendingApprovalLedger();

  const gates = useMemo(
    () =>
      approvals === undefined ? EMPTY : approvalGates(approvals, channelId),
    [approvals, channelId],
  );

  const waits = useMemo(
    () => (approvals === undefined ? NO_WAITS : approvalWaits(approvals, channelId)),
    [approvals, channelId],
  );

  return {gates, waits, provided};
}

/**
 * 워크스페이스 전체에서 사람을 기다리는 승인 (홈 「작업 중」 카드·에이전트 탭의 덮어쓰기 재료, #5085).
 *
 * 대화 화면의 `usePendingApprovals(channelId).waits` 와 **같은 캐시·같은 판정**이고 범위만 채널 하나에서 전체로 넓다. 원장을 아직 못
 * 읽었거나(로딩·서버가 승인 경로를 안 실음·실패) 대기가 없으면 빈 목록이라 덮어쓰기는 아무것도 바꾸지 않는다 — 모르면 기다림으로
 * 세우지 않는다.
 */
export function useWorkspaceApprovalWaits(): readonly ApprovalWait[] {
  const {approvals} = usePendingApprovalLedger();
  return useMemo(
    () => (approvals === undefined ? NO_WAITS : workspaceApprovalWaits(approvals)),
    [approvals],
  );
}

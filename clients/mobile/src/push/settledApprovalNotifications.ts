import type {Approval} from '@momo/core/lib/api';
import {hashKey, useQueryClient} from '@tanstack/react-query';
import {useEffect} from 'react';

import {pendingApprovalsKey} from '../features/conversation/usePendingApprovals';
import {dismissApprovalNotifications} from './approvalNotifications';

// =============================================================================
// 다른 곳에서 결정된 승인의 알림을 걷는다 (#3926).
//
// 「실시간으로 다른 곳의 결정을 받음」이 이 파일이다. 앱 안 결정과 알림 버튼은 결정을
// 보낸 그 자리에서 알림을 걷는다(`approvalNotifications.ts`). 여기는 **남이 한 결정**이다:
// 데스크탑이나 다른 폰이 승인했거나, 기한이 지났거나, 취소됐다.
//
// ## 신호원은 새 프레임이 아니라 이미 있는 원장이다
//
// 폰은 `approval.decided` 프레임을 읽지 않는다. 서버가 결정 때 카드의 props를
// 고치고도 방송하지 않기 때문이다(웹 `settledApprovals.ts` 머리말). 대신 신호는 이미
// 있다. `AgentWorkingRail`이 에이전트 `run_status`가 바뀔 때마다(승인 대기에서
// 나갈 때 포함) 승인 원장을 무효화하고(`useInvalidateInboxLedgers`), 인박스 탭을 열
// 때와 네트워크가 돌아올 때도 원장을 다시 읽는다. 그 재조회가 끝난 **대기 승인 목록**에서
// 사라진 승인이 곧 결정(또는 만료)된 승인이다. 아래 훅은 그 쿼리 캐시를 보기만 한다 —
// 요청을 더하지 않고, 화면을 다시 그리지도 않는다.
//
// 결정뿐 아니라 만료·취소도 대기 목록을 떠난다. 어느 쪽이든 그 알림의 버튼은 죽은
// 것이라(눌러도 409) 같이 걷는 편이 맞다.
//
// ## 거는 조건
//
//   · 전과 후가 **둘 다 목록일 때만** 비교한다. 목록 없음에서 목록으로(첫 로드)는
//     기준선을 세울 뿐 아무것도 걷지 않는다 — 앱을 막 연 사람의 대기 승인 전부가
//     「결정된 것」으로 읽히면 안 된다. 요청 실패는 성공 이벤트가 아니라서 걸리지 않고,
//     마지막으로 본 목록이 그대로 기준선이다.
//   · 워크스페이스가 바뀌면 기준선을 새로 세운다. 다른 워크스페이스의 목록과 비교하면
//     전부 사라진 것처럼 보인다.
//
// ## 알려진 한계
//
//   · `fetchApprovals`는 한 페이지(기본 50건)만 읽는다. 대기가 그보다 많으면 페이지 밖으로
//     밀려난 승인이 결정된 것으로 오인될 수 있다. 그때 걷히는 것은 알림뿐이고 승인은
//     인박스에 그대로 있다.
//   · 앱이 앞으로 돌아온 것만으로는 원장을 다시 읽지 않는다(`query/queryClient.ts`가
//     `refetchOnWindowFocus: false`인 것은 알림 배너만으로 포커스가 흔들려서다). 소켓이 닫혀
//     있던 동안 다른 기기가 한 결정은 에이전트 프레임이 오거나 인박스를 열거나 연결이 돌아와
//     원장을 다시 읽을 때 걷힌다. 앱이 떠 있지 않을 때의 결정은 이 훅이 알 길이 없다(조용한
//     푸시나 네이티브 처리기의 몫이다, #3931).
// =============================================================================

/**
 * 전에는 대기였고 지금은 대기가 아닌 승인 id. 순수 함수라 훅 없이 못박을 수 있다.
 */
export function settledApprovalIds(
  before: ReadonlySet<string>,
  after: ReadonlySet<string>,
): string[] {
  return [...before].filter(id => !after.has(id));
}

/**
 * 대기 승인 목록의 id 집합(소문자). 목록이 아직 없으면 `null` — 「모른다」와 「비었다」를
 * 같은 값으로 접으면 첫 로드가 전부 결정된 것으로 읽힌다.
 *
 * 서버가 `status=pending` 목록에 다른 상태를 섞어 보내도 그것을 대기로 읽지 않는다
 * (`approvalGates`와 같은 규율).
 */
export function pendingApprovalIdSet(data: unknown): Set<string> | null {
  if (!Array.isArray(data)) return null;
  const ids = new Set<string>();
  for (const approval of data as readonly Approval[]) {
    if (approval.status === 'pending') ids.add(approval.id.toLowerCase());
  }
  return ids;
}

/**
 * 대기 승인 목록을 보다가 빠진 승인의 알림을 걷는다. `PushProvider`에서 한 번 부른다.
 */
export function useDismissSettledApprovalNotifications(
  workspaceId: string,
): void {
  const client = useQueryClient();

  useEffect(() => {
    if (workspaceId === '') return;
    const key = pendingApprovalsKey(workspaceId);
    const hash = hashKey(key);
    let known = pendingApprovalIdSet(client.getQueryData(key));

    return client.getQueryCache().subscribe(event => {
      if (event.type !== 'updated' || event.action.type !== 'success') return;
      if (event.query.queryHash !== hash) return;
      const current = pendingApprovalIdSet(event.query.state.data);
      if (current === null) return;
      if (known !== null) {
        for (const approvalId of settledApprovalIds(known, current)) {
          void dismissApprovalNotifications(approvalId);
        }
      }
      known = current;
    });
  }, [client, workspaceId]);
}

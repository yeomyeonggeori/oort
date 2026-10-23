import {useMemo, useRef} from 'react';
import {useQueries} from '@tanstack/react-query';
import {fetchMessages} from '@momo/core/lib/api';
import {
  HUMAN_MESSAGE_PAGE_LIMIT,
  pageHasHumanMessage,
} from '@momo/core/features/sidebar/ambientMessage';
import {
  goneUnreadSignature,
  goneUnreadVerdict,
  resolveGoneUnreadVerdicts,
  type GoneUnreadVerdict,
} from '@momo/core/features/sidebar/goneDm';
import {goneUnreadCandidates, type SidebarInput} from './rows';

// =============================================================================
// 나간 멤버 DM 의 안 읽음이 「사람이 읽을 것」인지 (#4252, 웹 `goneUnreadVerdicts.ts` 와 같은 규칙).
//
// 읽음 투영의 안 읽은 수는 기계 메시지(작업 상태·영수증)도 센다. 꺼 둔 에이전트의 DM 은 끈 직후 그런 줄이 안 읽음으로 쌓여
// 있어서 숫자만 보면 접히지 못한다. 서버 계약을 건드리지 않는 길: 안 읽음이 있는 후보(`goneUnreadCandidates`, 코어
// `goneUnreadProbeAfterSeq` 가 규칙)만 안 읽은 쪽을 **한 번** 읽어 `pageHasHumanMessage` 로 가른다. 쿼리 키가 안 읽음의 범위를
// 품어서 범위가 바뀔 때만 다시 읽는다(폴링 아님). 오는 중이면 접힌 채, 못 읽었으면 보인다(코어 `dmHiddenAsGone`). 이미 가른 DM 은
// 새 쪽이 오는 동안 이전 판정을 유지한다(코어 `resolveGoneUnreadVerdicts`).
// =============================================================================

export const GONE_UNREAD_RETRY_DELAY_MS = 300;

export function useGoneUnreadVerdicts(
  input: Pick<
    SidebarInput,
    | 'groups'
    | 'directory'
    | 'selfMemberId'
    | 'unreadByChannel'
    | 'openChannelId'
    | 'readPhase'
    | 'rosterReady'
  > & {workspaceId: string},
): ReadonlyMap<string, GoneUnreadVerdict> {
  const {
    workspaceId,
    groups,
    directory,
    selfMemberId,
    unreadByChannel,
    openChannelId,
    readPhase,
    rosterReady,
  } = input;
  const candidates = useMemo(
    () =>
      goneUnreadCandidates({
        groups,
        directory,
        selfMemberId,
        unreadByChannel,
        openChannelId,
        readPhase,
        rosterReady,
      }),
    [
      groups,
      directory,
      selfMemberId,
      unreadByChannel,
      openChannelId,
      readPhase,
      rosterReady,
    ],
  );

  // 결과를 「id:판정」 문자열로 접는다: 원시값이라 판정이 같으면 참조가 같다.
  const signature = useQueries({
    queries: candidates.map(candidate => ({
      queryKey: [
        'gone-unread',
        workspaceId,
        candidate.id,
        candidate.after,
        candidate.latest,
      ],
      queryFn: async () =>
        pageHasHumanMessage(
          (
            await fetchMessages(workspaceId, candidate.id, {
              after: candidate.after,
              limit: HUMAN_MESSAGE_PAGE_LIMIT,
            })
          ).messages,
        ),
      staleTime: Infinity,
      // 일시 실패 한 번은 다시 읽는다(실패는 곧 보임이라 깜빡임이 생긴다). 그동안은 오는 중으로 접힌 채다.
      retry: 1,
      retryDelay: GONE_UNREAD_RETRY_DELAY_MS,
    })),
    combine: results =>
      goneUnreadSignature(
        results.map((result, index) => ({
          id: candidates[index]?.id ?? '',
          verdict: goneUnreadVerdict(result),
        })),
      ),
  });

  const settled = useRef(new Map<string, 'human' | 'ambient'>());
  return useMemo(
    () => resolveGoneUnreadVerdicts(signature, settled.current),
    [signature],
  );
}

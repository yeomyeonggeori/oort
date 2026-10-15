import {fetchWorkJobs, type SharedWorkSession, type WorkJobsMode} from '@momo/core/lib/api';
import {
  initialWorkFilter,
  type WorkFilter,
} from '@momo/core/features/workbench/workJobs';
import {useInfiniteQuery} from '@tanstack/react-query';
import {useCallback, useMemo, useState} from 'react';
import {NON_SECRET_KEYS, nonSecretStore} from '../../../storage/kv';
import {BOARD_POLL_MS, teamBoardKey} from '../teamBoard/useTeamBoard';

// =============================================================================
// 폰 「작업」 화면의 읽기 (ADR-0202 D4, U1 #3842, 웹 `jobs/useWorkJobs`의 짝).
//
// 같은 보드 경로를 읽는다. 새 서버면 `include=runs,jobs`·`who`, 옛 서버면 `include=runs` 한 벌로
// 물러선다(판정은 코어 `fetchWorkJobs`가 한 번 하고 기억한다). 질의 열쇠는 팀 보드 열쇠 밑이라
// 보드의 실시간 신호·앱 복귀 재조회(`useTeamBoardRail`·`useBoardForegroundRefresh`)가 이 목록도
// 다시 읽게 한다. 가려진 층(`enabled=false`)은 읽지 않는다.
// =============================================================================

const PAGE = 50;

export function workJobsKey(workspaceId: string, filter: WorkFilter) {
  return [...teamBoardKey(workspaceId), 'jobs', filter] as const;
}

export function useWorkJobsList(
  workspaceId: string,
  filter: WorkFilter,
  enabled: boolean,
) {
  const query = useInfiniteQuery({
    queryKey: workJobsKey(workspaceId, filter),
    queryFn: ({pageParam}) =>
      fetchWorkJobs(workspaceId, {who: filter, cursor: pageParam, limit: PAGE}),
    initialPageParam: null as string | null,
    getNextPageParam: last => last.nextCursor,
    refetchInterval: enabled ? BOARD_POLL_MS : false,
    enabled: enabled && workspaceId !== '',
  });
  const items = useMemo<SharedWorkSession[]>(
    () => query.data?.pages.flatMap(page => page.sessions) ?? [],
    [query.data],
  );
  const mode: WorkJobsMode = query.data?.pages[0]?.mode ?? 'jobs';
  return {...query, items, mode};
}

function readRemembered(): string | null {
  try {
    return nonSecretStore().getString(NON_SECRET_KEYS.workFilter) ?? null;
  } catch {
    return null;
  }
}

/**
 * 필터 상태: 처음 값은 (하네스가 준 값) → 기기 기억 → 「내 것」(ADR-0202 D2). 바꾸면 기기에
 * 기억한다. 저장소가 실패해도 화면은 그대로 선다.
 */
export function useWorkFilter(initial?: WorkFilter) {
  const [filter, setFilter] = useState<WorkFilter>(
    () => initial ?? initialWorkFilter('', readRemembered()),
  );
  const choose = useCallback((next: WorkFilter) => {
    setFilter(next);
    try {
      nonSecretStore().set(NON_SECRET_KEYS.workFilter, next);
    } catch {
      // 기기 기억은 편의다.
    }
  }, []);
  return [filter, choose] as const;
}

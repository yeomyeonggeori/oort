import { useMemo } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import {
  fetchWorkJobs,
  type SharedWorkSession,
  type WorkJobsMode,
} from "@momo/core/lib/api";
import {
  WORK_FILTER_STORAGE_KEY,
  initialWorkFilter,
  type WorkFilter,
} from "@momo/core/features/workbench/workJobs";
import { teamBoardKey } from "@/features/workTab/teamBoard/useTeamBoard";

// =============================================================================
// 「작업」 화면의 읽기 (ADR-0202 D4, U1 #3842).
//
// 같은 보드 경로를 읽는다(새 목록 경로를 만들지 않는다). 새 서버면 `include=runs,jobs`·`who`,
// 옛 서버면 `include=runs` 한 벌로 물러선다(판정은 코어 `fetchWorkJobs`가 한 번 하고 기억한다).
// 질의 열쇠는 팀 보드 열쇠 밑에 둔다: 보드의 실시간 재읽기(`useTeamBoardRail`)가 무효화하는
// 열쇠가 그대로 이 목록도 다시 읽게 한다(새 프레임 이름 없음, D4).
// =============================================================================

const PAGE = 50;
/** diff·단계 숫자는 이벤트가 없다: 느린 타이머가 바닥이다(보드와 같은 값). */
const POLL_MS = 60_000;

export function workJobsKey(workspaceId: string, filter: WorkFilter) {
  return [...teamBoardKey(workspaceId), "jobs", filter] as const;
}

export function useWorkJobsList(workspaceId: string, filter: WorkFilter) {
  const query = useInfiniteQuery({
    queryKey: workJobsKey(workspaceId, filter),
    queryFn: ({ pageParam }) =>
      fetchWorkJobs(workspaceId, { who: filter, cursor: pageParam, limit: PAGE }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    refetchInterval: POLL_MS,
    refetchOnWindowFocus: true,
    enabled: workspaceId !== "",
  });
  const items = useMemo<SharedWorkSession[]>(
    () => query.data?.pages.flatMap((page) => page.sessions ?? []) ?? [],
    [query.data]
  );
  // 쪽마다 같은 판정이다(한 번 옛 서버면 이번 실행 동안 계속). 첫 쪽이 대표한다.
  const mode: WorkJobsMode = query.data?.pages[0]?.mode ?? "jobs";
  return { ...query, items, mode };
}

export function readRememberedWorkFilter(): string | null {
  try {
    return window.localStorage.getItem(WORK_FILTER_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function rememberWorkFilter(filter: WorkFilter): void {
  try {
    window.localStorage.setItem(WORK_FILTER_STORAGE_KEY, filter);
  } catch {
    // 기기 기억은 편의다(ADR-0202 D2). 저장소가 막혀도 화면은 그대로 선다.
  }
}

/** 처음 값은 주소 → 기기 기억 → 「내 것」(ADR-0202 D2). 주소가 정본이라 상태를 따로 두지 않는다. */
export function currentWorkFilter(search: string): WorkFilter {
  return initialWorkFilter(search, readRememberedWorkFilter());
}

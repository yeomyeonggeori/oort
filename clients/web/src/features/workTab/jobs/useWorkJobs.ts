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
import { railCoversItems, teamBoardKey } from "@/features/workTab/teamBoard/useTeamBoard";

// =============================================================================
// 「작업」 화면의 읽기 (ADR-0202 D4, U1 #3842).
//
// 같은 보드 경로를 읽는다(새 목록 경로를 만들지 않는다). 새 서버면 `include=runs,jobs`·`who`,
// 옛 서버면 `include=runs` 한 벌로 물러선다(판정은 코어 `fetchWorkJobs`가 한 번 하고 기억한다).
// 질의 열쇠는 팀 보드 열쇠 밑에 둔다: 보드의 실시간 재읽기(`useTeamBoardRail`)가 무효화하는
// 열쇠가 그대로 이 목록도 다시 읽게 한다(새 프레임 이름 없음, D4).
//
// 박자(#5640): 실시간이 붙어 있고 줄의 집 채널을 모두 듣고 있으면 60초 박자를 멈춘다 — 권한 요청·결정·상태 전환은 신호가
// 다시 읽게 한다. 끊겼거나(연결 중 포함) 듣는 채널 상한을 넘은 줄이 있으면 60초 박자다. 실시간이 있는 동안 신호가 없는 것
// (diff·단계 숫자, 60초를 넘긴 멘션 run, 권한 요청의 만료)과 화면을 떠난 동안의 일은 다시 들어올 때·창에 돌아올 때의
// 재읽기가 받친다(`staleTime: 0`).
// =============================================================================

const PAGE = 50;
/** 실시간이 끊겼을 때의 박자(보드와 같은 값). */
export const WORK_JOBS_POLL_MS = 60_000;

export function workJobsKey(workspaceId: string, filter: WorkFilter) {
  return [...teamBoardKey(workspaceId), "jobs", filter] as const;
}

/** 실시간이 붙어 있고 받은 줄의 집 채널을 모두 듣는가. 아니면 60초 박자다. */
export function workJobsPollMs(
  live: boolean,
  items: readonly SharedWorkSession[]
): number | false {
  return live && railCoversItems(items) ? false : WORK_JOBS_POLL_MS;
}

export function useWorkJobsList(workspaceId: string, filter: WorkFilter, live = false) {
  const query = useInfiniteQuery({
    queryKey: workJobsKey(workspaceId, filter),
    queryFn: ({ pageParam }) =>
      fetchWorkJobs(workspaceId, { who: filter, cursor: pageParam, limit: PAGE }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    refetchInterval: (q) =>
      workJobsPollMs(live, q.state.data?.pages.flatMap((page) => page.sessions ?? []) ?? []),
    refetchOnWindowFocus: true,
    // 「작업」을 떠난 동안(승인 카드·A 칸·채널로 간 동안) 온 결정·요청은 이 화면의 레일이 듣지 못하고, 실시간이 붙어 있으면
    // 박자도 없다. 앱 기본 신선 시간(30초)을 따르면 그 안에 돌아오거나 창에 돌아와도 다시 읽지 않아, 답한 줄이 「응답 필요」에
    // 남는다. 그래서 이 목록은 늘 낡은 것으로 본다: 다시 들어올 때와 창에 돌아올 때마다 한 번 읽는다.
    staleTime: 0,
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

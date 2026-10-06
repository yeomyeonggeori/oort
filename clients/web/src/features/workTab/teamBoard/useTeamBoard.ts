import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  ApiError,
  fetchSharedWorkSession,
  fetchSharedWorkSessions,
  type SharedWorkSession,
} from "@momo/core/lib/api";
import { homeChannelIds } from "@momo/core/features/workbench/teamBoard";
import { useSession } from "@/app/session";
import { useChannels } from "@/features/workspace/useWorkspace";

// =============================================================================
// 「팀 작업」 보드의 읽기 (#2863, ADR-0194 증보 읽기 경로).
//
// 이 파일이 부르는 읽기는 둘뿐이다: 공유 목록과 공유 단건. 작업 세션 원장
// (`/work-sessions`)은 여기서 읽지 않는다. 원장에는 공유하지 않은 세션이 있고, 보드는
// 그 존재조차 보이면 안 된다. 보는 사람의 채널 멤버십 거르기는 서버가 SQL에서 끝낸다.
// 클라이언트는 받은 줄을 그대로 쓴다(시험이 이 파일의 import를 잠근다).
//
// 실시간은 신호이고 읽기가 진실이다. `work.session.share_changed`는 세션 id와 전환
// 종류만 싣는다. 받으면 GET으로 다시 읽는다. 켜기·끄기·상태 변화가 아닌 diff 숫자의
// 갱신은 이벤트가 없어서, 포커스와 느린 타이머가 받친다.
// =============================================================================

const BOARD_PAGE = 50;
/** 겹쳐 오는 신호를 한 번의 읽기로 합치는 간격. */
export const REREAD_COALESCE_MS = 150;
/** diff 숫자는 이벤트가 없다: 느린 타이머가 바닥이다. */
const BOARD_POLL_MS = 60_000;
/** 듣는 채널 상한. 넘는 채널은 타이머와 포커스 재읽기가 받친다. */
export const MAX_TEAM_BOARD_CHANNELS = 24;

export function teamBoardKey(workspaceId: string) {
  return ["team-board", workspaceId] as const;
}

export function useTeamBoardList(workspaceId: string) {
  const query = useInfiniteQuery({
    queryKey: [...teamBoardKey(workspaceId), "list"],
    queryFn: ({ pageParam }) =>
      fetchSharedWorkSessions(workspaceId, {
        cursor: pageParam,
        limit: BOARD_PAGE,
        // 호스팅 에이전트의 작업 실행도 섞는다(AT-5 #3518). 모르는 서버는 무시한다.
        include: "runs",
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    refetchInterval: BOARD_POLL_MS,
    refetchOnWindowFocus: true,
    enabled: workspaceId !== "",
  });
  const items = useMemo<SharedWorkSession[]>(
    () => query.data?.pages.flatMap((page) => page.sessions ?? []) ?? [],
    [query.data]
  );
  return { ...query, items };
}

/**
 * 단건. 드로어가 목록에 아직 없는 줄(깊은 링크, 다음 쪽)을 열 때와, 열려 있는 줄이
 * 아직 보이는지 확인할 때 쓴다. 404는 하나다: 공유가 꺼졌거나 더는 보이지 않는다.
 */
export function useTeamBoardItem(
  workspaceId: string,
  sessionId: string | null,
  /** 단건 읽기는 세션 전용이다. 실행 줄은 목록의 줄을 그대로 쓰므로 읽지 않는다. */
  enabled = true
) {
  const query = useQuery({
    queryKey: [...teamBoardKey(workspaceId), "item", sessionId],
    queryFn: () => fetchSharedWorkSession(workspaceId, sessionId ?? ""),
    enabled: enabled && workspaceId !== "" && sessionId !== null,
    retry: (count, error) =>
      !(error instanceof ApiError && error.status === 404) && count < 2,
  });
  const gone =
    query.error instanceof ApiError && query.error.status === 404;
  return { ...query, gone };
}

/**
 * 공유 변화 신호를 듣고 보드를 다시 읽는다. 듣는 채널은 지금 보이는 줄의 집 채널과
 * 내가 속한 채널들이다(아직 줄이 없는 채널의 새 공유도 들어야 한다).
 */
export function useTeamBoardRail(
  workspaceId: string,
  items: readonly SharedWorkSession[]
) {
  const { realtime } = useSession();
  const queryClient = useQueryClient();
  const channels = useChannels(workspaceId);
  const memberChannelIds = useMemo(
    () => channels.groups.channels.map((c) => c.id),
    [channels.groups.channels]
  );
  const watchKey = useMemo(() => {
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const id of [...homeChannelIds(items), ...memberChannelIds]) {
      const key = id.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      ordered.push(id);
    }
    return ordered.slice(0, MAX_TEAM_BOARD_CHANNELS).join(",");
  }, [items, memberChannelIds]);

  // 채널마다 같은 신호가 겹쳐 오거나(재구독이 채널 수만큼 한꺼번에 끝난다) 한 전환이 여러
  // 프레임을 부른다. 한 번의 읽기로 합친다: 마지막 신호가 읽기를 시작시킨다.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reread = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      void queryClient.invalidateQueries({
        queryKey: teamBoardKey(workspaceId),
      });
    }, REREAD_COALESCE_MS);
  }, [queryClient, workspaceId]);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    []
  );

  useEffect(() => {
    if (!realtime || workspaceId === "") return;
    const ids = watchKey === "" ? [] : watchKey.split(",");
    const stops = ids.map((channelId) =>
      realtime.subscribeWorkSession(workspaceId, channelId, {
        // 신호만 받는다. 이 보드는 프레임 안의 어떤 값도 화면에 쓰지 않는다.
        onShareChanged: reread,
        // 호스팅 에이전트 작업 실행의 상태 전환도 같은 신호다(#3518).
        onRunUpdated: reread,
        // 에이전트 레인의 진행은 기존 work.session.* 프레임으로 온다. 같은 방식으로 다시 읽는다.
        onLifecycle: reread,
        onToolTransition: reread,
        onObserver: () => undefined,
        onAcpEvent: () => undefined,
        // 재연결·재구독: 놓친 것은 읽기로 고친다.
        onResync: reread,
      })
    );
    return () => {
      for (const stop of stops) stop();
    };
  }, [realtime, workspaceId, watchKey, reread]);
}

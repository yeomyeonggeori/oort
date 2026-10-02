import {
  ApiError,
  fetchSharedWorkSession,
  fetchSharedWorkSessions,
  type SharedWorkSession,
} from '@momo/core/lib/api';
import {homeChannelIds} from '@momo/core/features/workbench/teamBoard';
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {useCallback, useEffect, useMemo, useRef} from 'react';
import {useRealtime} from '../../../realtime/RealtimeProvider';
import {useChannels} from '../../workspace/queries';

// =============================================================================
// 「작업」 한 열 판의 읽기 (#2864, 웹 `useTeamBoard`의 폰 짝, ADR-0194 증보).
//
// 이 파일이 부르는 읽기는 둘뿐이다: 공유 목록과 공유 단건. 작업 원장(`/work-sessions`)
// 은 읽지 않는다. 원장에는 공유하지 않은 세션이 있고, 보드는 그 존재조차 보이면 안
// 된다. 보는 사람의 채널 멤버십 거르기는 서버가 SQL에서 끝낸다. 받은 줄을 그대로 쓴다
// (시험이 이 파일의 import를 잠근다).
//
// 실시간은 신호이고 읽기가 진실이다. `work.session.share_changed`는 세션 id와 전환
// 종류만 싣는다. 받으면 GET으로 다시 읽는다. diff 숫자의 갱신은 이벤트가 없어서 느린
// 타이머가 받친다. 화면이 가려진 동안(`active=false`)에는 읽지도 듣지도 않는다.
// =============================================================================

const BOARD_PAGE = 50;
/** 겹쳐 오는 신호를 한 번의 읽기로 합치는 간격. */
export const REREAD_COALESCE_MS = 150;
/** diff 숫자는 이벤트가 없다: 느린 타이머가 바닥이다. */
export const BOARD_POLL_MS = 60_000;
/** 듣는 채널 상한. 넘는 채널은 타이머와 당겨서 새로고침이 받친다. */
export const MAX_TEAM_BOARD_CHANNELS = 24;

export function teamBoardKey(workspaceId: string) {
  return ['team-board', workspaceId] as const;
}

export function useTeamBoardList(workspaceId: string, enabled: boolean) {
  const query = useInfiniteQuery({
    queryKey: [...teamBoardKey(workspaceId), 'list'],
    queryFn: ({pageParam}) =>
      fetchSharedWorkSessions(workspaceId, {
        cursor: pageParam,
        limit: BOARD_PAGE,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: last => last.nextCursor,
    refetchInterval: enabled ? BOARD_POLL_MS : false,
    enabled: enabled && workspaceId !== '',
  });
  const items = useMemo<SharedWorkSession[]>(
    () => query.data?.pages.flatMap(page => page.sessions) ?? [],
    [query.data],
  );
  return {...query, items};
}

/**
 * 단건. 시트가 열린 줄이 아직 보이는지 확인한다. 404는 하나다: 공유가 꺼졌거나 더는
 * 보이지 않는다.
 */
export function useTeamBoardItem(
  workspaceId: string,
  sessionId: string | null,
) {
  const query = useQuery({
    queryKey: [...teamBoardKey(workspaceId), 'item', sessionId],
    queryFn: () => fetchSharedWorkSession(workspaceId, sessionId ?? ''),
    enabled: workspaceId !== '' && sessionId !== null,
    retry: (count, error) =>
      !(error instanceof ApiError && error.status === 404) && count < 2,
  });
  const gone = query.error instanceof ApiError && query.error.status === 404;
  return {...query, gone};
}

/**
 * 공유 변화 신호를 듣고 보드를 다시 읽는다. 듣는 채널은 지금 보이는 줄의 집 채널과 내가
 * 속한 채널들이다(아직 줄이 없는 채널의 새 공유도 들어야 한다).
 */
export function useTeamBoardRail(
  workspaceId: string,
  items: readonly SharedWorkSession[],
  active: boolean,
) {
  const {rail, subscriptionsWanted} = useRealtime();
  const queryClient = useQueryClient();
  const channels = useChannels(workspaceId);
  const memberChannelIds = useMemo(
    () => channels.groups.channels.map(channel => channel.id),
    [channels.groups.channels],
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
    return ordered.slice(0, MAX_TEAM_BOARD_CHANNELS).join(',');
  }, [items, memberChannelIds]);

  // 채널마다 같은 신호가 겹쳐 오거나 재구독이 채널 수만큼 한꺼번에 끝난다. 한 번의
  // 읽기로 합친다: 마지막 신호가 읽기를 시작시킨다.
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
    [],
  );

  useEffect(() => {
    if (!active || !subscriptionsWanted || rail === null || workspaceId === '') {
      return;
    }
    const ids = watchKey === '' ? [] : watchKey.split(',');
    const stops = ids.map(channelId =>
      // 신호만 받는다. 이 보드는 프레임 안의 어떤 값도 화면에 쓰지 않는다.
      rail.subscribeWorkBoard(workspaceId, channelId, {onSignal: reread}),
    );
    return () => {
      for (const stop of stops) stop();
    };
  }, [active, rail, subscriptionsWanted, workspaceId, watchKey, reread]);
}

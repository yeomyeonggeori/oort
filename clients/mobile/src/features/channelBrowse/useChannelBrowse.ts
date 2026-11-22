import type {Channel, RosterMember} from '@momo/core/lib/api';
import {
  browseChannels,
  previewChannel,
  channelJoinFailure,
  joinChannel,
  type BrowseChannel,
  type ChannelBrowseFailure,
} from '@momo/core/features/channels/browse';
import {withChannelMemberAdded} from '@momo/core/features/channels/memberAdd';
import {upsertChannel} from '@momo/core/features/directory/model';
import {idKey} from '@momo/core/features/workspace/directory';
import {keepPreviousData, useInfiniteQuery, useQuery, useQueryClient} from '@tanstack/react-query';
import {useCallback, useEffect, useMemo, useRef, useState} from 'react';

import {workspaceKeys} from '../workspace/queries';

// =============================================================================
// 폰 채널 둘러보기의 읽기와 참여 (ADR-0224 화면 폰 줄 · D3 · D4, #5846).
//
// 서버 계약과 판정은 모두 코어(`features/channels/browse.ts`, 웹 #5842 와 같은 것)다. 이 파일은 react-query 배선뿐이다 —
// 웹 `useChannelBrowse.ts` 의 폰 짝이고, 캐시 키(`channels`·`roster`·`read-state`)는 웹과 같은 글자다(`workspaceKeys`).
// =============================================================================

/** 치는 동안 서버 `q` 를 쉬는 시간(웹 창과 같은 250ms). 입력 칸 값은 동기 상태 그대로이고, 이 값은 서버로 갈 글자만 늦춘다. */
export const CHANNEL_BROWSE_SETTLE_MS = 250;

/** 홈 이름 검색이 한 번 읽는 쪽의 크기(웹 ⌘K 와 같은 200). */
export const HOME_BROWSE_LIMIT = 200;

export const channelBrowseKeys = {
  preview: (workspaceId: string, channelId: string) =>
    ['channel-preview', workspaceId, channelId] as const,
  list: (workspaceId: string, q: string) => ['channel-browse', workspaceId, q] as const,
  home: (workspaceId: string) => ['channel-browse', workspaceId, 'home-search'] as const,
};

/** 값이 멈춘 뒤 `ms` 가 지나면 그 값을 돌려준다. 입력 칸이 아니라 서버로 가는 글자에만 쓴다. */
export function useSettledValue(value: string, ms: number = CHANNEL_BROWSE_SETTLE_MS): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    if (value === settled) return;
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, settled, ms]);
  return settled;
}

/**
 * 둘러보기 목록(쪽 나눔). 화면이 열려 있는 동안에만 산다(`gcTime: 0`, `staleTime: 0`) — 화면은 열 때마다 다시 읽는다:
 * 관리자가 방금 켠 채널이 다음에 열 때 보인다. 새 `q` 의 답을 기다리는 동안 앞 목록을 그대로 둔다(줄이 깜빡이지 않게).
 */
export function useChannelBrowseList(workspaceId: string, q: string) {
  return useInfiniteQuery({
    queryKey: channelBrowseKeys.list(workspaceId, q),
    queryFn: ({pageParam}) => browseChannels(workspaceId, {q, cursor: pageParam}),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: last => last.nextCursor,
    placeholderData: keepPreviousData,
    gcTime: 0,
    staleTime: 0,
    retry: false,
  });
}

/**
 * 홈 이름 검색의 「참여하지 않은 공개 채널」 묶음(웹 ⌘K 와 같은 결정). 거르기 칸이 열려 있는 동안 서버 목록 한 쪽을 **한 번** 읽고,
 * 거르기는 화면이 동기로 한다 — 친 글자는 쿼리 키에도 타이머에도 들어가지 않는다(`SidebarScreen` 머리의 IME 규칙).
 * 읽기가 실패하면(이 서버에 둘러보기가 없음 · 망) 묶음은 조용히 빠진다.
 */
export function useHomeBrowseCandidates(workspaceId: string, enabled: boolean) {
  return useQuery({
    queryKey: channelBrowseKeys.home(workspaceId),
    queryFn: () => browseChannels(workspaceId, {limit: HOME_BROWSE_LIMIT}),
    enabled,
    retry: false,
    gcTime: 0,
    staleTime: 0,
  });
}

/** 이름에 친 글자가 들어 있고, 내 채널 목록에 없는 줄만. 서버 차례 그대로. */
export function notJoinedMatches(
  rows: readonly BrowseChannel[],
  myChannelIds: ReadonlySet<string>,
  query: string,
): BrowseChannel[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return [];
  return rows.filter(
    row => !myChannelIds.has(idKey(row.id)) && row.name.toLowerCase().includes(needle),
  );
}

export interface JoinBrowsedChannel {
  /** 참여를 보내 놓고 답을 기다리는 채널 id. */
  pending: ReadonlySet<string>;
  /** 채널 id → 마지막 실패. 다시 누르면 지워진다. */
  failures: ReadonlyMap<string, ChannelBrowseFailure>;
  join: (channelId: string) => Promise<Channel | null>;
}

/**
 * 스스로 참여 한 번(웹 `useJoinBrowsedChannel` 의 폰 짝). 같은 채널을 두 번 눌러도 요청은 하나다 — 답을 기다리는 동안의 둘째
 * 누름은 렌더를 기다리지 않는 ref 에서 버린다.
 *
 * 성공하면 응답의 `channel` 을 채널 목록 캐시에 바로 세우고(홈에 그 줄이 선다), 명부의 내 `channelIds` 에 넣고(채널 머리의 멤버 수),
 * 읽음 투영을 다시 읽는다(서버가 읽음 위치를 채널 끝으로 옮겼다, D9). 그 뒤 `onJoined` — 셸이 그 대화로 데려간다. 화면이 그 사이
 * 걷혔으면(뒤로 · 알림 입구) 캐시만 반영하고 이동은 하지 않는다(`mounted`).
 */
export function useJoinBrowsedChannel(
  workspaceId: string,
  selfMemberId: string,
  onJoined: (channel: Channel) => void,
): JoinBrowsedChannel {
  const client = useQueryClient();
  const inFlight = useRef(new Set<string>());
  const mounted = useRef(true);
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const [failures, setFailures] = useState<ReadonlyMap<string, ChannelBrowseFailure>>(
    () => new Map(),
  );
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const join = useCallback(
    async (channelId: string): Promise<Channel | null> => {
      if (inFlight.current.has(channelId)) return null;
      inFlight.current.add(channelId);
      setPending(current => new Set(current).add(channelId));
      setFailures(current => {
        if (!current.has(channelId)) return current;
        const next = new Map(current);
        next.delete(channelId);
        return next;
      });
      try {
        const {channel} = await joinChannel(workspaceId, channelId);
        client.setQueryData<Channel[]>(workspaceKeys.channels(workspaceId), current =>
          current ? upsertChannel(current, channel) : [channel],
        );
        void client.invalidateQueries({queryKey: workspaceKeys.channels(workspaceId)});
        client.setQueryData<RosterMember[]>(workspaceKeys.roster(workspaceId), current =>
          current ? withChannelMemberAdded(current, channel.id, selfMemberId) : current,
        );
        void client.invalidateQueries({queryKey: workspaceKeys.roster(workspaceId)});
        void client.invalidateQueries({queryKey: workspaceKeys.readState(workspaceId)});
        if (mounted.current) onJoined(channel);
        return channel;
      } catch (error) {
        if (mounted.current) {
          setFailures(current => new Map(current).set(channelId, channelJoinFailure(error)));
        }
        return null;
      } finally {
        inFlight.current.delete(channelId);
        if (mounted.current) {
          setPending(current => {
            const next = new Set(current);
            next.delete(channelId);
            return next;
          });
        }
      }
    },
    [client, workspaceId, selfMemberId, onJoined],
  );

  return useMemo(() => ({pending, failures, join}), [pending, failures, join]);
}

/**
 * 참여 전 미리 보기(ADR-0224 D5, #5847). **열 때 한 번** 읽고, 다시 읽는 길은 당겨서 새로 고침 · 「다시 시도」뿐이다 — 다시 연결됨 ·
 * 앱으로 돌아옴 · 타이머로 저절로 읽지 않는다. 실시간 구독도 읽음 위치도 건드리지 않는다(서버가 쓰지 않는 읽기다).
 * 화면이 걷히면 캐시도 걷힌다(`gcTime: 0`). 불러오는 중 표시는 `isPending` 으로 정한다 — 당겨서 새로 고치는 동안 본문이 바뀌지 않게.
 */
export function useChannelPreviewQuery(workspaceId: string, channelId: string) {
  return useQuery({
    queryKey: channelBrowseKeys.preview(workspaceId, channelId),
    queryFn: () => previewChannel(workspaceId, channelId),
    retry: false,
    gcTime: 0,
    staleTime: Infinity,
    refetchOnMount: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
  });
}

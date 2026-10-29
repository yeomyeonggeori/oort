import {
  fetchReadStates,
  fetchRoster,
  listChannels,
  type Channel,
  type ReadState,
} from '@momo/core/lib/api';
import {fetchWorkspace} from '@momo/core/features/settings/api';
import {AVAILABILITY_REFRESH_MS} from '@momo/core/features/presence/model';
import type {RoleLabels} from '@momo/core/features/directory/model';
import {
  idKey,
  makeDirectory,
  type Directory,
} from '@momo/core/features/workspace/directory';
import {useQuery, useQueryClient, type QueryClient} from '@tanstack/react-query';
import {useCallback, useMemo} from 'react';

// =============================================================================
// The three reads every signed-in surface in this batch shares.
//
// ADR-0137 D3 puts react-query hooks in the HOST, not the core — "react hooks are
// deliberately NOT here", says the core's README — so this file is the RN sibling
// of `clients/web/src/features/workspace/useWorkspace.ts`. It is host wiring by
// that decision, and the wiring is all it is: **the query keys are the web
// client's, character for character**, and every derivation below is a call into
// `@momo/core/features/workspace/directory`.
//
// Keeping the keys identical is not tidiness. `["read-state", ws]` is invalidated
// from three places (a read cursor advancing, a mention being marked, a manual
// refresh), and a key that differs by one character between clients is a bug that
// only shows up as "the badge did not clear on the phone".
//
// ## What is NOT here, and why
//
// No sort. The server returns channels in its own order and this client keeps it.
// There is no `lastMessageAtMs` on `Channel` and no activity endpoint, so a
// "recent first" sidebar would have to be invented from `ReadState.latestSeq` —
// a per-channel counter that is not comparable ACROSS channels. Ordering rows by
// it would look like recency and be arbitrary. The honest list is the server's.
// =============================================================================

export const workspaceKeys = {
  roster: (workspaceId: string) => ['roster', workspaceId] as const,
  channels: (workspaceId: string) => ['channels', workspaceId] as const,
  readState: (workspaceId: string) => ['read-state', workspaceId] as const,
  identity: (workspaceId: string) =>
    ['settings', 'workspace', workspaceId] as const,
};

export function useRoleLabels(workspaceId: string): RoleLabels {
  const query = useQuery({
    queryKey: workspaceKeys.identity(workspaceId),
    queryFn: () => fetchWorkspace(workspaceId),
    retry: false,
  });
  return query.data?.roleLabels ?? {};
}

/**
 * 워크스페이스 이름·아바타 경로 (DS2-3 홈 머리). `useRoleLabels` 와 **같은 키, 같은
 * 조회**다 — 한 요청을 두 자리가 나눠 읽는다. 웹 레일이 같은 GET 을 같은 이유로 읽는다.
 */
export function useWorkspaceIdentity(workspaceId: string) {
  const query = useQuery({
    queryKey: workspaceKeys.identity(workspaceId),
    queryFn: () => fetchWorkspace(workspaceId),
    retry: false,
  });
  return {
    name: query.data?.name,
    avatarUrl: query.data?.avatarUrl,
    isPending: query.isPending,
    isError: query.isError,
    refetch: query.refetch,
  };
}

export function useDirectory(workspaceId: string) {
  const query = useQuery({
    queryKey: workspaceKeys.roster(workspaceId),
    queryFn: () => fetchRoster(workspaceId),
    // 접속 여부(`online`)는 서버가 명부를 읽을 때 전송에서 읽어 싣는 값이라 점은 마지막 명부 읽기만큼만
    // 신선하다(#4692, ADR-0160 ②). 보이는 동안만 이 주기로 다시 읽는다: `focusManager` 가 `AppState` 에
    // 이어져 있어(`query/queryClient.ts`) 앱이 active 가 아니면 멈춘다.
    refetchInterval: AVAILABILITY_REFRESH_MS,
  });
  const directory = useMemo<Directory>(
    () => makeDirectory(query.data ?? []),
    [query.data],
  );
  return {...query, directory};
}

export interface ChannelGroups {
  channels: Channel[];
  dms: Channel[];
}

export function useChannels(workspaceId: string) {
  const query = useQuery({
    queryKey: workspaceKeys.channels(workspaceId),
    queryFn: () => listChannels(workspaceId),
  });
  const groups = useMemo<ChannelGroups>(() => {
    // Archived channels are gone from the person's view, not from the server.
    // Same filter the web client applies, so the two sidebars list one set.
    const all = (query.data ?? []).filter(
      channel => channel.archivedAtMs === undefined,
    );
    return {
      channels: all.filter(channel => channel.kind !== 'dm'),
      dms: all.filter(channel => channel.kind === 'dm'),
    };
  }, [query.data]);
  return {...query, groups};
}

/**
 * 방금 연 DM 을 채널 캐시에 넣는다 (#4016).
 *
 * `openDirectMessage` 는 서버가 정한 채널을 돌려주지만, 채널 목록 캐시는 모른다. 아직 DM 이 없던
 * 에이전트를 처음 눌러 연 대화는 목록에 없어서 `ConversationScreen` 이 `channel === null` 로 서고,
 * 그러면 DM 머리의 상대 얼굴·「에이전트」 부제·자동 응답 안내가 전부 빠진다(3047 실기기: grok DM
 * 머리에 이름만). 응답을 캐시에 먼저 넣어 첫 그림부터 DM 으로 서게 하고, 서버 목록은 뒤따라
 * 다시 읽어 맞춘다.
 */
export function useRememberOpenedDm(
  workspaceId: string,
): (channel: Channel) => void {
  const client = useQueryClient();
  return useCallback(
    (channel: Channel) => {
      client.setQueryData<Channel[]>(
        workspaceKeys.channels(workspaceId),
        previous => {
          const rest = (previous ?? []).filter(
            known => idKey(known.id) !== idKey(channel.id),
          );
          return [...rest, channel];
        },
      );
      void client.invalidateQueries({
        queryKey: workspaceKeys.channels(workspaceId),
      });
    },
    [client, workspaceId],
  );
}

export function useReadStates(workspaceId: string) {
  const query = useQuery({
    queryKey: workspaceKeys.readState(workspaceId),
    queryFn: () => fetchReadStates(workspaceId),
    // Unread is SERVER truth (ADR-0109 / P7). This client never counts anything
    // itself, so the number is only as fresh as this poll — which is the correct
    // trade: a locally incremented badge that disagrees with the server is worse
    // than one that is thirty seconds old.
    refetchInterval: 30_000,
  });
  const byChannel = useMemo(
    () => new Map((query.data ?? []).map(state => [idKey(state.channelId), state])),
    [query.data],
  );
  return {...query, byChannel};
}

/**
 * 닫기·다시 열기를 쓴 기기는 새 상태를 읽음 투영 캐시 행에 바로 적는다(ADR-0177 D10: 다른 기기는 다음 투영에서 맞춘다).
 * `null` = 다시 열었다. 서버가 답한 **뒤에** 부른다(이 화면의 행 동작은 낙관 갱신이 없다).
 */
export function applyClosureToReadStates(
  client: QueryClient,
  workspaceId: string,
  channelId: string,
  closedAtSeq: number | null,
): void {
  client.setQueryData<ReadState[]>(workspaceKeys.readState(workspaceId), current => {
    if (!current) return current;
    const key = idKey(channelId);
    return current.map(row =>
      idKey(row.channelId) === key ? {...row, closedAtSeq} : row,
    );
  });
}

/**
 * Re-read the read-state projection after advancing a cursor.
 *
 * Memoised, and that is not a micro-optimisation: an unstable identity here
 * propagates into every `useCallback` that lists it as a dependency, and the
 * first time one of those is put in a `useEffect` dep array it becomes an
 * infinite loop rather than a wasted allocation.
 */
export function useInvalidateReadStates(workspaceId: string): () => void {
  const client = useQueryClient();
  return useCallback(() => {
    void client.invalidateQueries({queryKey: workspaceKeys.readState(workspaceId)});
  }, [client, workspaceId]);
}

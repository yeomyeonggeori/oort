import {
  fetchReadStates,
  fetchRoster,
  listChannels,
  type Channel,
} from '@momo/core/lib/api';
import {
  idKey,
  makeDirectory,
  type Directory,
} from '@momo/core/features/workspace/directory';
import {useQuery, useQueryClient} from '@tanstack/react-query';
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
};

export function useDirectory(workspaceId: string) {
  const query = useQuery({
    queryKey: workspaceKeys.roster(workspaceId),
    queryFn: () => fetchRoster(workspaceId),
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

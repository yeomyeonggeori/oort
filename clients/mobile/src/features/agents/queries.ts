import {
  fetchAgentAllowedModels,
  fetchAgentProfile,
  fetchWorkHosts,
  fetchWorkSessions,
  putAgentPause,
  type AgentProfile,
} from '@momo/core/lib/api';
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {useMemo} from 'react';
import {agentProfileRead, type AgentProfileRead} from '@momo/core/features/agents/agentOps';

// =============================================================================
// The reads and the one write behind 「에이전트」 (goal RN-A1).
//
// ADR-0137 D3 keeps react-query hooks in the HOST, so this is the RN sibling of
// `clients/web/src/features/agentHub/*` — and, exactly as
// `features/workspace/queries.ts` does, **the query keys are the web client's,
// character for character**. `["agent-profile", ws, agentId]` is what the web
// hub's pause mutation writes back into, and a key that differs by one character
// between clients is a bug that only ever shows up as "the phone still says it
// is asleep".
//
// ## Nothing here calls `fetch`
//
// Every request goes through `@momo/core/lib/api`, which owns the deadline, the
// token refresh, the wire decoding and the ApiError/NetworkError split the
// failure copy is written against. A `fetch` in this directory would be a second
// answer to all four.
//
// ## Why the profile is read per agent, and why that is not a design smell
//
// `GET …/roster` carries no pause state (measured on `server-rust`: the roster
// DTO has no `paused` field of any name), so "자고 있나" is a SECOND request per
// agent. There is no batch endpoint. Two things make that acceptable rather than
// merely tolerated: a workspace has a handful of agents and not a page of them,
// and the read is authorised per agent — an ordinary member is refused for one
// they do not own, which `agentProfileRead` turns into a sentence instead of a
// retry loop. A batched call would have to collapse those refusals into one.
// =============================================================================

export const agentKeys = {
  /** `AgentHubRoute.profileKey`, character for character. */
  profile: (workspaceId: string, agentMemberId: string) =>
    [
      'agent-profile',
      workspaceId.toLowerCase(),
      agentMemberId.toLowerCase(),
    ] as const,
  /** `features/routing/capability.ts`'s `useAllowedModelsQuery` key. */
  allowedModels: (workspaceId: string, agentMemberId: string) =>
    [
      'routing',
      'allowed-models',
      workspaceId.toLowerCase(),
      agentMemberId.toLowerCase(),
    ] as const,
  /** `features/work/useWorkSessions.ts` — unnormalised there, so unnormalised here. */
  workSessions: (workspaceId: string) => ['work-sessions', workspaceId] as const,
  workHosts: (workspaceId: string) => ['work-hosts', workspaceId] as const,
};

/**
 * One agent's stored profile, as a classified read.
 *
 * `retry: false` and no refetch-on-anything: a 403 here is a permission and not
 * a hiccup, and react-query's default retry would spend two more round trips
 * proving that the person is still not an admin.
 */
export function useAgentProfile(workspaceId: string, agentMemberId: string) {
  const query = useQuery({
    queryKey: agentKeys.profile(workspaceId, agentMemberId),
    queryFn: () => fetchAgentProfile(workspaceId, agentMemberId),
    retry: false,
  });
  const read = useMemo<AgentProfileRead>(
    () => agentProfileRead(query.data, query.isPending, query.error),
    [query.data, query.isPending, query.error],
  );
  return {...query, read};
}

/** The same read for a whole list, keyed by the lower-cased member id. */
export function useAgentProfiles(
  workspaceId: string,
  agentMemberIds: readonly string[],
): ReadonlyMap<string, AgentProfileRead> {
  const results = useQueries({
    queries: agentMemberIds.map(id => ({
      queryKey: agentKeys.profile(workspaceId, id),
      queryFn: () => fetchAgentProfile(workspaceId, id),
      retry: false,
    })),
  });
  // `results` is a fresh array on every render, so the memo is keyed on the ids
  // and on the tuple of settled states rather than on the array identity — the
  // map is read by a `FlatList` renderer and an unstable identity there is a
  // re-render of every row on every tick of anything else.
  const fingerprint = results
    .map(r => `${r.status}:${r.data?.paused ?? ''}:${r.data?.version ?? ''}`)
    .join('|');
  return useMemo(() => {
    const out = new Map<string, AgentProfileRead>();
    agentMemberIds.forEach((id, index) => {
      const result = results[index];
      out.set(
        id.toLowerCase(),
        agentProfileRead(result?.data, result?.isPending ?? true, result?.error),
      );
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentMemberIds.join('|'), fingerprint]);
}

/**
 * The models this agent may be given. `null` is a real answer (the server sent
 * no usable list) and is NOT folded into an error, so the screen can say which
 * of the two happened.
 */
export function useAllowedAgentModels(workspaceId: string, agentMemberId: string) {
  return useQuery({
    queryKey: agentKeys.allowedModels(workspaceId, agentMemberId),
    queryFn: () => fetchAgentAllowedModels(workspaceId, agentMemberId),
    retry: false,
  });
}

/**
 * The workspace's work-session ledger.
 *
 * Deliberately NOT `active=1`. The question this surface answers is "무슨 일을
 * 했고 무엇이 지금 도는가", and a list that drops everything finished cannot
 * tell an agent that has never worked apart from one that finished an hour ago.
 * The server already scopes rows to the caller's channels and caps them at 200.
 */
export function useWorkSessions(workspaceId: string, enabled = true) {
  return useQuery({
    queryKey: agentKeys.workSessions(workspaceId),
    queryFn: () => fetchWorkSessions(workspaceId),
    enabled,
  });
}

/**
 * The host registry — the ONLY place the D5 host tier exists.
 *
 * A work-session row carries `hostId` and nothing else about the machine, so
 * without this list every session says 호스트 확인 안 됨. That is the correct
 * degraded answer and not a reason to fail the screen: `hostTier` answers
 * `unknown` for an absent registry, which is a sentence rather than a blank.
 */
export function useWorkHosts(workspaceId: string, enabled = true) {
  return useQuery({
    queryKey: agentKeys.workHosts(workspaceId),
    queryFn: () => fetchWorkHosts(workspaceId),
    enabled,
    retry: false,
  });
}

/**
 * 재우기 / 깨우기, optimistically.
 *
 * The switch moves under the thumb and moves BACK if the server refuses. That
 * pair is the whole contract: an optimistic update with no rollback is a lie
 * with a delay on it, and this is the one control in this batch that changes
 * what an agent does to other people's channels.
 *
 * The rollback restores the exact profile object that was cached before the
 * press (`context.previous`), not a hand-built one: the profile carries
 * `version` and `updatedAtMs`, and reconstructing it would quietly invent a
 * revision the server never issued.
 *
 * `onSettled` re-reads rather than trusting the response, because a repeat write
 * of the same value is a 200 that does NOT bump `version` (measured) — so the
 * response is authoritative about `paused` but the cache should still converge
 * on what the server actually holds.
 */
export function usePauseAgent(workspaceId: string, agentMemberId: string) {
  const client = useQueryClient();
  const key = agentKeys.profile(workspaceId, agentMemberId);
  return useMutation({
    mutationFn: (paused: boolean) =>
      putAgentPause(workspaceId, agentMemberId, paused),
    onMutate: async (paused: boolean) => {
      // The optimistic write comes FIRST, before the await. The usual recipe
      // cancels in-flight reads first, which puts one more microtask between
      // the thumb and the switch for no benefit this surface can use: cancelling
      // afterwards still does its job (it stops a refetch from landing on top of
      // the optimistic value), and a read that had already resolved is corrected
      // by `onSuccess`/`onSettled` a moment later either way.
      const previous = client.getQueryData<AgentProfile>(key);
      if (previous) {
        client.setQueryData<AgentProfile>(key, {...previous, paused});
      }
      await client.cancelQueries({queryKey: key});
      return {previous};
    },
    onError: (_error, _paused, context) => {
      if (context?.previous) client.setQueryData(key, context.previous);
    },
    onSuccess: profile => {
      client.setQueryData(key, profile);
    },
    onSettled: () => {
      void client.invalidateQueries({queryKey: key});
    },
  });
}

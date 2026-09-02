import { useMemo } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  fetchReadStates,
  fetchRoster,
  listChannels,
  type Channel,
  type ReadState,
} from "@momo/core/lib/api";
import { fetchWorkspace } from "@momo/core/features/settings/api";
import type { RoleLabels } from "@momo/core/features/directory/model";
import { idKey, makeDirectory, type Directory } from "@momo/core/features/workspace/directory";

// =============================================================================
// Workspace reads that the sidebar, timeline and quick switcher all share.
// One query per concern so TanStack dedupes across surfaces: the channel list,
// the member directory (humans AND agents, since agents are members), and the
// server read-state projection (P7/ADR-0109: unread is server truth, the client
// never counts it locally).
//
// goal RN-C1: the naming rules that used to live here (`makeDirectory`,
// `channelLabel`, `dmPeer`, `memberNameParts`, ...) moved to
// `@momo/core/features/workspace/directory` and are re-exported below, so every
// existing `@/features/workspace/useWorkspace` import keeps resolving. What
// stayed is the react-query wiring, which is host-shaped.
// =============================================================================

export * from "@momo/core/features/workspace/directory";

export const workspaceIdentityKey = (workspaceId: string) =>
  ["settings", "workspace", workspaceId] as const;

/**
 * Display-only role name overrides from GET /v1/workspaces/{ws}.
 * Shares the settings workspace query so the rail, directory, and settings
 * panel read one cache. Missing projection is `{}` (Korean defaults).
 */
export function useRoleLabels(workspaceId: string): RoleLabels {
  const query = useQuery({
    queryKey: workspaceIdentityKey(workspaceId),
    queryFn: () => fetchWorkspace(workspaceId),
    retry: false,
  });
  return query.data?.roleLabels ?? {};
}

export function useDirectory(workspaceId: string) {
  const query = useQuery({
    queryKey: ["roster", workspaceId],
    queryFn: () => fetchRoster(workspaceId),
  });
  const directory = useMemo<Directory>(
    () => makeDirectory(query.data ?? []),
    [query.data]
  );
  return { ...query, directory };
}

export interface ChannelGroups {
  channels: Channel[];
  dms: Channel[];
}

export function useChannels(workspaceId: string) {
  const query = useQuery({
    queryKey: ["channels", workspaceId],
    queryFn: () => listChannels(workspaceId),
  });
  const groups = useMemo<ChannelGroups>(() => {
    const all = (query.data ?? []).filter((c) => c.archivedAtMs === undefined);
    return {
      channels: all.filter((c) => c.kind !== "dm"),
      dms: all.filter((c) => c.kind === "dm"),
    };
  }, [query.data]);
  return { ...query, groups };
}

export function useReadStates(workspaceId: string) {
  const query = useQuery({
    queryKey: ["read-state", workspaceId],
    queryFn: () => fetchReadStates(workspaceId),
    // Unread is server truth; refresh it on a slow cadence rather than
    // recomputing anything locally.
    refetchInterval: 30_000,
  });
  const byChannel = useMemo(
    () => new Map((query.data ?? []).map((r) => [idKey(r.channelId), r])),
    [query.data]
  );
  return { ...query, byChannel };
}

/** Invalidate the read-state projection after advancing a cursor. */
export function useInvalidateReadStates(workspaceId: string) {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: ["read-state", workspaceId] });
}

/**
 * Replace one channel's row with the server's answer. `marked_unread_before_seq:
 * null` drops a local mark — the client does not guess.
 */
export function applyReadStateToCache(
  client: QueryClient,
  workspaceId: string,
  incoming: ReadState
): void {
  client.setQueryData<ReadState[]>(["read-state", workspaceId], (current) => {
    if (!current) return [incoming];
    const key = idKey(incoming.channelId);
    let found = false;
    const next = current.map((row) => {
      if (idKey(row.channelId) !== key) return row;
      found = true;
      return incoming;
    });
    return found ? next : [...next, incoming];
  });
}

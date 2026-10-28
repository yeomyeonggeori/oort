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
import { AVAILABILITY_REFRESH_MS } from "@momo/core/features/presence/model";
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

export const rosterQueryKey = (workspaceId: string) =>
  ["roster", workspaceId] as const;

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
    queryKey: rosterQueryKey(workspaceId),
    queryFn: () => fetchRoster(workspaceId),
    // 접속 여부(`online`)는 서버가 명부를 읽을 때 전송에서 읽어 싣는 값이라 점은 마지막 명부 읽기만큼만
    // 신선하다(#4692, ADR-0160 ②). 보이는 동안만 이 주기로 다시 읽는다(백그라운드 탭에서는 멈춘다).
    refetchInterval: AVAILABILITY_REFRESH_MS,
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
 *
 * **Two fields are the exception (ADR-0177 D10, #4228).** `latestReadableSeq` and `closedAtSeq` ride
 * only on a `GET read-state` row: the `PUT read-state` answer (open a DM, mark read, mark unread)
 * and the realtime frame do not carry them. `undefined` there means "this response did not say",
 * so the value the cached row already holds stays. Replacing the row wholesale would turn a closed
 * DM's `closedAtSeq` into `undefined` the moment the person opened any other conversation, and the
 * closed DM would come back. `null` is different: it IS an answer ("not closed") and replaces.
 */
export function mergeReadStateRow(current: ReadState, incoming: ReadState): ReadState {
  const merged: ReadState = { ...incoming };
  if (incoming.latestReadableSeq === undefined && current.latestReadableSeq !== undefined) {
    merged.latestReadableSeq = current.latestReadableSeq;
  }
  if (incoming.closedAtSeq === undefined && current.closedAtSeq !== undefined) {
    merged.closedAtSeq = current.closedAtSeq;
  }
  return merged;
}

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
      return mergeReadStateRow(row, incoming);
    });
    return found ? next : [...next, incoming];
  });
}

/**
 * The writing device already knows the new closure state (ADR-0177 D10: other devices converge on
 * their next projection read), so a successful `PUT`/`DELETE closure` writes it straight into the
 * cached row instead of waiting for the next refetch. `null` = reopened.
 */
export function applyClosureToCache(
  client: QueryClient,
  workspaceId: string,
  channelId: string,
  closedAtSeq: number | null
): void {
  client.setQueryData<ReadState[]>(["read-state", workspaceId], (current) => {
    if (!current) return current;
    const key = idKey(channelId);
    return current.map((row) =>
      idKey(row.channelId) === key ? { ...row, closedAtSeq } : row
    );
  });
}

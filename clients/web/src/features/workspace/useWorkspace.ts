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
import { isDesktop } from "@/lib/tauri";

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
    // The desktop app lives on with its window put away (#5196): the Dock badge and the menu-bar dot are
    // built from these rows (`useDockBadgeCount`), and nothing but this poll refreshes them. A hidden page
    // pauses an interval by default (`refetchOnWindowFocus` is off app-wide, so nothing catches up on
    // return either), which would freeze the badge exactly while the window is away. Browsers keep the
    // default: a background tab owes nobody a badge.
    refetchIntervalInBackground: isDesktop(),
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
 *
 * `followedUnreadReplyCount` (#5667, ADR-0124 amendment 4) is the third: only a `GET` row carries it, and reading a
 * channel does not read the threads inside it, so a `PUT` answer must not drop the menu-bar dot's thread share (#5660).
 *
 * `historyFromSeq` (ADR-0177 amendment 2026-11-14 D18/D21) is the fourth: only a `GET` row carries the caller's read
 * floor. Dropping it would turn a left DM's floor into "did not say" (the core holds its verdict) and, if every row lost
 * it, make the server look like one without 「대화 나가기」.
 */
export function mergeReadStateRow(current: ReadState, incoming: ReadState): ReadState {
  const merged: ReadState = { ...incoming };
  if (incoming.latestReadableSeq === undefined && current.latestReadableSeq !== undefined) {
    merged.latestReadableSeq = current.latestReadableSeq;
  }
  if (incoming.closedAtSeq === undefined && current.closedAtSeq !== undefined) {
    merged.closedAtSeq = current.closedAtSeq;
  }
  if (incoming.followedUnreadReplyCount === undefined && current.followedUnreadReplyCount !== undefined) {
    merged.followedUnreadReplyCount = current.followedUnreadReplyCount;
  }
  if (incoming.historyFromSeq === undefined && current.historyFromSeq !== undefined) {
    merged.historyFromSeq = current.historyFromSeq;
  }
  return merged;
}

/**
 * 이 대화의 읽기 하한(ADR-0177 증보 2026-11-14 D18·D22, #5825): 읽음 투영 캐시의 그 행이 든 `historyFromSeq`. 없거나 하한이 없으면
 * `null`. 이벤트가 온 순간 부른다.
 */
export function historyFloorFromCache(client: QueryClient, workspaceId: string, channelId: string): number | null {
  const key = idKey(channelId);
  const row = client.getQueryData<ReadState[]>(["read-state", workspaceId])?.find((candidate) => idKey(candidate.channelId) === key);
  const floor = row?.historyFromSeq;
  return typeof floor === "number" && floor > 0 ? floor : null;
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
 * 스레드 모두 읽음 응답의 줄(#5690)에서는 따라가는 스레드의 답글 몫만 캐시의 채널 줄에 끼운다. 그 응답 줄은 같은 단추의
 * 채널 `PUT`과 엇갈려 옛 위치·멘션 수를 실어 올 수 있어서, 통째로 바꾸면 방금 읽음으로 올린 채널의 수가 되살아난다.
 * 캐시에 없는 채널이면 그 줄을 그대로 덧붙인다(지킬 값이 없다).
 */
export function applyFollowedThreadShareToCache(
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
      return { ...row, followedUnreadReplyCount: incoming.followedUnreadReplyCount };
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

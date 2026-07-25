import { useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fetchReadStates,
  fetchRoster,
  listChannels,
  type Channel,
  type ReadState,
  type RosterMember,
} from "@/lib/api";

// =============================================================================
// Workspace reads that the sidebar, timeline and quick switcher all share.
// One query per concern so TanStack dedupes across surfaces: the channel list,
// the member directory (humans AND agents, since agents are members), and the
// server read-state projection (P7/ADR-0109: unread is server truth, the client
// never counts it locally).
// =============================================================================

/** Case-insensitive uuid map: ids cross the wire in mixed case by design. */
function keyOf(id: string): string {
  return id.toLowerCase();
}

export interface Directory {
  members: RosterMember[];
  byId: Map<string, RosterMember>;
}

/** Index a member list for lookup by id, whatever the case the ids arrive in. */
export function makeDirectory(members: RosterMember[]): Directory {
  return { members, byId: new Map(members.map((m) => [keyOf(m.id), m])) };
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
    () => new Map((query.data ?? []).map((r) => [keyOf(r.channelId), r])),
    [query.data]
  );
  return { ...query, byChannel };
}

/** Invalidate the read-state projection after advancing a cursor. */
export function useInvalidateReadStates(workspaceId: string) {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: ["read-state", workspaceId] });
}

/** Server unread for a channel, or null when the projection has no entry. */
export function unreadFor(
  byChannel: Map<string, ReadState>,
  channelId: string
): ReadState | null {
  return byChannel.get(keyOf(channelId)) ?? null;
}

export function memberFor(
  directory: Directory,
  memberId: string | undefined
): RosterMember | null {
  if (!memberId) return null;
  return directory.byId.get(keyOf(memberId)) ?? null;
}

/**
 * Channel label. DM channels carry no name, so the label is the other
 * participant resolved through the directory (falling back to the handle-less
 * "다이렉트 메시지" only when the roster has not loaded).
 */
export function channelLabel(
  channel: Channel,
  directory: Directory,
  selfMemberId: string
): string {
  if (channel.kind !== "dm") return channel.name ?? "이름 없는 채널";
  const other = (channel.memberIds ?? []).find(
    (id) => keyOf(id) !== keyOf(selfMemberId)
  );
  const member = memberFor(directory, other);
  if (member) return member.displayName;
  return "다이렉트 메시지";
}

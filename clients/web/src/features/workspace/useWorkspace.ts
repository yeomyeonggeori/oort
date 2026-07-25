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

/** Fold a display name for comparison: case and edge whitespace carry nothing. */
function nameKey(displayName: string): string {
  return displayName.trim().toLowerCase();
}

export interface Directory {
  members: RosterMember[];
  byId: Map<string, RosterMember>;
  /**
   * Display names carried by MORE THAN ONE member of this workspace, folded by
   * nameKey. This roster really has two 김인턴 (a human, @intern-kim, and an
   * agent, @kim-intern), so a surface that names a member by displayName alone
   * is showing two different people under one label.
   */
  ambiguousNames: Set<string>;
}

/** Index a member list for lookup by id, whatever the case the ids arrive in. */
export function makeDirectory(members: RosterMember[]): Directory {
  const seen = new Map<string, number>();
  for (const member of members) {
    const key = nameKey(member.displayName);
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const ambiguousNames = new Set<string>();
  for (const [key, count] of seen) {
    if (count > 1) ambiguousNames.add(key);
  }
  return {
    members,
    byId: new Map(members.map((m) => [keyOf(m.id), m])),
    ambiguousNames,
  };
}

/** Does this display name identify one member here, or several? */
export function isAmbiguousName(
  directory: Directory,
  member: RosterMember
): boolean {
  return directory.ambiguousNames.has(nameKey(member.displayName));
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
 * The other participant of a 1:1 DM, resolved through the roster. A DM is fixed
 * to a participant pair by its dmKey (openapi `openDm`), so "the other one" is
 * a well-defined member, not a summary of a group.
 */
export function dmPeer(
  channel: Channel,
  directory: Directory,
  selfMemberId: string
): RosterMember | null {
  if (channel.kind !== "dm") return null;
  const other = (channel.memberIds ?? []).find(
    (id) => keyOf(id) !== keyOf(selfMemberId)
  );
  return memberFor(directory, other);
}

export interface ChannelLabelParts {
  /** The name to render. */
  text: string;
  /**
   * "@handle", present only when `text` alone does not identify the member.
   * The directory row shows the handle on every row because it is a roster;
   * a destination list shows it only where two rows would otherwise be twins.
   */
  handle: string | null;
  /** The DM peer is an agent, so the name carries the --agent token (§9). */
  isAgent: boolean;
}

/**
 * Channel label, structured. DM channels carry no name, so the label is the
 * other participant resolved through the directory (falling back to the
 * handle-less "다이렉트 메시지" only when the roster has not loaded).
 */
export function channelLabelParts(
  channel: Channel,
  directory: Directory,
  selfMemberId: string
): ChannelLabelParts {
  if (channel.kind !== "dm") {
    return {
      text: channel.name ?? "이름 없는 채널",
      handle: null,
      isAgent: false,
    };
  }
  const member = dmPeer(channel, directory, selfMemberId);
  if (!member) return { text: "다이렉트 메시지", handle: null, isAgent: false };
  return {
    text: member.displayName,
    handle: isAmbiguousName(directory, member) ? `@${member.handle}` : null,
    isAgent: member.kind === "agent",
  };
}

/**
 * The same label as one string, for the places that can only take one (aria
 * labels, the composer placeholder, cmdk search values, the inbox meta cell).
 * It carries the handle too: a label that drops the disambiguator is the bug
 * this function exists to avoid.
 */
export function channelLabel(
  channel: Channel,
  directory: Directory,
  selfMemberId: string
): string {
  const parts = channelLabelParts(channel, directory, selfMemberId);
  return parts.handle ? `${parts.text} ${parts.handle}` : parts.text;
}

import type { Channel, ReadState, RosterMember } from "../../lib/api";

// =============================================================================
// The workspace directory, as pure functions (goal RN-C1 / ADR-0137 D3).
//
// Extracted from the web client's `useWorkspace.ts`, which kept two unrelated
// things in one file: the react-query reads (which are host wiring — RN gets the
// same queries with `focusManager`←AppState and `onlineManager`←NetInfo) and the
// naming rules below, which are the product's answer to "who is this row about"
// and are identical on every platform.
//
// The rule that must not be lost in a port: this roster really does carry two
// 김인턴 (a human @intern-kim and an agent @kim-intern), so any surface that
// names a member by displayName alone is showing two different people under one
// label. Everything here routes through the ambiguity index for that reason.
// =============================================================================

/** Case-insensitive uuid map: ids cross the wire in mixed case by design. */
export function idKey(id: string): string {
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
    byId: new Map(members.map((m) => [idKey(m.id), m])),
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

/** Server unread for a channel, or null when the projection has no entry. */
export function unreadFor(
  byChannel: Map<string, ReadState>,
  channelId: string
): ReadState | null {
  return byChannel.get(idKey(channelId)) ?? null;
}

export function memberFor(
  directory: Directory,
  memberId: string | undefined
): RosterMember | null {
  if (!memberId) return null;
  return directory.byId.get(idKey(memberId)) ?? null;
}

/** A member named for a sentence: the name, plus the handle when it is needed. */
export interface MemberNameParts {
  name: string;
  handle?: string;
}

/**
 * Name a member the way `channelLabelParts` names a DM: display name, and
 * "@handle" whenever this workspace carries more than one member under that
 * name. Every surface that puts a member's name in a sentence goes through
 * here, because dropping the disambiguator is the bug the ambiguity index
 * exists to prevent.
 */
export function memberNameParts(
  directory: Directory,
  memberId: string,
  fallback: string
): MemberNameParts {
  const member = memberFor(directory, memberId);
  if (!member || member.displayName.trim() === "") return { name: fallback };
  return isAmbiguousName(directory, member)
    ? { name: member.displayName, handle: `@${member.handle}` }
    : { name: member.displayName };
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
    (id) => idKey(id) !== idKey(selfMemberId)
  );
  return memberFor(directory, other);
}

/**
 * The agent this channel answers **without an @mention**, or null.
 *
 * The server rule (goal B13 / QA H7, `momo_agent::dm::resolve_dm_addressing`) is
 * "a DM, a human author, exactly one agent counterpart", and this predicate is
 * written clause for clause against it so the composer never promises something
 * the send path will not do.
 *
 * Two deliberate differences from [`dmPeer`], both of which are the rule rather
 * than a refinement of it:
 *   * `length !== 1` instead of "the first other id" — a group DM is back to
 *     "who did you mean", and `dmPeer` answering with one of three would put the
 *     hint on a channel that ignores it;
 *   * `kind === "agent"` — a human counterpart does not run.
 *
 * The server stays the authority. This is what the client can see of the same
 * decision, which is why the result is a hint and never a control.
 */
export function dmAutoReplyAgent(
  channel: Channel,
  directory: Directory,
  selfMemberId: string
): RosterMember | null {
  if (channel.kind !== "dm") return null;
  const others = (channel.memberIds ?? []).filter(
    (id) => idKey(id) !== idKey(selfMemberId)
  );
  if (others.length !== 1) return null;
  const peer = memberFor(directory, others[0]);
  if (!peer || peer.kind !== "agent" || peer.status !== "active") return null;
  return peer;
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

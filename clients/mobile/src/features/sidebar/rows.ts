import {uuidEq, type Channel, type ReadState, type RosterMember} from '@momo/core/lib/api';
import {
  channelLabelParts,
  dmPeer,
  idKey,
  isAmbiguousName,
  unreadFor,
  type Directory,
} from '@momo/core/features/workspace/directory';
import type {ChannelGroups} from '../workspace/queries';

// =============================================================================
// What the 대화 list shows, as a pure function.
//
// Every naming decision below is a call into
// `@momo/core/features/workspace/directory` — `channelLabelParts` for the row
// title, `isAmbiguousName` for whether a handle has to ride along, `unreadFor`
// for the count, `dmPeer` for who a DM is with. None of it is re-derived here,
// and the reason the core spells out is worth repeating because it is the exact
// bug a hand-written mobile sidebar would ship with: **this roster really does
// carry two 김인턴** — a human `@intern-kim` and an agent `@kim-intern` — so a
// row that renders `displayName` alone is showing two different people under one
// label.
//
// What IS decided here, and is therefore this file's to defend:
//
//   1. **the 에이전트 section.** Agents are members (ADR-0004, invariant 5), so
//      they are already in the roster; what the phone adds is a way to reach one
//      that does not require a DM to exist first. Agents that already have a DM
//      are left out — they are one row up under 다이렉트 메시지, and listing them
//      twice would make the same conversation look like two.
//   2. **open-channel unread suppression.** The row you are currently reading
//      shows no badge, even before the server's projection catches up. Same rule
//      as the web sidebar. It is the ONLY place this client overrides a server
//      count, and it only ever overrides it downward, for one row.
//   3. **the search filter.** Substring, case-folded, over the text that is
//      actually on the row. See the note on `matches` for why it is not fuzzier.
//
// ## Spike constraint 1 lives at this boundary
//
// `query` is a plain string parameter and this function is synchronous. The
// search field's value must never travel through a store, a query or the network
// and back before it is rendered (#837 gate 1 case D: one `setTimeout(…, 0)` was
// enough to sever the iOS IME and stop Korean jamo combining). Filtering being
// pure and instant is what makes the synchronous path cheap enough to keep.
// =============================================================================

export type SidebarRowKind = 'channel' | 'dm' | 'agent';

export interface SidebarRow {
  key: string;
  kind: SidebarRowKind;
  /**
   * For `channel`/`dm`: the channel id, ready to open. For `agent`: the MEMBER
   * id, because the DM may not exist yet — opening it is a server round trip
   * (`openDirectMessage`), and the server, not this client, decides which
   * channel that pair maps to.
   */
  targetId: string;
  title: string;
  /** "@handle", present only when the title alone names two different members. */
  handle: string | null;
  isAgent: boolean;
  isPrivate: boolean;
  muted: boolean;
  unreadCount: number;
  mentionCount: number;
  /** The whole row as one sentence, for VoiceOver. */
  accessibilityLabel: string;
}

/**
 * `data` rather than `rows` because React Native's `SectionList` requires that
 * key by contract. Reshaping at render time instead would allocate a new array
 * of sections on every keystroke of the search field — which is the one place in
 * this batch where per-keystroke cost is measured rather than assumed.
 */
export interface SidebarSection {
  key: 'channels' | 'dms' | 'agents';
  label: string;
  data: SidebarRow[];
}

export interface SidebarInput {
  groups: ChannelGroups;
  agents: RosterMember[];
  directory: Directory;
  selfMemberId: string;
  unreadByChannel: Map<string, ReadState>;
  /** The channel being read right now, or null. Its badge is suppressed. */
  openChannelId: string | null;
  /** The search field's value, synchronously. */
  query: string;
}

/**
 * Case-folded substring, and nothing cleverer.
 *
 * A fuzzy or initial-consonant (초성) matcher is the obvious next idea and it is
 * deliberately not here: it needs its own jamo decomposition table, it belongs in
 * the core beside `koreanParticle` rather than in one client, and getting it
 * subtly wrong makes rows disappear — which reads as "the app lost my channel",
 * the worst possible failure for a list you are searching because you cannot find
 * something. Substring never hides a row whose visible text contains what was
 * typed.
 */
function matches(row: SidebarRow, needle: string): boolean {
  if (needle === '') return true;
  const haystack = `${row.title} ${row.handle ?? ''}`.toLowerCase();
  return haystack.includes(needle);
}

function accessibilityLabelFor(
  row: Omit<SidebarRow, 'accessibilityLabel'>,
): string {
  const parts: string[] = [];
  if (row.kind === 'channel') parts.push(`채널 ${row.title}`);
  else if (row.kind === 'dm') parts.push(`다이렉트 메시지 ${row.title}`);
  else parts.push(`에이전트 ${row.title}`);
  if (row.handle) parts.push(row.handle);
  if (row.isPrivate) parts.push('비공개');
  if (row.muted) parts.push('알림 꺼짐');
  // Counts are spelled out rather than left as a bare number beside a name,
  // which VoiceOver would read as part of the name.
  if (row.mentionCount > 0) parts.push(`멘션 ${row.mentionCount}개`);
  if (row.unreadCount > 0) parts.push(`안 읽은 메시지 ${row.unreadCount}개`);
  return parts.join(', ');
}

function withLabel(row: Omit<SidebarRow, 'accessibilityLabel'>): SidebarRow {
  return {...row, accessibilityLabel: accessibilityLabelFor(row)};
}

function channelRow(
  channel: Channel,
  input: SidebarInput,
  kind: 'channel' | 'dm',
): SidebarRow {
  const label = channelLabelParts(channel, input.directory, input.selfMemberId);
  // The channel being read has nothing unread in it, whatever the projection
  // still says. The server catches up on the next read-state poll; until then a
  // badge on the row you are looking at is just wrong.
  const open =
    input.openChannelId !== null && uuidEq(channel.id, input.openChannelId);
  const read = open ? null : unreadFor(input.unreadByChannel, channel.id);
  return withLabel({
    key: `${kind}:${idKey(channel.id)}`,
    kind,
    targetId: channel.id,
    title: label.text,
    handle: label.handle,
    isAgent: label.isAgent,
    isPrivate: channel.kind === 'private',
    muted: channel.muted,
    unreadCount: read?.unreadCount ?? 0,
    mentionCount: read?.mentionCount ?? 0,
  });
}

function agentRow(member: RosterMember, directory: Directory): SidebarRow {
  return withLabel({
    key: `agent:${idKey(member.id)}`,
    kind: 'agent',
    targetId: member.id,
    title: member.displayName,
    // An agent row is a destination list, so the handle appears only where two
    // rows would otherwise be twins — the same rule `channelLabelParts` applies
    // to a DM, reached through the core's own ambiguity index.
    handle: isAmbiguousName(directory, member) ? `@${member.handle}` : null,
    isAgent: true,
    isPrivate: false,
    muted: false,
    unreadCount: 0,
    mentionCount: 0,
  });
}

/**
 * Agents with no DM open yet. `dmPeer` resolves each existing DM to its other
 * participant, so "already reachable one row up" is answered by the core rather
 * than by matching handles.
 */
export function agentsWithoutDm(
  agents: RosterMember[],
  dms: Channel[],
  directory: Directory,
  selfMemberId: string,
): RosterMember[] {
  const paired = new Set(
    dms
      .map(channel => dmPeer(channel, directory, selfMemberId))
      .filter((member): member is RosterMember => member !== null)
      .map(member => idKey(member.id)),
  );
  return agents.filter(agent => !paired.has(idKey(agent.id)));
}

export function buildSidebarSections(input: SidebarInput): SidebarSection[] {
  const needle = input.query.trim().toLowerCase();

  const channels = input.groups.channels
    .map(channel => channelRow(channel, input, 'channel'))
    .filter(row => matches(row, needle));
  const dms = input.groups.dms
    .map(channel => channelRow(channel, input, 'dm'))
    .filter(row => matches(row, needle));
  const agents = agentsWithoutDm(
    input.agents,
    input.groups.dms,
    input.directory,
    input.selfMemberId,
  )
    .map(member => agentRow(member, input.directory))
    .filter(row => matches(row, needle));

  // An empty section is dropped rather than rendered with a header and nothing
  // under it. A heading over a void reads as "something failed to load here",
  // which is a different and untrue statement from "you have no DMs".
  return [
    {key: 'channels' as const, label: '채널', data: channels},
    {key: 'dms' as const, label: '다이렉트 메시지', data: dms},
    {key: 'agents' as const, label: '에이전트', data: agents},
  ].filter(section => section.data.length > 0);
}

/** Total rows across sections. Drives "search found nothing" vs "no channels". */
export function rowCount(sections: SidebarSection[]): number {
  return sections.reduce((total, section) => total + section.data.length, 0);
}

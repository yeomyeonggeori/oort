import {uuidEq, type Channel, type ReadState, type RosterMember} from '@momo/core/lib/api';
import {composedUnreadCount} from '@momo/core/features/readState/model';
import {
  goneUnreadProbeAfterSeq,
  rosterIsComplete,
  type ReadProjectionPhase,
} from '@momo/core/features/sidebar/goneDm';
import {
  channelLabelParts,
  dmPeer,
  idKey,
  isAmbiguousName,
  unreadFor,
  type ChannelLabelKind,
  type Directory,
} from '@momo/core/features/workspace/directory';
import type {ChannelGroups} from '../workspace/queries';
import type {DmVerdict} from './dmVerdicts';
import {rowEmphasis, type RowEmphasis} from './rowEmphasis';

/**
 * 대화 목록을 못 불러왔을 때 목록 자리의 `ErrorState` 가 드는 머리줄.
 *
 * 상수인 이유는 이 문장을 두 곳이 말하기 때문이다 (#2584 리뷰 M-1): 화면의 상자와,
 * 알림 탭이 그 실패에 막혔을 때의 낭독. 둘이 따로 적으면 같은 사실이 두 이름으로
 * 들린다 — 그 리뷰가 잡은 결함이 바로 「대화 목록」과 「채널」 두 명사였다.
 */
export const CHANNEL_LIST_FAILED = '채널을 불러오지 못했습니다.';

// =============================================================================
// What the 대화 list shows, as a pure function.
//
// Every naming decision below is a call into
// `@momo/core/features/workspace/directory` — `channelLabelParts` for the row
// title, `isAmbiguousName` for whether a handle has to ride along, `unreadFor`
// for the row, `dmPeer` for who a DM is with. None of it is re-derived here,
// and the reason the core spells out is worth repeating because it is the exact
// bug a hand-written mobile sidebar would ship with: **this roster really does
// carry two 김인턴** — a human `@intern-kim` and an agent `@kim-intern` — so a
// row that renders `displayName` alone is showing two different people under one
// label.
//
// What IS decided here, and is therefore this file's to defend:
//
//   1. **agents in the DM section** (DS2-3 #2715, ADR-0189 D1). Agents are
//      members (ADR-0004, invariant 5), so they are already in the roster; what
//      the phone adds is a way to reach one that does not require a DM to exist
//      first. The separate 에이전트 section is gone — ADR-0189 folds the agent
//      tab into the home's 「작업 중」 card and DM section — so an agent with no
//      DM yet is a DM row that opens one on tap. Agents that already have a DM
//      are that DM's row and are not listed twice, which would make the same
//      conversation look like two. Agent rows come first in the section (시안 A
//      `#a-home`): a partition by kind, not a recency claim, so the "no sort"
//      rule below is intact.
//   2. **open-channel unread suppression.** The row you are currently reading
//      shows no badge, even before the server's projection catches up. Same rule
//      as the web sidebar (`sidebarUnreadCounts`). It is the ONLY place this
//      client overrides the projection, and it only ever overrides it downward,
//      for one row.
//   3. **the search filter.** Substring, case-folded, over the text that is
//      actually on the row. See the note on `matches` for why it is not fuzzier.
//   4. **닫은 대화와 나간 멤버와의 대화는 목록에 서지 않는다** (#4367, ADR-0177 증보 D8). 한 DM 이
//      서는가는 코어 `dmVisibility` 한 함수가 정하고 웹 사이드바와 같다. 이 파일은 그 판정을
//      (`dmVerdicts.ts` 가 입력을 모아 만든) `dmVerdicts` 로 받아 행을 거를 뿐이다. 숨은 DM 은
//      「⋯ › 닫은 대화」 시트가 연다. **검색 중에는 거르지 않는다**: 이름으로 찾는 것은 숨은 대화를
//      찾겠다는 뜻이고, 닫기는 지우기가 아니다. 열려 있는 DM 은 언제나 선다.
//
// ## The count is the COMPOSED one (ADR-0178 D3, #1964)
//
// A read-state row carries the server's `unreadCount`, and that number does not
// know about 「여기부터 안 읽음」: the server keeps the mark in a column of its own
// and never folds it into the count (PR #1961). A channel marked on the desktop
// therefore arrives here with `unreadCount: 0`, and a row that printed it showed
// the one channel the person had asked to come back to as read.
//
// So the count goes through `composedUnreadCount`, the core's single point, and
// this file never names the mark. Composing here instead is exactly what D3
// forbids — `__tests__/markUnreadConsumption.test.tsx` holds both halves.
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
  /**
   * The member whose face this row wears: a DM's peer, or the agent itself.
   * `null` for a channel, and for a DM whose peer the roster cannot name (the
   * row then draws no face rather than a guessed one).
   */
  avatarMemberId: string | null;
  isAgent: boolean;
  /**
   * 이름이 어디서 왔나(`channelLabelParts().kind`). 얼굴을 못 그리는 DM 이 어떤 이유인지
   * (명부에 없음 / 명부를 받는 중 / 나 혼자) 가르고, 접는 판정의 입력이다.
   */
  labelKind: ChannelLabelKind;
  isPrivate: boolean;
  muted: boolean;
  unreadCount: number;
  mentionCount: number;
  /**
   * 이 줄이 새 글에 대해 하는 말: 이름·아이콘이 회색인가, 굵은가, 오른쪽 칩이 무엇인가(#4953). 문법은 `rowEmphasis.ts`
   * 한 곳이고 `Row` 는 색 토큰으로 옮기기만 한다.
   */
  emphasis: RowEmphasis;
  /** The whole row as one sentence, for VoiceOver. */
  accessibilityLabel: string;
  /**
   * What the search field matches against — **not** what is rendered.
   *
   * The two differ on purpose. `handle` is null unless the workspace holds two
   * members under one name, so matching only the visible text would mean an
   * agent could not be found by the handle people actually address it with
   * (`@hermes`), and `#general` would miss because the `#` is drawn separately
   * from the name. Both are cases where a row exists, the person types its real
   * name, and nothing comes back.
   */
  searchText: string;
}

/**
 * `data` rather than `rows` because React Native's `SectionList` requires that
 * key by contract. Reshaping at render time instead would allocate a new array
 * of sections on every keystroke of the search field — which is the one place in
 * this batch where per-keystroke cost is measured rather than assumed.
 */
export interface SidebarSection {
  key: 'channels' | 'dms';
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
  /**
   * 서버 읽음 투영이 어디까지 왔나. 접는 판정의 입력이다(오는 중이면 접힌 채, 못 읽었으면 접지
   * 않는다). 줄의 회색도 이것을 읽는다: 못 읽었으면 새 글 없는 줄을 회색(= 다 읽었다)으로 칠하지 않는다(`rowEmphasis`).
   * 생략하면 `ready` 다.
   */
  readPhase?: ReadProjectionPhase;
  /**
   * 명부를 받았나(코어 `rosterLoaded`). 행 이름과 접는 판정이 **같은 답**을 읽는다: 받지 못했으면 상대 없는 DM 은
   * 「불러오는 중」이라 접히지 않는다. 생략하면 코어의 기본(멤버가 한 명이라도 있으면 받은 것)이다.
   */
  rosterReady?: boolean;
  /**
   * DM 마다의 보임 판정(소문자 id -> 판정, `dmVerdicts`). 생략하거나 없는 id 는 보인다: 모를 때 숨기는 쪽이 최악이다.
   */
  dmVerdicts?: ReadonlyMap<string, DmVerdict>;
}

/**
 * 안 읽음이 사람이 읽을 것인지 **메시지를 읽어 가려야** 하는 나간 멤버 DM (코어 `goneUnreadProbeAfterSeq` 가 규칙이다).
 * 화면의 훅(`useGoneUnreadVerdicts`)이 이 목록을 읽는다. 열려 있는 DM 은 행이 안 읽음을 0 으로 접으므로 후보가 아니다.
 */
export function goneUnreadCandidates(
  input: Pick<
    SidebarInput,
    | 'groups'
    | 'directory'
    | 'selfMemberId'
    | 'unreadByChannel'
    | 'openChannelId'
    | 'readPhase'
    | 'rosterReady'
  >,
): Array<{id: string; after: number; latest: number}> {
  const rosterComplete = rosterIsComplete(input.directory.members.length);
  const phase = input.readPhase ?? 'ready';
  const out: Array<{id: string; after: number; latest: number}> = [];
  for (const channel of input.groups.dms) {
    const open =
      input.openChannelId !== null && uuidEq(channel.id, input.openChannelId);
    const read = open ? null : unreadFor(input.unreadByChannel, channel.id);
    const after = goneUnreadProbeAfterSeq({
      labelKind: channelLabelParts(
        channel,
        input.directory,
        input.selfMemberId,
        input.rosterReady === undefined ? {} : {rosterReady: input.rosterReady},
      ).kind,
      rosterComplete,
      isOpen: open,
      phase,
      read,
    });
    if (after !== null && read) {
      out.push({id: idKey(channel.id), after, latest: read.latestSeq});
    }
  }
  return out;
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
  return row.searchText.includes(needle);
}

function accessibilityLabelFor(
  row: Omit<SidebarRow, 'accessibilityLabel' | 'searchText'>,
): string {
  const parts: string[] = [];
  if (row.kind === 'channel') parts.push(`#${row.title}`);
  else if (row.kind === 'dm') parts.push(`다이렉트 메시지 ${row.title}`);
  else parts.push(`에이전트 ${row.title}`);
  if (row.handle) parts.push(row.handle);
  if (row.isPrivate) parts.push('비공개');
  if (row.muted) parts.push('알림 꺼짐');
  // Counts are spelled out rather than left as a bare number beside a name,
  // which VoiceOver would read as part of the name.
  if (row.mentionCount > 0) parts.push(`멘션 ${row.mentionCount}개`);
  if (row.unreadCount > 0) parts.push(`새 메시지 ${row.unreadCount}개`);
  return parts.join(', ');
}

function withLabel(
  row: Omit<SidebarRow, 'accessibilityLabel' | 'searchText'>,
  extraSearchTerms: readonly string[] = [],
): SidebarRow {
  const searchText = [
    row.title,
    row.handle ?? '',
    row.kind === 'channel' ? `#${row.title}` : '',
    ...extraSearchTerms,
  ]
    .join(' ')
    .toLowerCase();
  return {...row, accessibilityLabel: accessibilityLabelFor(row), searchText};
}

/**
 * 읽음 투영의 국면마다, 새 글 없는 줄을 회색(= 다 읽었다)으로 그려도 되는가(`rowEmphasis` 의 `mayDim`). 실패(`error`)면 안 읽음 수를
 * 모르므로 회색을 칠하지 않는다. 오는 중은 조용한 쪽(회색)이다 — 새 글이 있는 줄만 나중에 떠오른다. 표로 둔 것은 직접 문구
 * 장부가 낱말 하나짜리 비교 리터럴도 세기 때문이고, 새 국면이 생기면 이 표가 컴파일에서 빨갛게 된다.
 */
const READ_PHASE_MAY_DIM: Readonly<Record<ReadProjectionPhase, boolean>> = {
  loading: true,
  error: false,
  ready: true,
};

function channelRow(
  channel: Channel,
  input: SidebarInput,
  kind: 'channel' | 'dm',
): SidebarRow {
  const label = channelLabelParts(
    channel,
    input.directory,
    input.selfMemberId,
    input.rosterReady === undefined ? {} : {rosterReady: input.rosterReady},
  );
  // A DM's peer handle is searchable even when the label does not show it.
  const peer =
    kind === 'dm' ? dmPeer(channel, input.directory, input.selfMemberId) : null;
  // The channel being read has nothing unread in it, whatever the projection
  // still says. The server catches up on the next read-state poll; until then a
  // badge on the row you are looking at is just wrong.
  const open =
    input.openChannelId !== null && uuidEq(channel.id, input.openChannelId);
  const read = open ? null : unreadFor(input.unreadByChannel, channel.id);
  // D3: never `read.unreadCount`. See the header — that field is blind to a
  // mark set on another device.
  const unreadCount = read ? composedUnreadCount(read) : 0;
  const mentionCount = read?.mentionCount ?? 0;
  return withLabel({
    key: `${kind}:${idKey(channel.id)}`,
    kind,
    targetId: channel.id,
    title: label.text,
    handle: label.handle,
    avatarMemberId: peer?.id ?? null,
    isAgent: label.isAgent,
    labelKind: label.kind,
    isPrivate: channel.kind === 'private',
    muted: channel.muted,
    unreadCount,
    mentionCount,
    // 새 글이 있는 줄만 또렷하다(#4953). 문법은 `rowEmphasis.ts`, 여기는 그 입력을 모은다.
    emphasis: rowEmphasis({
      unreadCount,
      mentionCount,
      muted: channel.muted,
      tracksRead: true,
      mayDim: input.readPhase === undefined || READ_PHASE_MAY_DIM[input.readPhase],
      selected: open,
    }),
  }, peer ? [`@${peer.handle}`] : []);
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
    avatarMemberId: member.id,
    isAgent: true,
    labelKind: 'peer',
    isPrivate: false,
    muted: false,
    unreadCount: 0,
    mentionCount: 0,
    // 갈 곳이지 대화가 아니다: 읽음이 없으므로 강조도 흐림도 없다.
    emphasis: rowEmphasis({
      unreadCount: 0,
      mentionCount: 0,
      muted: false,
      tracksRead: false,
      mayDim: true,
      selected: false,
    }),
  }, [`@${member.handle}`]);
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
  const dmRows = input.groups.dms.map(channel => channelRow(channel, input, 'dm'));
  // 닫은 대화·나간 멤버와의 대화(#4367): 검색 중에는 거르지 않는다.
  const dms = dmRows
    .filter(
      row =>
        needle !== '' ||
        (input.dmVerdicts?.get(idKey(row.targetId))?.shown ?? true),
    )
    .filter(row => matches(row, needle));
  const agents = agentsWithoutDm(
    input.agents,
    input.groups.dms,
    input.directory,
    input.selfMemberId,
  )
    .map(member => agentRow(member, input.directory))
    .filter(row => matches(row, needle));

  // 에이전트가 앞이다 (시안 A `#a-home` DM 섹션). 안에서는 각자 받은 순서 그대로 —
  // 이 정렬은 종류로 가르는 것이지 최근성을 주장하지 않는다.
  const dmSection = [
    ...dms.filter(row => row.isAgent),
    ...agents,
    ...dms.filter(row => !row.isAgent),
  ];

  // An empty section is dropped rather than rendered with a header and nothing
  // under it. A heading over a void reads as "something failed to load here",
  // which is a different and untrue statement from "you have no DMs".
  // 숨은 DM 만 남은 DM 섹션도 선다: 「⋯ › 닫은 대화」가 그 대화들의 문이고, 문은 섹션 머리에 있다(웹의 DM 구역 머리도 그대로 선다).
  // 닫은 대화만 있는 사람에게 「참여한 채널이 없다」고 말하면 거짓이고 돌아올 길도 없다.
  const hasHiddenDm =
    needle === '' &&
    dmRows.some(row => !(input.dmVerdicts?.get(idKey(row.targetId))?.shown ?? true));
  return [
    {key: 'channels' as const, label: '채널', data: channels},
    {key: 'dms' as const, label: 'DM', data: dmSection},
  ].filter(
    section => section.data.length > 0 || (section.key === 'dms' && hasHiddenDm),
  );
}

/** Total rows across sections. Drives "search found nothing" vs "no channels". */
export function rowCount(sections: SidebarSection[]): number {
  return sections.reduce(
    (total, section) => total + section.data.length,
    0,
  );
}

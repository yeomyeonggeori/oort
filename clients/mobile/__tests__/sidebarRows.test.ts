import type {Channel, ReadState, RosterMember} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {
  agentsWithoutDm,
  buildSidebarSections,
  rowCount,
  type SidebarInput,
  type SidebarSection,
} from '../src/features/sidebar/rows';

// =============================================================================
// The 대화 list, asserted without a screen.
//
// The roster below is the one the core's directory module warns about, because
// it is real: **two 김인턴**, a human `@intern-kim` and an agent `@kim-intern`.
// A sidebar that names a row by display name alone shows two different people
// under one label, and it looks completely fine in a screenshot.
// =============================================================================

const SELF_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const WS = 'wwwwwwww-2222-4222-8222-wwwwwwwwwwww';

function member(overrides: Partial<RosterMember> & {id: string}): RosterMember {
  return {
    workspaceId: WS,
    kind: 'human',
    status: 'active',
    displayName: '이름',
    handle: 'handle',
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...overrides,
  };
}

const SELF = member({id: SELF_ID, displayName: '곽성재', handle: 'seongjae'});
const HUMAN_KIM = member({
  id: 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb',
  displayName: '김인턴',
  handle: 'intern-kim',
});
const AGENT_KIM = member({
  id: 'cccccccc-1111-4111-8111-cccccccccccc',
  kind: 'agent',
  displayName: '김인턴',
  handle: 'kim-intern',
});
const HERMES = member({
  id: 'dddddddd-1111-4111-8111-dddddddddddd',
  kind: 'agent',
  displayName: '헤르메스',
  handle: 'hermes',
});
const RETIRED = member({
  id: 'eeeeeeee-1111-4111-8111-eeeeeeeeeeee',
  kind: 'agent',
  status: 'suspended',
  displayName: '옛날봇',
  handle: 'oldbot',
});

const DIRECTORY = makeDirectory([SELF, HUMAN_KIM, AGENT_KIM, HERMES, RETIRED]);

function channel(overrides: Partial<Channel> & {id: string}): Channel {
  return {workspaceId: WS, kind: 'public', muted: false, ...overrides};
}

const GENERAL = channel({id: 'ch-general', name: 'general'});
const RELEASE = channel({id: 'ch-release', name: 'release', kind: 'private', muted: true});
const DM_HUMAN_KIM = channel({
  id: 'ch-dm-human',
  kind: 'dm',
  memberIds: [SELF_ID, HUMAN_KIM.id],
});
const DM_AGENT_KIM = channel({
  id: 'ch-dm-agent',
  kind: 'dm',
  memberIds: [SELF_ID, AGENT_KIM.id],
});

function readState(overrides: Partial<ReadState> & {channelId: string}): ReadState {
  return {
    lastReadSeq: 0,
    latestSeq: 0,
    unreadCount: 0,
    mentionCount: 0,
    markedUnreadBeforeSeq: null,
    ...overrides,
  };
}

function input(overrides: Partial<SidebarInput> = {}): SidebarInput {
  return {
    groups: {channels: [GENERAL, RELEASE], dms: [DM_HUMAN_KIM, DM_AGENT_KIM]},
    agents: [AGENT_KIM, HERMES],
    directory: DIRECTORY,
    selfMemberId: SELF_ID,
    unreadByChannel: new Map(),
    openChannelId: null,
    query: '',
    ...overrides,
  };
}

function section(sections: SidebarSection[], key: string) {
  return sections.find(s => s.key === key);
}

describe('the two 김인턴 stay distinguishable', () => {
  it('carries the handle on BOTH rows, because neither name identifies one member', () => {
    const dms = section(buildSidebarSections(input()), 'dms');
    expect(dms?.data.map(row => [row.title, row.handle])).toEqual([
      ['김인턴', '@intern-kim'],
      ['김인턴', '@kim-intern'],
    ]);
  });

  it('marks the agent one as an agent', () => {
    const dms = section(buildSidebarSections(input()), 'dms');
    expect(dms?.data.map(row => row.isAgent)).toEqual([false, true]);
  });

  it('leaves the handle off a name only one member carries', () => {
    const solo = makeDirectory([SELF, HERMES]);
    const sections = buildSidebarSections(
      input({
        directory: solo,
        agents: [HERMES],
        groups: {channels: [GENERAL], dms: []},
      }),
    );
    expect(section(sections, 'agents')?.data[0]).toMatchObject({
      title: '헤르메스',
      handle: null,
    });
  });
});

describe('sections', () => {
  it('splits channels, DMs and agents', () => {
    const sections = buildSidebarSections(input());
    expect(sections.map(s => s.key)).toEqual(['channels', 'dms', 'agents']);
    expect(section(sections, 'channels')?.data.map(r => r.title)).toEqual([
      'general',
      'release',
    ]);
  });

  it('keeps the server order rather than sorting', () => {
    // There is no `lastMessageAtMs` on a channel and no activity endpoint, so a
    // "recent first" order would have to be invented. Reversing the input must
    // reverse the output.
    const sections = buildSidebarSections(
      input({groups: {channels: [RELEASE, GENERAL], dms: []}}),
    );
    expect(section(sections, 'channels')?.data.map(r => r.title)).toEqual([
      'release',
      'general',
    ]);
  });

  it('drops an empty section instead of drawing a heading over nothing', () => {
    const sections = buildSidebarSections(
      input({groups: {channels: [GENERAL], dms: []}, agents: []}),
    );
    expect(sections.map(s => s.key)).toEqual(['channels']);
  });

  it('reports a private channel and a muted one without offering a control', () => {
    const sections = buildSidebarSections(input());
    expect(section(sections, 'channels')?.data[1]).toMatchObject({
      title: 'release',
      isPrivate: true,
      muted: true,
    });
  });
});

describe('the 에이전트 section', () => {
  it('lists only agents that are not already reachable as a DM', () => {
    const sections = buildSidebarSections(input());
    // 김인턴 the agent already has a DM one section up. Listing it again would
    // make one conversation look like two.
    expect(section(sections, 'agents')?.data.map(r => r.title)).toEqual(['헤르메스']);
  });

  it('answers "already has a DM" through the core, not by handle matching', () => {
    expect(
      agentsWithoutDm([AGENT_KIM, HERMES], [DM_AGENT_KIM], DIRECTORY, SELF_ID).map(
        m => m.handle,
      ),
    ).toEqual(['hermes']);
  });

  it('targets a MEMBER id, because the DM channel may not exist yet', () => {
    const sections = buildSidebarSections(input());
    expect(section(sections, 'agents')?.data[0]?.targetId).toBe(HERMES.id);
  });
});

describe('unread counts are the server’s', () => {
  const unread = new Map([
    ['ch-general', readState({channelId: 'ch-general', unreadCount: 3, mentionCount: 1})],
  ]);

  it('renders the projection as given', () => {
    const sections = buildSidebarSections(input({unreadByChannel: unread}));
    expect(section(sections, 'channels')?.data[0]).toMatchObject({
      unreadCount: 3,
      mentionCount: 1,
    });
  });

  it('suppresses the badge on the channel being read, and only that one', () => {
    const sections = buildSidebarSections(
      input({unreadByChannel: unread, openChannelId: 'ch-general'}),
    );
    expect(section(sections, 'channels')?.data[0]).toMatchObject({
      unreadCount: 0,
      mentionCount: 0,
    });
  });

  it('matches the open channel id case-insensitively', () => {
    // Ids cross the wire in mixed case by design (Swift upper, PG lower).
    const sections = buildSidebarSections(
      input({unreadByChannel: unread, openChannelId: 'CH-GENERAL'}),
    );
    expect(section(sections, 'channels')?.data[0]?.unreadCount).toBe(0);
  });

  it('spells the counts out for VoiceOver rather than leaving a bare number', () => {
    const sections = buildSidebarSections(input({unreadByChannel: unread}));
    expect(section(sections, 'channels')?.data[0]?.accessibilityLabel).toBe(
      '채널 general, 멘션 1개, 안 읽은 메시지 3개',
    );
  });

  it('names the state of a private, muted channel', () => {
    const sections = buildSidebarSections(input());
    expect(section(sections, 'channels')?.data[1]?.accessibilityLabel).toBe(
      '채널 release, 비공개, 알림 꺼짐',
    );
  });
});

describe('search', () => {
  it('filters every section at once', () => {
    const sections = buildSidebarSections(input({query: '김인턴'}));
    expect(sections.map(s => s.key)).toEqual(['dms']);
    expect(rowCount(sections)).toBe(2);
  });

  it('matches the handle, which is how the two 김인턴 are told apart', () => {
    const sections = buildSidebarSections(input({query: 'kim-intern'}));
    expect(rowCount(sections)).toBe(1);
    expect(sections[0]?.data[0]?.handle).toBe('@kim-intern');
  });

  it('ignores case and surrounding whitespace', () => {
    expect(rowCount(buildSidebarSections(input({query: '  GENERAL '})))).toBe(1);
  });

  it('finds nothing rather than everything when nothing matches', () => {
    expect(buildSidebarSections(input({query: 'zzz'}))).toEqual([]);
  });

  it('is a substring match, so a partial name never hides its row', () => {
    expect(rowCount(buildSidebarSections(input({query: 'ener'})))).toBe(1);
  });

  it('finds an agent by the handle people address it with, even when it is not shown', () => {
    // 헤르메스 is the only member with that name, so the row renders no handle —
    // but `@hermes` is what someone types to find it. A search over the visible
    // text alone would return nothing for a row that is right there.
    const sections = buildSidebarSections(input({query: 'hermes'}));
    expect(rowCount(sections)).toBe(1);
    expect(sections[0]?.data[0]?.title).toBe('헤르메스');
  });

  it('finds a channel typed the way it is spoken, with the hash', () => {
    // The `#` is rendered beside the name rather than inside it.
    expect(rowCount(buildSidebarSections(input({query: '#general'})))).toBe(1);
  });

  it('finds a DM by the peer handle even when the label omits it', () => {
    const solo = makeDirectory([SELF, HERMES]);
    const dm = channel({
      id: 'ch-dm-hermes',
      kind: 'dm',
      memberIds: [SELF_ID, HERMES.id],
    });
    const sections = buildSidebarSections(
      input({
        directory: solo,
        agents: [],
        groups: {channels: [], dms: [dm]},
        query: '@hermes',
      }),
    );
    expect(rowCount(sections)).toBe(1);
  });

  it('shows everything for an empty query', () => {
    expect(rowCount(buildSidebarSections(input()))).toBe(5);
  });
});

import type {Channel, ReadState, RosterMember} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {
  agentsWithoutDm,
  buildSidebarSections,
  goneUnreadCandidates,
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
    // 에이전트가 앞이다(시안 A DM 섹션, DS2-3): 에이전트 김인턴의 DM · DM 없는 헤르메스 ·
    // 사람 김인턴의 DM.
    expect(dms?.data.map(row => [row.title, row.handle])).toEqual([
      ['김인턴', '@kim-intern'],
      ['헤르메스', null],
      ['김인턴', '@intern-kim'],
    ]);
  });

  it('marks the agent one as an agent', () => {
    const dms = section(buildSidebarSections(input()), 'dms');
    expect(dms?.data.map(row => row.isAgent)).toEqual([true, true, false]);
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
    expect(section(sections, 'dms')?.data[0]).toMatchObject({
      title: '헤르메스',
      handle: null,
    });
  });
});

describe('sections', () => {
  it('splits channels and DMs — the agents live in the DM section (ADR-0189 D1)', () => {
    const sections = buildSidebarSections(input());
    expect(sections.map(s => s.key)).toEqual(['channels', 'dms']);
    expect(section(sections, 'dms')?.label).toBe('DM');
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

describe('agents in the DM section', () => {
  it('lists an agent once — as its DM when one exists, as a member row otherwise', () => {
    const sections = buildSidebarSections(input());
    // 김인턴 the agent already has a DM. Listing it again as a member row would
    // make one conversation look like two.
    const agentRows = section(sections, 'dms')?.data.filter(r => r.isAgent);
    expect(agentRows?.map(r => [r.kind, r.title])).toEqual([
      ['dm', '김인턴'],
      ['agent', '헤르메스'],
    ]);
  });

  it('wears the peer (or the agent itself) as the row face', () => {
    const dms = section(buildSidebarSections(input()), 'dms');
    expect(dms?.data.map(r => r.avatarMemberId)).toEqual([
      AGENT_KIM.id,
      HERMES.id,
      HUMAN_KIM.id,
    ]);
    expect(section(buildSidebarSections(input()), 'channels')?.data[0]?.avatarMemberId).toBeNull();
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
    const hermes = section(sections, 'dms')?.data.find(r => r.kind === 'agent');
    expect(hermes?.targetId).toBe(HERMES.id);
  });
});

describe('unread counts are the server’s', () => {
  // A CONSISTENT row: cursor 0, head 3, and the server's own count agreeing.
  // Before #1964 this fixture said `unreadCount: 3` over a channel whose head was
  // seq 0 — which only passed because the row read that field straight through.
  // The count is composed now (ADR-0178 D3), so the row has to describe a
  // channel that could exist; the marked cases live in
  // `markUnreadConsumption.test.tsx`.
  const unread = new Map([
    [
      'ch-general',
      readState({
        channelId: 'ch-general',
        lastReadSeq: 0,
        latestSeq: 3,
        unreadCount: 3,
        mentionCount: 1,
      }),
    ],
  ]);

  it('renders the projection as given when nothing is marked', () => {
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

// #3675 / #3676: 서버 명부는 활성 멤버만 싣는다. 은퇴·정지된 에이전트와의 DM은 상대가
// 명부에서 빠져, 예전에는 섹션 제목과 같은 낱말 「다이렉트 메시지」가 행 이름이 됐다.
//
// #4252: 그 DM 은 안 읽은 것이 없으면 DM 섹션의 `data` 가 아니라 `tucked`(「나간 멤버와의 대화 N개」)로 간다.
// 판정은 코어 `dmHiddenAsGone` 한 함수이고 웹 사이드바와 같다.
describe('a DM whose peer left the roster', () => {
  const GONE_ID = 'ffffffff-1111-4111-8111-ffffffffffff';
  const GONE_ID_B = 'ffffffff-2222-4222-8222-ffffffffffff';
  const DM_GONE = channel({
    id: 'ch-dm-gone',
    kind: 'dm',
    memberIds: [SELF_ID, GONE_ID],
  });
  const DM_GONE_B = channel({
    id: 'ch-dm-gone-b',
    kind: 'dm',
    memberIds: [SELF_ID, GONE_ID_B],
  });
  const ROSTER_READY = makeDirectory([SELF, HUMAN_KIM]);

  function goneInput(overrides: Partial<SidebarInput> = {}): SidebarInput {
    return input({
      directory: ROSTER_READY,
      agents: [],
      groups: {channels: [], dms: [DM_HUMAN_KIM, DM_GONE]},
      ...overrides,
    });
  }

  it('is named 「나간 멤버」, never the section title', () => {
    const sections = buildSidebarSections(goneInput());
    const row = section(sections, 'dms')?.tucked?.[0];
    expect(row?.title).toBe('나간 멤버');
    expect(row?.title).not.toBe('다이렉트 메시지');
    expect(row?.isAgent).toBe(false);
    expect(row?.labelKind).toBe('gone');
  });

  it('나간 멤버 DM 은 안 읽음이 없으면 접힌다: data 에서 빠지고 tucked 로 간다', () => {
    const dms = section(buildSidebarSections(goneInput()), 'dms');
    expect(dms?.data.map(row => row.key)).toEqual(['dm:ch-dm-human']);
    expect(dms?.tucked?.map(row => row.key)).toEqual(['dm:ch-dm-gone']);
  });

  it('접힌 것도 세어진다 (rowCount 는 data 와 tucked 를 모두 센다)', () => {
    expect(rowCount(buildSidebarSections(goneInput()))).toBe(2);
  });

  it('안 읽은 메시지가 있으면 접히지 않는다', () => {
    const sections = buildSidebarSections(
      goneInput({
        unreadByChannel: new Map([
          [
            DM_GONE.id,
            readState({channelId: DM_GONE.id, lastReadSeq: 3, latestSeq: 5}),
          ],
        ]),
      }),
    );
    const dms = section(sections, 'dms');
    expect(dms?.data.map(row => row.key)).toContain('dm:ch-dm-gone');
    expect(dms?.tucked).toEqual([]);
  });

  it('멘션이 있으면 접히지 않는다', () => {
    const sections = buildSidebarSections(
      goneInput({
        unreadByChannel: new Map([
          [DM_GONE.id, readState({channelId: DM_GONE.id, mentionCount: 1})],
        ]),
      }),
    );
    expect(section(sections, 'dms')?.tucked).toEqual([]);
  });

  it('「여기부터 안 읽음」 표시도 센다 (행의 알약과 같은 합성 안 읽음이다)', () => {
    const sections = buildSidebarSections(
      goneInput({
        unreadByChannel: new Map([
          [
            DM_GONE.id,
            readState({
              channelId: DM_GONE.id,
              lastReadSeq: 5,
              latestSeq: 5,
              markedUnreadBeforeSeq: 4,
            }),
          ],
        ]),
      }),
    );
    expect(section(sections, 'dms')?.tucked).toEqual([]);
  });

  it('지금 열려 있는 나간 멤버 DM 은 접히지 않는다', () => {
    const sections = buildSidebarSections(goneInput({openChannelId: DM_GONE.id}));
    const dms = section(sections, 'dms');
    expect(dms?.data.map(row => row.key)).toContain('dm:ch-dm-gone');
    expect(dms?.tucked).toEqual([]);
  });

  it('대소문자가 다른 id 로 열려 있어도 같은 DM 이다', () => {
    const sections = buildSidebarSections(
      goneInput({openChannelId: DM_GONE.id.toUpperCase()}),
    );
    expect(section(sections, 'dms')?.tucked).toEqual([]);
  });

  it('명부를 아직 못 받았으면(빈 명부) 접지 않는다: 「불러오는 중」은 나간 멤버가 아니다', () => {
    const sections = buildSidebarSections(
      goneInput({directory: makeDirectory([])}),
    );
    const dms = section(sections, 'dms');
    expect(dms?.tucked).toEqual([]);
    expect(dms?.data.map(row => row.title)).toContain('불러오는 중');
  });

  it('명부가 한도(200)에 닿아 잘렸을 수 있으면 접지 않는다: 「없다」가 「나갔다」가 아니다', () => {
    const filler = Array.from({length: 200}, (_, n) =>
      member({
        id: `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`,
        displayName: `멤버${n}`,
        handle: `m${n}`,
      }),
    );
    const full = makeDirectory([SELF, HUMAN_KIM, ...filler]);
    const dms = section(buildSidebarSections(goneInput({directory: full})), 'dms');
    expect(dms?.tucked).toEqual([]);
    expect(dms?.data.map(row => row.title)).toContain('나간 멤버');
    // 한 명 모자라면 다 받은 것이다.
    const almost = makeDirectory([SELF, HUMAN_KIM, ...filler.slice(0, 197)]);
    expect(
      section(buildSidebarSections(goneInput({directory: almost})), 'dms')?.tucked,
    ).toHaveLength(1);
  });

  it('명부를 받지 못했다고 호출부가 말하면(rosterReady false) 이름은 「불러오는 중」이고 접지 않는다: 행 이름과 접힘이 한 답을 읽는다', () => {
    // 명부는 채워져 있어도(예: 마지막으로 받은 것) 호출부가 「못 받았다」고 하면 상대 없는 DM 은 「나간 멤버」가 아니다.
    const dms = section(buildSidebarSections(goneInput({rosterReady: false})), 'dms');
    expect(dms?.tucked).toEqual([]);
    expect(dms?.data.map(row => row.title)).toContain('불러오는 중');
    expect(dms?.data.map(row => row.title)).not.toContain('나간 멤버');
    // 받았다고 하면 같은 입력이 접힌다.
    expect(
      section(buildSidebarSections(goneInput({rosterReady: true})), 'dms')?.tucked,
    ).toHaveLength(1);
  });

  it('읽음 투영이 오는 중이면 접힌 채, 못 읽었으면 접지 않는다', () => {
    expect(
      section(buildSidebarSections(goneInput({readPhase: 'loading'})), 'dms')?.tucked,
    ).toHaveLength(1);
    expect(
      section(buildSidebarSections(goneInput({readPhase: 'error'})), 'dms')?.tucked,
    ).toEqual([]);
  });

  it('검색 중에는 접지 않는다: 이름으로 찾으면 접힌 대화도 나온다', () => {
    const sections = buildSidebarSections(goneInput({query: '나간'}));
    const dms = section(sections, 'dms');
    expect(dms?.tucked).toEqual([]);
    expect(dms?.data.map(row => row.key)).toEqual(['dm:ch-dm-gone']);
  });

  it('검색어가 없으면 접힌 대화는 목록에서 빠진 채다', () => {
    const dms = section(buildSidebarSections(goneInput({query: '  '})), 'dms');
    expect(dms?.tucked).toHaveLength(1);
  });

  it('나간 멤버 DM 만 있어도 DM 섹션은 선다 (접힌 줄의 문이 그 섹션 끝에 있다)', () => {
    const sections = buildSidebarSections(
      goneInput({groups: {channels: [], dms: [DM_GONE, DM_GONE_B]}}),
    );
    const dms = section(sections, 'dms');
    expect(dms).toBeDefined();
    expect(dms?.data).toEqual([]);
    expect(dms?.tucked?.map(row => row.key)).toEqual([
      'dm:ch-dm-gone',
      'dm:ch-dm-gone-b',
    ]);
    expect(rowCount(sections)).toBe(2);
  });

  it('상대가 명부에 있는 DM 은 안 읽음이 없어도 접히지 않는다', () => {
    const dms = section(buildSidebarSections(goneInput()), 'dms');
    expect(dms?.data.map(row => row.labelKind)).toEqual(['peer']);
  });

  it('채널 섹션에는 접힌 줄이 없다', () => {
    const channels = section(
      buildSidebarSections(goneInput({groups: {channels: [GENERAL], dms: [DM_GONE]}})),
      'channels',
    );
    expect(channels?.tucked).toEqual([]);
  });

  describe('안 읽음이 있는 나간 멤버 DM 은 그 안 읽음이 사람이 읽을 것인지의 판정을 따른다 (이슈 AC 「안 읽은 사람 메시지」)', () => {
    const UNREAD = new Map([
      [DM_GONE.id, readState({channelId: DM_GONE.id, lastReadSeq: 3, latestSeq: 8})],
    ]);
    const build = (
      verdict?: 'human' | 'ambient' | 'pending' | 'error',
      overrides: Partial<SidebarInput> = {},
    ) =>
      section(
        buildSidebarSections(
          goneInput({
            unreadByChannel: UNREAD,
            goneUnreadVerdicts:
              verdict === undefined ? undefined : new Map([[DM_GONE.id, verdict]]),
            ...overrides,
          }),
        ),
        'dms',
      );

    it('기계 메시지뿐이라고 판정되면(ambient) 안 읽음이 있어도 접힌다', () => {
      expect(build('ambient')?.tucked?.map(row => row.key)).toEqual(['dm:ch-dm-gone']);
      expect(build('ambient')?.data.map(row => row.key)).toEqual(['dm:ch-dm-human']);
    });

    it('판정이 오는 중이면(pending) 접힌 채 둔다', () => {
      expect(build('pending')?.tucked).toHaveLength(1);
    });

    it('사람이 읽을 것이 있다고 판정되면(human)·못 읽었으면(error)·판정이 없으면 접히지 않는다', () => {
      for (const verdict of ['human', 'error', undefined] as const) {
        expect({verdict, tucked: build(verdict)?.tucked}).toEqual({verdict, tucked: []});
        expect(build(verdict)?.data.map(row => row.key)).toContain('dm:ch-dm-gone');
      }
    });

    it('판정의 키는 id 의 소문자다 (대소문자가 달라도 같은 DM)', () => {
      const upper = {...DM_GONE, id: 'CH-DM-GONE'};
      const sections = buildSidebarSections(
        goneInput({
          groups: {channels: [], dms: [DM_HUMAN_KIM, upper]},
          unreadByChannel: new Map([
            ['ch-dm-gone', readState({channelId: 'ch-dm-gone', lastReadSeq: 1, latestSeq: 4})],
          ]),
          goneUnreadVerdicts: new Map([['ch-dm-gone', 'ambient']]),
        }),
      );
      expect(section(sections, 'dms')?.tucked).toHaveLength(1);
    });

    it('검색 중에는 판정과 상관없이 접지 않는다', () => {
      const dms = build('ambient', {query: '나간'});
      expect(dms?.tucked).toEqual([]);
      expect(dms?.data.map(row => row.key)).toContain('dm:ch-dm-gone');
    });
  });

  describe('goneUnreadCandidates: 안 읽음이 사람이 읽을 것인지 메시지를 읽어 가려야 하는 DM', () => {
    const cands = (
      unread: ReadState[],
      overrides: Partial<SidebarInput> = {},
    ) =>
      goneUnreadCandidates(
        goneInput({
          unreadByChannel: new Map(unread.map(state => [state.channelId, state])),
          ...overrides,
        }),
      );

    it('안 읽음이 있는 나간 멤버 DM 은 마지막으로 읽은 seq 뒤를 읽는다', () => {
      expect(
        cands([readState({channelId: DM_GONE.id, lastReadSeq: 3, latestSeq: 8})]),
      ).toEqual([{id: 'ch-dm-gone', after: 3, latest: 8}]);
    });

    it('상대가 있는 DM · 안 읽음이 없는 DM · 멘션 · 「여기부터 안 읽음」 표시는 읽지 않는다', () => {
      expect(
        cands([
          readState({channelId: DM_HUMAN_KIM.id, lastReadSeq: 1, latestSeq: 9}),
          readState({channelId: DM_GONE.id, lastReadSeq: 5, latestSeq: 5}),
        ]),
      ).toEqual([]);
      expect(
        cands([
          readState({channelId: DM_GONE.id, lastReadSeq: 3, latestSeq: 8, mentionCount: 1}),
        ]),
      ).toEqual([]);
      expect(
        cands([
          readState({
            channelId: DM_GONE.id,
            lastReadSeq: 3,
            latestSeq: 8,
            markedUnreadBeforeSeq: 2,
          }),
        ]),
      ).toEqual([]);
    });

    it('열려 있는 DM · 투영이 오는 중/못 읽음 · 명부를 못 받았을 때는 읽지 않는다', () => {
      const unread = [readState({channelId: DM_GONE.id, lastReadSeq: 3, latestSeq: 8})];
      expect(cands(unread, {openChannelId: DM_GONE.id})).toEqual([]);
      expect(cands(unread, {readPhase: 'loading'})).toEqual([]);
      expect(cands(unread, {readPhase: 'error'})).toEqual([]);
      expect(cands(unread, {rosterReady: false})).toEqual([]);
    });
  });
});

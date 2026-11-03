import type {Channel, ReadState, RosterMember} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {dmClosureMode, dmVerdicts} from '../src/features/sidebar/dmVerdicts';
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
      '#general, 멘션 1개, 새 메시지 3개',
    );
  });

  it('names the state of a private, muted channel', () => {
    const sections = buildSidebarSections(input());
    expect(section(sections, 'channels')?.data[1]?.accessibilityLabel).toBe(
      '#release, 비공개, 알림 꺼짐',
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
// #4367: 그 DM 과 내가 닫은 DM 이 목록에 서는가는 코어 `dmVisibility` 한 함수가 정하고(웹 사이드바와 같다),
// 이 파일의 `buildSidebarSections` 는 그 판정(`dmVerdicts`)을 받아 행을 거를 뿐이다. 판정 자체는 `dmVerdicts.test.ts`.
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

  const HIDDEN = new Map([[DM_GONE.id, {shown: false, rule: 6 as const}]]);

  it('is named 「나간 멤버」, never the section title', () => {
    const sections = buildSidebarSections(goneInput());
    const row = section(sections, 'dms')?.data.find(r => r.key === 'dm:ch-dm-gone');
    expect(row?.title).toBe('나간 멤버');
    expect(row?.title).not.toBe('다이렉트 메시지');
    expect(row?.title).not.toBe('DM');
    expect(row?.labelKind).toBe('gone');
  });

  it('판정이 숨김이면 행이 data 에서 빠진다 (접힌 줄·tucked 는 없다)', () => {
    const dms = section(buildSidebarSections(goneInput({dmVerdicts: HIDDEN})), 'dms');
    expect(dms?.data.map(row => row.key)).toEqual(['dm:ch-dm-human']);
    expect(dms).not.toHaveProperty('tucked');
  });

  it('판정이 없거나 id 가 없으면 보인다: 모를 때 숨기는 쪽이 최악이다', () => {
    for (const verdicts of [undefined, new Map()]) {
      const dms = section(buildSidebarSections(goneInput({dmVerdicts: verdicts})), 'dms');
      expect(dms?.data.map(row => row.key)).toContain('dm:ch-dm-gone');
    }
  });

  it('판정의 키는 id 의 소문자다 (대소문자가 달라도 같은 DM)', () => {
    const upper = {...DM_GONE, id: 'CH-DM-GONE'};
    const dms = section(
      buildSidebarSections(
        goneInput({
          groups: {channels: [], dms: [DM_HUMAN_KIM, upper]},
          dmVerdicts: new Map([['ch-dm-gone', {shown: false, rule: 7 as const}]]),
        }),
      ),
      'dms',
    );
    expect(dms?.data.map(row => row.key)).toEqual(['dm:ch-dm-human']);
  });

  it('검색 중에는 거르지 않는다: 이름으로 찾으면 숨은 대화도 나온다 (닫기는 지우기가 아니다)', () => {
    const dms = section(
      buildSidebarSections(goneInput({dmVerdicts: HIDDEN, query: '나간'})),
      'dms',
    );
    expect(dms?.data.map(row => row.key)).toEqual(['dm:ch-dm-gone']);
  });

  it('검색어가 공백뿐이면 검색이 아니다: 숨은 대화는 빠진 채다', () => {
    const dms = section(
      buildSidebarSections(goneInput({dmVerdicts: HIDDEN, query: '  '})),
      'dms',
    );
    expect(dms?.data.map(row => row.key)).toEqual(['dm:ch-dm-human']);
  });

  it('DM 이 전부 숨어도 DM 섹션은 선다: 「⋯ › 닫은 대화」의 문이 섹션 머리에 있다 (행은 0개)', () => {
    const hidden = new Map([
      [DM_GONE.id, {shown: false, rule: 6 as const}],
      [DM_GONE_B.id, {shown: false, rule: 7 as const}],
    ]);
    const sections = buildSidebarSections(
      goneInput({groups: {channels: [GENERAL], dms: [DM_GONE, DM_GONE_B]}, dmVerdicts: hidden}),
    );
    expect(sections.map(s => s.key)).toEqual(['channels', 'dms']);
    expect(section(sections, 'dms')?.data).toEqual([]);
    expect(rowCount(sections)).toBe(1);
  });

  it('숨은 DM 이 없으면 빈 DM 섹션은 서지 않는다 (제목만 남은 섹션은 「불러오지 못했다」로 읽힌다)', () => {
    const sections = buildSidebarSections(
      goneInput({groups: {channels: [GENERAL], dms: []}}),
    );
    expect(sections.map(s => s.key)).toEqual(['channels']);
  });

  it('검색 중에는 숨은 DM 뿐이어도 빈 DM 섹션을 세우지 않는다', () => {
    const sections = buildSidebarSections(
      goneInput({
        groups: {channels: [GENERAL], dms: [DM_GONE]},
        dmVerdicts: HIDDEN,
        query: 'general',
      }),
    );
    expect(sections.map(s => s.key)).toEqual(['channels']);
  });

  it('채널 행은 DM 판정과 상관없다', () => {
    const sections = buildSidebarSections(
      goneInput({
        groups: {channels: [GENERAL], dms: [DM_GONE]},
        dmVerdicts: HIDDEN,
      }),
    );
    expect(section(sections, 'channels')?.data.map(row => row.key)).toEqual(['channel:ch-general']);
  });

  describe('서버 읽음 투영에서 판정까지 (dmVerdicts → buildSidebarSections)', () => {
    // 사람 DM 하나와 에이전트 DM 하나(행 없음 = 메시지가 없는 DM, 보인다). 사람 DM 의 투영 행만 바꿔 가며 잰다.
    const build = (rows: ReadState[], overrides: Partial<SidebarInput> = {}) => {
      const byChannel = new Map(rows.map(state => [state.channelId, state]));
      const dms = [DM_HUMAN_KIM, DM_AGENT_KIM];
      return section(
        buildSidebarSections(
          input({
            agents: [],
            groups: {channels: [], dms},
            unreadByChannel: byChannel,
            dmVerdicts: dmVerdicts({
              dms,
              directory: DIRECTORY,
              selfMemberId: SELF_ID,
              byChannel,
              openChannelId: overrides.openChannelId ?? null,
              phase: 'ready',
              mode: dmClosureMode(rows),
            }),
            ...overrides,
          }),
        ),
        'dms',
      );
    };
    const keysOf = (dms: SidebarSection | undefined) => dms?.data.map(row => row.key) ?? [];

    it('내가 닫은 DM(closedAtSeq ≥ 읽을 seq)은 목록에서 사라진다', () => {
      const rows = [
        readState({channelId: DM_HUMAN_KIM.id, latestSeq: 5, lastReadSeq: 5, latestReadableSeq: 5, closedAtSeq: 5}),
      ];
      expect(keysOf(build(rows))).toEqual(['dm:ch-dm-agent']);
    });

    it('닫은 뒤 읽을 메시지가 오면 돌아온다 (되살림, 8번)', () => {
      const rows = [
        readState({channelId: DM_HUMAN_KIM.id, latestSeq: 7, lastReadSeq: 5, unreadCount: 2, latestReadableSeq: 7, closedAtSeq: 5}),
      ];
      expect(keysOf(build(rows))).toContain('dm:ch-dm-human');
    });

    it('닫은 뒤 온 것이 기계 메시지뿐이면(latestReadableSeq 가 그대로) 돌아오지 않는다', () => {
      const rows = [
        readState({channelId: DM_HUMAN_KIM.id, latestSeq: 9, lastReadSeq: 5, unreadCount: 4, latestReadableSeq: 5, closedAtSeq: 5}),
      ];
      expect(keysOf(build(rows))).toEqual(['dm:ch-dm-agent']);
    });

    it('열려 있는 DM 은 닫혀 있어도 선다 (1번)', () => {
      const rows = [
        readState({channelId: DM_HUMAN_KIM.id, latestSeq: 5, lastReadSeq: 5, latestReadableSeq: 5, closedAtSeq: 5}),
      ];
      // 에이전트 DM 이 앞이다(종류로 가르는 차례).
      expect(keysOf(build(rows, {openChannelId: DM_HUMAN_KIM.id}))).toEqual([
        'dm:ch-dm-agent',
        'dm:ch-dm-human',
      ]);
    });

    it('옛 서버의 행(closedAtSeq 를 말하지 않는다)은 보인다', () => {
      const rows = [readState({channelId: DM_HUMAN_KIM.id, latestSeq: 5, lastReadSeq: 5})];
      expect(keysOf(build(rows))).toContain('dm:ch-dm-human');
    });

    it('다른 기기에서 닫은 DM 은 다음 투영에서 사라지고, 다시 열면 돌아온다', () => {
      const open = readState({channelId: DM_HUMAN_KIM.id, latestSeq: 5, lastReadSeq: 5, latestReadableSeq: 5, closedAtSeq: null});
      const closed = {...open, closedAtSeq: 5};
      expect(keysOf(build([open]))).toContain('dm:ch-dm-human');
      expect(keysOf(build([closed]))).toEqual(['dm:ch-dm-agent']);
      expect(keysOf(build([open]))).toContain('dm:ch-dm-human');
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

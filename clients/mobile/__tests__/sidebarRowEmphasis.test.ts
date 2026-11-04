import type {Channel, ReadState, RosterMember} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {
  CHIP_COUNT_CAP,
  CHIP_TONE,
  rowEmphasis,
  type RowEmphasisInput,
} from '../src/features/sidebar/rowEmphasis';
import {
  buildSidebarSections,
  type SidebarInput,
  type SidebarRow,
  type SidebarSection,
} from '../src/features/sidebar/rows';

// =============================================================================
// 폰 홈 줄의 강조 (#4953) — 화면 없이, 판정과 그 판정이 줄에 실리는 길을 잰다.
//
// 네 상태(읽음·안 읽음·멘션·음소거)의 색·칩·숫자는 `rowEmphasis` 한 함수가 정하고, `rows.ts` 가 줄마다
// 입력(안 읽음 수·멘션 수·음소거·읽음 투영 국면·열린 줄)을 모아 `SidebarRow.emphasis` 에 싣는다. 이 파일은 그 두 곳을
// 같은 단정으로 잰다. 색 토큰 배선(회색이 정말 `textMuted` 인가)은 화면 시험(`home.test.tsx`)이 맡는다.
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
const DIRECTORY = makeDirectory([SELF, HUMAN_KIM, AGENT_KIM, HERMES]);

function channel(overrides: Partial<Channel> & {id: string}): Channel {
  return {workspaceId: WS, kind: 'public', muted: false, ...overrides};
}

const QUIET = channel({id: 'ch-quiet', name: 'quiet'});
const NEWS = channel({id: 'ch-news', name: 'news'});
const PING = channel({id: 'ch-ping', name: 'ping'});
const HUSH = channel({id: 'ch-hush', name: 'hush', muted: true});
const HUSH_PING = channel({id: 'ch-hush-ping', name: 'hush-ping', muted: true});
const HUSH_QUIET = channel({id: 'ch-hush-quiet', name: 'hush-quiet', muted: true});
const SECRET = channel({id: 'ch-secret', name: 'secret', kind: 'private', muted: true});
const DM_HUMAN = channel({id: 'ch-dm-human', kind: 'dm', memberIds: [SELF_ID, HUMAN_KIM.id]});

function readState(channelId: string, unread: number, mention = 0): [string, ReadState] {
  return [
    channelId,
    {
      channelId,
      lastReadSeq: 0,
      latestSeq: unread,
      unreadCount: unread,
      mentionCount: mention,
      markedUnreadBeforeSeq: null,
    },
  ];
}

const READS = new Map<string, ReadState>([
  readState('ch-news', 4),
  readState('ch-ping', 3, 2),
  readState('ch-hush', 5),
  readState('ch-hush-ping', 2, 1),
  readState('ch-secret', 2),
  readState('ch-dm-human', 2),
]);

function input(overrides: Partial<SidebarInput> = {}): SidebarInput {
  return {
    groups: {
      channels: [QUIET, NEWS, PING, HUSH, HUSH_PING, HUSH_QUIET, SECRET],
      dms: [DM_HUMAN],
    },
    agents: [HERMES],
    directory: DIRECTORY,
    selfMemberId: SELF_ID,
    unreadByChannel: READS,
    openChannelId: null,
    query: '',
    ...overrides,
  };
}

function rows(sections: SidebarSection[]): SidebarRow[] {
  return sections.flatMap(s => s.data);
}

function rowFor(sections: SidebarSection[], key: string): SidebarRow {
  const found = rows(sections).find(r => r.key === key);
  if (!found) throw new Error(`no row ${key}`);
  return found;
}

describe('네 상태 — 줄이 새 글에 대해 하는 말', () => {
  const sections = buildSidebarSections(input());

  it('읽음: 이름·아이콘이 회색이고 굵지 않으며 칩이 없다', () => {
    expect(rowFor(sections, 'channel:ch-quiet').emphasis).toEqual({
      dim: true,
      bold: false,
      chip: null,
    });
  });

  it('안 읽음: 본문색으로 또렷하고 굵고, 신호색 칩이 개수를 말한다', () => {
    expect(rowFor(sections, 'channel:ch-news').emphasis).toEqual({
      dim: false,
      bold: true,
      chip: {tone: CHIP_TONE.count, glyphs: '4'},
    });
  });

  it('멘션: 칩 하나가 잉크 @N 이고 일반 안 읽음 수를 이긴다 (웹 badgeFor 의 「필요 > 일반」)', () => {
    // 이 줄은 안 읽음 3 · 멘션 2 다. 칩은 `@2` 하나이고 `3` 은 칩에 오르지 않는다.
    expect(rowFor(sections, 'channel:ch-ping').emphasis).toEqual({
      dim: false,
      bold: true,
      chip: {tone: CHIP_TONE.mention, glyphs: '@2'},
    });
  });

  it('음소거: 새 글이 있어도 회색·굵지 않음, 칩은 흐린 모양이고 숫자는 그대로다', () => {
    expect(rowFor(sections, 'channel:ch-hush').emphasis).toEqual({
      dim: true,
      bold: false,
      chip: {tone: CHIP_TONE.muted, glyphs: '5'},
    });
    // 음소거한 줄의 멘션도 흐린 칩이다. 숫자 앞의 @ 로 멘션임은 남는다.
    expect(rowFor(sections, 'channel:ch-hush-ping').emphasis).toEqual({
      dim: true,
      bold: false,
      chip: {tone: CHIP_TONE.muted, glyphs: '@1'},
    });
    // 새 글이 없는 음소거 줄은 칩 없이 회색이다.
    expect(rowFor(sections, 'channel:ch-hush-quiet').emphasis).toEqual({
      dim: true,
      bold: false,
      chip: null,
    });
  });

  it('칩 숫자는 99 에서 멈춘다: 99 는 그대로, 100 부터 99+ (멘션은 @99+)', () => {
    const base: RowEmphasisInput = {
      unreadCount: 0,
      mentionCount: 0,
      muted: false,
      tracksRead: true,
      mayDim: true,
      selected: false,
    };
    expect(CHIP_COUNT_CAP).toBe(99);
    expect(rowEmphasis({...base, unreadCount: 99}).chip?.glyphs).toBe('99');
    expect(rowEmphasis({...base, unreadCount: 100}).chip?.glyphs).toBe('99+');
    expect(rowEmphasis({...base, unreadCount: 250, mentionCount: 120}).chip?.glyphs).toBe('@99+');
    // 쓰레기 입력은 새 글이 아니다: 음수·NaN 이 칩이나 굵기를 만들지 않는다.
    expect(rowEmphasis({...base, unreadCount: -3, mentionCount: Number.NaN})).toEqual({
      dim: true,
      bold: false,
      chip: null,
    });
  });
});

describe('DM 줄은 같은 문법이고, 에이전트 줄은 말하지 않는다', () => {
  const sections = buildSidebarSections(input());

  it('안 읽은 DM 은 채널과 같은 칩·굵기이고, 읽은 DM 이면 회색이다', () => {
    expect(rowFor(sections, 'dm:ch-dm-human').emphasis).toEqual({
      dim: false,
      bold: true,
      chip: {tone: CHIP_TONE.count, glyphs: '2'},
    });
    const read = buildSidebarSections(input({unreadByChannel: new Map()}));
    expect(rowFor(read, 'dm:ch-dm-human').emphasis).toEqual({dim: true, bold: false, chip: null});
  });

  it('아직 DM 이 없는 에이전트 줄은 갈 곳이라 회색도 굵기도 칩도 없다', () => {
    const agent = rowFor(sections, `agent:${HERMES.id}`);
    expect(agent.kind).toBe('agent');
    expect(agent.emphasis).toEqual({dim: false, bold: false, chip: null});
  });
});

describe('회색은 「새 글 없음」을 말하므로, 모를 때는 칠하지 않는다', () => {
  it('읽음 투영이 실패하면(error) 새 글 없는 줄도 회색이 아니다 — 다 읽었다는 거짓을 만들지 않는다', () => {
    const failed = buildSidebarSections(input({unreadByChannel: new Map(), readPhase: 'error'}));
    expect(rowFor(failed, 'channel:ch-quiet').emphasis).toEqual({
      dim: false,
      bold: false,
      chip: null,
    });
    expect(rowFor(failed, 'dm:ch-dm-human').emphasis.dim).toBe(false);
    // 음소거는 읽음 투영이 아니라 채널이 말하는 사실이라 투영이 실패해도 회색이다.
    expect(rowFor(failed, 'channel:ch-hush-quiet').emphasis.dim).toBe(true);
  });

  it('오는 중(loading)은 조용한 쪽이다 — 읽은 줄이 두 번 색을 바꾸지 않는다', () => {
    const loading = buildSidebarSections(input({unreadByChannel: new Map(), readPhase: 'loading'}));
    expect(rowFor(loading, 'channel:ch-quiet').emphasis.dim).toBe(true);
    // 받은 뒤(ready)와 같은 답이다.
    const ready = buildSidebarSections(input({unreadByChannel: new Map(), readPhase: 'ready'}));
    expect(rowFor(ready, 'channel:ch-quiet').emphasis.dim).toBe(true);
  });

  it('지금 열려 있는 줄은 읽음이든 음소거든 회색이 아니다 (보고 있는 대화가 흐려지면 오류처럼 읽힌다)', () => {
    const open = buildSidebarSections(input({openChannelId: 'ch-quiet'}));
    expect(rowFor(open, 'channel:ch-quiet').emphasis.dim).toBe(false);
    const openMuted = buildSidebarSections(input({openChannelId: 'CH-HUSH'}));
    // 열린 줄의 안 읽음은 이미 0 으로 접혀 있어 칩도 굵기도 없다. 색만 본문색이다.
    expect(rowFor(openMuted, 'channel:ch-hush').emphasis).toEqual({
      dim: false,
      bold: false,
      chip: null,
    });
    // 다른 줄은 영향을 받지 않는다.
    expect(rowFor(openMuted, 'channel:ch-quiet').emphasis.dim).toBe(true);
  });
});

describe('VoiceOver — 「#일반, 새 메시지 3개」', () => {
  const sections = buildSidebarSections(input());

  it('채널은 #이름 으로 시작하고 새 글은 「새 메시지 N개」로 읽는다', () => {
    expect(rowFor(sections, 'channel:ch-news').accessibilityLabel).toBe('#news, 새 메시지 4개');
    expect(rowFor(sections, 'channel:ch-quiet').accessibilityLabel).toBe('#quiet');
  });

  it('멘션이 있으면 멘션 수가 먼저고, 비공개·알림 꺼짐도 낭독에 남는다 (아이콘은 소리가 없다)', () => {
    expect(rowFor(sections, 'channel:ch-ping').accessibilityLabel).toBe(
      '#ping, 멘션 2개, 새 메시지 3개',
    );
    expect(rowFor(sections, 'channel:ch-secret').accessibilityLabel).toBe(
      '#secret, 비공개, 알림 꺼짐, 새 메시지 2개',
    );
  });

  it('DM 은 # 를 달지 않는다 — 같은 「새 메시지」 낱말을 쓴다', () => {
    const label = rowFor(sections, 'dm:ch-dm-human').accessibilityLabel;
    expect(label).toBe('다이렉트 메시지 김인턴, @intern-kim, 새 메시지 2개');
    expect(label.startsWith('#')).toBe(false);
  });
});

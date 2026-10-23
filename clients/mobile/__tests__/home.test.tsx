import type {Channel, Member} from '@momo/core/lib/api';
import {contrast} from '@momo/core/design/color';
import type {AgentWorkingSignal} from '@momo/core/features/agents/workingSignal';
import {TURN_STALE_SENTENCE} from '@momo/core/features/agents/turnCopy';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react-native';
import React from 'react';
import {AccessibilityInfo, ActionSheetIOS, SectionList, StyleSheet} from 'react-native';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {darkPalette, lightPalette} from '../src/design/tokens';
import {
  markAgentWorking,
  resetAgentWorking,
} from '../src/features/agents/workingSignal';
import {parseCollapsed, visibleRows} from '../src/features/home/collapsedSections';
import {workspaceKeys} from '../src/features/workspace/queries';
import {buildWorkingCard, workingStep} from '../src/features/home/workingCard';
import {
  isWorkspaceAvatarPath,
  workspaceHeading,
} from '../src/features/home/workspaceLogo';
import type {SidebarRow, SidebarSection} from '../src/features/sidebar/rows';
import {
  AGENT_LIST_ACTION,
  CTL_SLOP_DOWN,
  CTL_SLOP_MORE,
  FILTER_ACTION,
  HOME,
  WorkingCard,
} from '../src/screens/SidebarScreen';
import SidebarScreen from '../src/screens/SidebarScreen';
import {SessionProvider} from '../src/session/useSession';
import AppShell from '../src/shell/AppShell';
import {NON_SECRET_KEYS} from '../src/storage/kv';
import {__resetSessionStore, sessionPort} from '../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';

// =============================================================================
// DS2-3 폰 홈 (#2715, ADR-0189 D1) — 시안 A `#a-home`.
//
// 세 부분을 잰다: 「작업 중」 카드의 순수 판정(`workingCard`), 머리의 로고·제목 판정
// (`workspaceLogo`), 섹션 접기(`collapsedSections`) — 그리고 그것들이 배송되는 셸
// 안에서 실제로 서는지.
// =============================================================================

const WS = '22222222-2222-4222-8222-222222222222';
const SELF_ID = '11111111-1111-4111-8111-111111111111';
const AGENT_ID = 'cccccccc-1111-4111-8111-cccccccccccc';
const HERMES_ID = 'dddddddd-1111-4111-8111-dddddddddddd';
const HUMAN_ID = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
const BASE = 'https://api.example.com';

const SELF: Member = {
  id: SELF_ID,
  workspaceId: WS,
  kind: 'human',
  displayName: '곽성재',
  handle: 'seongjae',
};

function rosterMember(over: Record<string, unknown>) {
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
    ...over,
  };
}

const ROSTER = [
  rosterMember({id: SELF_ID, displayName: '곽성재', handle: 'seongjae'}),
  rosterMember({id: HUMAN_ID, displayName: '박세은', handle: 'seeun'}),
  rosterMember({id: AGENT_ID, kind: 'agent', displayName: '김인턴', handle: 'kim-intern'}),
  rosterMember({id: HERMES_ID, kind: 'agent', displayName: '헤르메스', handle: 'hermes'}),
];

const CHANNELS = [
  {id: 'ch-agent-lab', workspaceId: WS, kind: 'public', name: 'agent-lab', muted: false},
  {id: 'ch-general', workspaceId: WS, kind: 'public', name: 'general', muted: false},
  {id: 'ch-design', workspaceId: WS, kind: 'private', name: 'design-2.0', muted: false},
  {
    id: 'ch-dm-agent',
    workspaceId: WS,
    kind: 'dm',
    muted: false,
    memberIds: [SELF_ID, AGENT_ID],
  },
  {
    id: 'ch-dm-human',
    workspaceId: WS,
    kind: 'dm',
    muted: false,
    memberIds: [SELF_ID, HUMAN_ID],
  },
];

const READ_STATES = [
  {channel_id: 'ch-agent-lab', last_read_seq: 10, latest_seq: 12, unread_count: 2, mention_count: 2},
  {channel_id: 'ch-general', last_read_seq: 10, latest_seq: 15, unread_count: 5, mention_count: 0},
  {channel_id: 'ch-dm-agent', last_read_seq: 1, latest_seq: 2, unread_count: 1, mention_count: 0},
];

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

interface Routes {
  roster?: unknown[];
  channels?: unknown[];
  /** 서버 읽음 투영의 행(와이어 형상). 생략하면 기본 `READ_STATES`. */
  readStates?: unknown[];
  workspace?: () => Response | Promise<Response>;
  /**
   * 에이전트 생존 판정(#3964): id → 상태. 적지 않은 에이전트는 404 다(= 「라벨 없음」, 호스티드가 아님).
   * `'pending'` 은 응답이 오지 않는다(아직 모름).
   */
  liveness?: Record<string, string>;
  /**
   * 메시지 쪽의 응답(와이어 형상). 생략하면 빈 쪽이다. 나간 멤버 DM 의 안 읽음이 사람이 읽을 것인지 가르는 쪽(#4252)이 이
   * 길로 읽는다. `'fail'` 은 500, `'pending'` 은 응답이 오지 않는다.
   */
  messages?: unknown[] | 'fail' | 'pending';
}

function installFetch(routes: Routes = {}): jest.Mock {
  const mock = jest.fn(async (url: string) => {
    const liveness = /\/agents\/([^/]+)\/liveness$/.exec(url);
    if (liveness) {
      const state = routes.liveness?.[liveness[1].toLowerCase()];
      if (state === 'pending') return new Promise<Response>(() => {});
      if (state === undefined) return jsonResponse(404, {error: {message: 'not found'}});
      return jsonResponse(200, {agentMemberId: liveness[1], state});
    }
    if (url.includes('/reactions')) return jsonResponse(200, {});
    if (url.includes('/channels') && !url.includes('/messages')) {
      return jsonResponse(200, {channels: routes.channels ?? CHANNELS});
    }
    if (url.includes('/roster')) {
      return jsonResponse(200, {members: routes.roster ?? ROSTER});
    }
    if (url.includes('/read-state')) {
      return jsonResponse(200, {read_states: routes.readStates ?? READ_STATES});
    }
    if (url.includes('/messages')) {
      if (routes.messages === 'pending') return new Promise<Response>(() => {});
      if (routes.messages === 'fail') return jsonResponse(500, {error: {message: 'boom'}});
      return jsonResponse(200, {messages: routes.messages ?? []});
    }
    if (url.includes('/approvals')) return jsonResponse(200, {approvals: []});
    if (url.includes('/work-sessions')) return jsonResponse(200, {sessions: []});
    if (url.includes('/dms')) {
      return jsonResponse(200, {
        channel: {
          id: 'ch-dm-hermes',
          workspaceId: WS,
          kind: 'dm',
          muted: false,
          memberIds: [SELF_ID, HERMES_ID],
        },
        created: true,
      });
    }
    if (/\/v1\/workspaces\/[^/]+$/.test(url)) {
      return routes.workspace
        ? routes.workspace()
        : jsonResponse(200, {
            workspace: {id: WS, slug: 'yeomyeong', name: '여명거리', updatedAtMs: 0},
          });
    }
    return jsonResponse(200, {});
  });
  globalThis.fetch = mock as unknown as typeof fetch;
  return mock;
}

let queryClient: QueryClient | null = null;

function renderShell() {
  queryClient = new QueryClient({
    defaultOptions: {
      queries: {retry: false, gcTime: 0},
      mutations: {retry: false, gcTime: 0},
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AppShell member={SELF} />
    </QueryClientProvider>,
  );
}

const mmkvStore = (
  jest.requireMock('react-native-mmkv') as {__store: Map<string, string>}
).__store;

const LOGIN_BODY = {
  accessToken: 'access-token-1',
  refreshToken: 'refresh-token-1',
  realtimeWebSocketUrl: 'wss://api.example.com/connection/websocket',
  member: SELF,
};

beforeEach(() => {
  mmkvStore.clear();
  __resetSessionStore();
  __resetServerBaseCache();
  setServerBase(BASE);
  sessionPort.applyLogin(LOGIN_BODY);
  resetAgentWorking();
});

afterEach(() => {
  cleanup();
  queryClient?.clear();
  queryClient = null;
  resetAgentWorking();
  jest.restoreAllMocks();
});

function signal(over: Partial<AgentWorkingSignal> = {}): AgentWorkingSignal {
  return {
    memberId: AGENT_ID,
    channelId: 'ch-agent-lab',
    state: 'working',
    source: 'run',
    startedAtMs: Date.now() - 30_000,
    headlines: ['푸시 중복 수정 PR 초안 작성 중'],
    lastActivityAtMs: Date.now(),
    ...over,
  };
}

function keyed(...signals: AgentWorkingSignal[]): Map<string, AgentWorkingSignal> {
  return new Map(
    signals.map(s => [`${s.channelId.toLowerCase()}|${s.memberId.toLowerCase()}`, s]),
  );
}

const DIRECTORY = makeDirectory(ROSTER as never);
const CHANNEL_LIST = CHANNELS as unknown as Channel[];

function card(signals: Map<string, AgentWorkingSignal>, live = true) {
  return buildWorkingCard({
    signals,
    nowMs: Date.now(),
    directory: DIRECTORY,
    channels: CHANNEL_LIST,
    selfMemberId: SELF_ID,
    live,
  });
}

// ---- 1. 「작업 중」 카드의 판정 ---------------------------------------------------

describe('「작업 중」 카드 — 판정', () => {
  it('열린 턴이 없으면 카드가 없다', () => {
    expect(card(new Map())).toBeNull();
  });

  it('90초 넘게 조용한 턴은 카드가 되지 않는다 (코어 TTL)', () => {
    expect(card(keyed(signal({lastActivityAtMs: Date.now() - 91_000})))).toBeNull();
  });

  it('시안의 한 장: 이름 · #채널 · 한 줄 · 작업 중', () => {
    expect(card(keyed(signal()))).toMatchObject({
      name: '김인턴',
      place: '#agent-lab',
      headline: '푸시 중복 수정 PR 초안 작성 중',
      liveText: '작업 중',
      step: 2,
      others: 0,
    });
  });

  it('세 칸은 관찰한 단계다 — 막 열린 턴은 한 칸, 글을 내면 두 칸, 결정 대기는 세 칸', () => {
    expect(workingStep(signal({headlines: []}))).toBe(1);
    expect(workingStep(signal())).toBe(2);
    expect(workingStep(signal({state: 'awaiting_approval'}))).toBe(3);
  });

  it('승인 대기는 결코 「작업 중」이라고 말하지 않는다', () => {
    const model = card(keyed(signal({state: 'awaiting_approval'})));
    expect(model?.liveText).toBe('승인 대기');
    expect(model?.accessibilityLabel).not.toMatch(/작업 중/);
  });

  it('가장 오래된 턴을 보이고 나머지는 센다', () => {
    const model = card(
      keyed(
        signal({memberId: HERMES_ID, channelId: 'ch-general', startedAtMs: Date.now() - 5_000}),
        signal({startedAtMs: Date.now() - 60_000}),
      ),
    );
    expect(model?.name).toBe('김인턴');
    expect(model?.others).toBe(1);
  });

  it('DM 에서 열린 턴은 # 없이 상대 이름으로 선다', () => {
    expect(card(keyed(signal({channelId: 'ch-dm-agent'})))?.place).toBe('김인턴');
  });

  it('레일이 끊겼으면 낭독 문장이 그렇다고 말한다', () => {
    expect(card(keyed(signal()), false)?.accessibilityLabel).toContain(TURN_STALE_SENTENCE);
  });
});

// ---- 2. 머리의 로고 자리와 큰 제목 ---------------------------------------------

describe('머리 — 로고 자리와 큰 제목', () => {
  it('이름이 오기 전에는 아무것도 그리지 않는다', () => {
    expect(workspaceHeading({isPending: true, isError: false})).toEqual({
      logo: {kind: 'pending'},
      title: '',
      accessibilityLabel: '워크스페이스 불러오는 중',
    });
  });

  it('아바타가 없으면 브랜드 배지, 제목은 워크스페이스 이름', () => {
    expect(workspaceHeading({name: '여명거리', isPending: false, isError: false})).toMatchObject({
      logo: {kind: 'brand'},
      title: '여명거리',
    });
  });

  it('서버가 준 아바타 경로만 그림으로 받는다', () => {
    const path = `/v1/workspaces/${WS}/avatar/content?v=abc`;
    expect(
      workspaceHeading({name: '여명거리', avatarUrl: path, isPending: false, isError: false})
        .logo,
    ).toEqual({kind: 'avatar', path});
    expect(isWorkspaceAvatarPath('https://evil.example/x.png')).toBe(false);
    expect(
      workspaceHeading({
        name: '여명거리',
        avatarUrl: '/v1/other',
        isPending: false,
        isError: false,
      }).logo,
    ).toEqual({kind: 'brand'});
  });

  it('실패하면 사람 이름을 빌리지 않고 「워크스페이스」로 선다', () => {
    expect(workspaceHeading({isPending: false, isError: true}).title).toBe('워크스페이스');
  });
});

// ---- 3. 섹션 접기 -------------------------------------------------------------

function row(over: Partial<SidebarRow>): SidebarRow {
  return {
    key: 'channel:x',
    kind: 'channel',
    targetId: 'x',
    title: 'x',
    handle: null,
    avatarMemberId: null,
    isAgent: false,
    labelKind: 'channel',
    isPrivate: false,
    muted: false,
    unreadCount: 0,
    mentionCount: 0,
    accessibilityLabel: 'x',
    searchText: 'x',
    ...over,
  };
}

describe('섹션 접기', () => {
  const section: SidebarSection = {
    key: 'channels',
    label: '채널',
    data: [
      row({key: 'a', targetId: 'a', unreadCount: 3}),
      row({key: 'b', targetId: 'b'}),
      row({key: 'c', targetId: 'c', mentionCount: 1}),
      row({key: 'd', targetId: 'd'}),
    ],
  };

  it('접힌 섹션은 안 읽음·멘션·열린 행만 남긴다', () => {
    expect(visibleRows(section, true, r => r.key === 'd').map(r => r.key)).toEqual([
      'a',
      'c',
      'd',
    ]);
    expect(visibleRows(section, false, () => false)).toHaveLength(4);
  });

  it('망가진 저장값은 펼침으로 읽는다', () => {
    expect(parseCollapsed('{')).toEqual({});
    expect(parseCollapsed('[1]')).toEqual({});
    expect(parseCollapsed(JSON.stringify({[WS]: ['dms', 'nope']}))).toEqual({[WS]: ['dms']});
  });
});

// ---- 4. 배송되는 셸 안에서 --------------------------------------------------------

async function mountHome(routes: Routes = {}) {
  const fetchMock = installFetch(routes);
  renderShell();
  await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy());
  return fetchMock;
}

function flat(style: unknown): Record<string, unknown> {
  return (StyleSheet.flatten(style as never) ?? {}) as Record<string, unknown>;
}

describe('홈 — 머리', () => {
  it('큰 제목은 워크스페이스 이름이고 30/700 이다', async () => {
    await mountHome();
    await waitFor(() => expect(screen.getByTestId('home-title')).toHaveTextContent('여명거리'));
    const title = flat(screen.getByTestId('home-title').props.style);
    expect(title.fontSize).toBe(30);
    expect(title.fontWeight).toBe('700');
    // 로고는 보조기술에서 숨는다(옆의 제목이 이름을 말한다) — 그래서 숨은 원소까지 찾는다.
    expect(
      screen.getByTestId('home-logo-brand', {includeHiddenElements: true}),
    ).toBeTruthy();
    expect(
      flat(screen.getByTestId('home-logo-brand', {includeHiddenElements: true}).props.style),
    ).toMatchObject({width: HOME.logo, height: HOME.logo, borderRadius: HOME.logo / 2});
    // 계정 문은 그대로 머리 오른쪽에 있다(#2702).
    expect(screen.getByTestId('profile-avatar').props.accessibilityLabel).toBe(
      '내 프로필, 곽성재',
    );
  });

  it('머리에 사람의 이름을 빌리지 않는다 — 조회가 실패해도', async () => {
    await mountHome({workspace: () => jsonResponse(500, {error: {message: 'x'}})});
    await waitFor(() =>
      expect(screen.getByTestId('home-title')).toHaveTextContent('워크스페이스'),
    );
    expect(screen.getByTestId('home-title')).not.toHaveTextContent(/곽성재/);
  });

  it('이름을 기다리는 동안에도 사람 이름으로 채우지 않는다 — 빈 제목, 빈 로고 원', async () => {
    await mountHome({workspace: () => new Promise<Response>(() => {})});
    expect(screen.getByTestId('home-title')).toHaveTextContent('');
    expect(screen.getByTestId('home-title').props.accessibilityLabel).toBe(
      '워크스페이스 불러오는 중',
    );
    expect(
      screen.getByTestId('home-logo-pending', {includeHiddenElements: true}),
    ).toBeTruthy();
  });
});

describe('홈 — 섹션과 행', () => {
  it('채널과 DM 두 섹션, 그 사이에 구분선 하나', async () => {
    await mountHome();
    expect(screen.getByTestId('home-section-channels')).toHaveTextContent('채널');
    expect(screen.getByTestId('home-section-dms')).toHaveTextContent('DM');
    expect(screen.getAllByTestId('home-divider')).toHaveLength(1);
    expect(screen.queryByText('에이전트', {exact: true})).toBeNull();
  });

  it('비공개 채널은 자물쇠, 공개는 #', async () => {
    await mountHome();
    expect(
      within(screen.getByTestId('sidebar-row-channel:ch-design')).getByTestId('home-row-lock'),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId('sidebar-row-channel:ch-general')).getByTestId('home-row-hash'),
    ).toBeTruthy();
  });

  it('멘션은 잉크 @N, 안 읽음은 신호색 N — 이름은 굵다', async () => {
    await mountHome();
    await waitFor(() =>
      expect(
        within(screen.getByTestId('sidebar-row-channel:ch-agent-lab')).getByTestId(
          'home-badge-mention',
        ),
      ).toHaveTextContent('@2'),
    );
    const mention = within(screen.getByTestId('sidebar-row-channel:ch-agent-lab')).getByTestId(
      'home-badge-mention',
    );
    // 멘션 배지는 잉크(primary), 안 읽음은 신호(accent). 스킴과 무관하게 두 역할이 갈린다.
    const mentionBg = flat(mention.props.style).backgroundColor;
    expect([lightPalette.primary, darkPalette.primary]).toContain(mentionBg);
    const unread = within(screen.getByTestId('sidebar-row-channel:ch-general')).getByTestId(
      'home-badge-unread',
    );
    expect(unread).toHaveTextContent('5');
    expect([lightPalette.accent, darkPalette.accent]).toContain(
      flat(unread.props.style).backgroundColor,
    );
    expect(screen.getByText('general').props.style).toEqual(
      expect.arrayContaining([expect.objectContaining({fontWeight: '700'})]),
    );
    expect(screen.getByText('design-2.0').props.style).not.toEqual(
      expect.arrayContaining([expect.objectContaining({fontWeight: '700'})]),
    );
  });

  it('사진이 있는 에이전트의 DM 줄은 그 사진을 싣는다 (로봇 아님)', async () => {
    const photo = 'data:image/png;base64,iVBORw0KGgo=';
    await mountHome({
      roster: ROSTER.map(m => ((m as {id?: string}).id === AGENT_ID ? {...m, avatarUrl: photo} : m)),
    });
    const agentRow = screen.getByTestId('sidebar-row-dm:ch-dm-agent');
    const image = await waitFor(() =>
      within(agentRow).getByTestId('avatar-image', {includeHiddenElements: true}),
    );
    expect(image.props.source).toEqual({uri: photo});
    expect(
      within(agentRow).queryByTestId('home-agent-square', {includeHiddenElements: true}),
    ).toBeNull();
  });

  it('DM 섹션의 에이전트는 로봇이 아니라 에이전트 목록과 같은 아바타(둥근 사각)이고 사람보다 앞이다', async () => {
    await mountHome();
    const dm = screen.getByTestId('home-section-dms');
    expect(dm).toBeTruthy();
    const agentRow = screen.getByTestId('sidebar-row-dm:ch-dm-agent');
    // 예전에는 `isAgent` 가 먼저 걸려 사진이 있는 에이전트도 로봇 사각이었다.
    expect(
      within(agentRow).queryByTestId('home-agent-square', {includeHiddenElements: true}),
    ).toBeNull();
    const face = within(agentRow).getByTestId('avatar-agent', {includeHiddenElements: true});
    expect(flat(face.props.style)).toMatchObject({
      width: HOME.rowFace,
      height: HOME.rowFace,
    });
    // 사진이 없으면 이니셜이 선다(에이전트 목록 줄과 같은 규칙).
    expect(within(agentRow).getByTestId('avatar-initial', {includeHiddenElements: true})).toBeTruthy();
    // DM 없는 에이전트도 같은 섹션의 행이다.
    expect(screen.getByTestId(`sidebar-row-agent:${HERMES_ID}`)).toBeTruthy();
    const humanRow = screen.getByTestId('sidebar-row-dm:ch-dm-human');
    expect(
      within(humanRow).queryByTestId('home-agent-square', {includeHiddenElements: true}),
    ).toBeNull();
    // DM 없는 에이전트 줄도 같은 아바타다.
    expect(
      within(screen.getByTestId(`sidebar-row-agent:${HERMES_ID}`)).getByTestId('avatar-agent', {
        includeHiddenElements: true,
      }),
    ).toBeTruthy();
    const order = screen
      .getAllByTestId(/^sidebar-row-(dm|agent):/)
      .map(node => node.props.testID);
    expect(order).toEqual([
      'sidebar-row-dm:ch-dm-agent',
      `sidebar-row-agent:${HERMES_ID}`,
      'sidebar-row-dm:ch-dm-human',
    ]);
  });

  it('행은 시안의 46 을 바닥으로 갖는다 (고정 높이가 아니다 — 큰 글씨에서 자란다)', async () => {
    await mountHome();
    const style = flat(
      screen.getByTestId('sidebar-row-channel:ch-general').props.style,
    );
    expect(style.minHeight).toBe(46);
    expect(style.height).toBeUndefined();
    expect(style.borderRadius).toBe(14);
  });
});

describe('홈 — DM 줄의 상태 점 (#3964)', () => {
  const dotOf = (rowKey: string) =>
    within(screen.getByTestId(`sidebar-row-${rowKey}`)).queryByTestId('home-row-status-dot', {
      includeHiddenElements: true,
    });
  const bg = (node: {props: {style?: unknown}}) => flat(node.props.style).backgroundColor;
  const border = (node: {props: {style?: unknown}}) => flat(node.props.style).borderColor;
  const asRoster = (over: Record<string, Record<string, unknown>>) =>
    ROSTER.map(m => ({...m, ...(over[String((m as Record<string, unknown>).id)] ?? {})}));

  it('채널 줄에는 점이 없다', async () => {
    await mountHome();
    expect(dotOf('channel:ch-general')).toBeNull();
    expect(dotOf('channel:ch-agent-lab')).toBeNull();
  });

  it('사람: 자리 비움은 주황 점', async () => {
    await mountHome({roster: asRoster({[HUMAN_ID]: {presenceStatus: 'away'}})});
    const away = await waitFor(() => {
      const node = dotOf('dm:ch-dm-human');
      expect(node).toBeTruthy();
      return node!;
    });
    expect([lightPalette.warn, darkPalette.warn]).toContain(bg(away));
  });

  it('사람: 방해 금지는 빨강 점', async () => {
    await mountHome({roster: asRoster({[HUMAN_ID]: {presenceStatus: 'dnd'}})});
    const dnd = await waitFor(() => {
      const node = dotOf('dm:ch-dm-human');
      expect(node).toBeTruthy();
      return node!;
    });
    expect([lightPalette.danger, darkPalette.danger]).toContain(bg(dnd));
  });

  it('사람: 평소(auto)에는 점이 없다 — 근거 없는 온라인·회색 오프라인 점 금지', async () => {
    await mountHome({roster: asRoster({[HUMAN_ID]: {presenceStatus: 'auto'}})});
    await waitFor(() => expect(screen.getByTestId('sidebar-row-dm:ch-dm-human')).toBeTruthy());
    expect(dotOf('dm:ch-dm-human')).toBeNull();
  });

  it('에이전트: 생존 판정이 점이 된다 — 응답함·살아 있음은 채운 초록, 꺼짐은 속이 빈 회색 고리 (Buzz식, 소유자 결정 2026-10-17)', async () => {
    const THIRD = 'eeeeeeee-1111-4111-8111-eeeeeeeeeeee';
    await mountHome({
      roster: [
        ...ROSTER,
        {...rosterMember({id: THIRD, kind: 'agent', displayName: '코비', handle: 'coby'})},
      ],
      channels: [
        ...CHANNELS,
        {id: 'ch-dm-coby', workspaceId: WS, kind: 'dm', muted: false, memberIds: [SELF_ID, THIRD]},
      ],
      liveness: {[AGENT_ID]: 'responsive', [HERMES_ID]: 'alive_idle', [THIRD]: 'inactive'},
    });
    const live = await waitFor(() => {
      const node = dotOf('dm:ch-dm-agent');
      expect(node).toBeTruthy();
      return node!;
    });
    expect([lightPalette.ok, darkPalette.ok]).toContain(bg(live));
    // 살아 있음·대기(신호는 오는데 일이 없다)도 채운 초록이다. 응답함과의 차이는 낱말(낭독 라벨·툴팁)이 말한다.
    const alive = await waitFor(() => {
      const node = dotOf(`agent:${HERMES_ID}`);
      expect(node).toBeTruthy();
      return node!;
    });
    expect([lightPalette.ok, darkPalette.ok]).toContain(bg(alive));
    expect(bg(alive)).toBe(bg(live));
    // 꺼짐: 속이 빈 고리. 면 채움 + 선 색(textFaint) 둘레. 채운 점과도, 아무것도 없는 것과도 다르다(#3964 H1).
    const off = await waitFor(() => {
      const node = dotOf('dm:ch-dm-coby');
      expect(node).toBeTruthy();
      return node!;
    });
    expect([lightPalette.surface, darkPalette.surface]).toContain(bg(off));
    expect([lightPalette.textFaint, darkPalette.textFaint]).toContain(border(off));
    expect(bg(alive)).not.toBe(bg(off));
  });

  it('글자 라벨(「꺼짐」)은 줄에 없고 낭독 라벨에 있다', async () => {
    await mountHome({liveness: {[AGENT_ID]: 'inactive'}});
    const agentRow = await waitFor(() => {
      const node = screen.getByTestId('sidebar-row-dm:ch-dm-agent');
      expect(dotOf('dm:ch-dm-agent')).toBeTruthy();
      return node;
    });
    expect(within(agentRow).queryByText(/꺼짐|연결이 꺼져 있어요/)).toBeNull();
    expect(agentRow.props.accessibilityLabel).toContain('김인턴');
    expect(agentRow.props.accessibilityLabel).toMatch(/, 연결이 꺼져 있어요$/);
  });

  it('사람 줄의 낭독 라벨도 상태를 잇는다', async () => {
    await mountHome({roster: asRoster({[HUMAN_ID]: {presenceStatus: 'away'}})});
    await waitFor(() => expect(dotOf('dm:ch-dm-human')).toBeTruthy());
    expect(screen.getByTestId('sidebar-row-dm:ch-dm-human').props.accessibilityLabel).toMatch(
      /, 자리 비움$/,
    );
  });

  it('판정을 아직 모르는 동안은 점이 없다 — 호스트 연결 폴백을 먼저 그려 거짓을 한 번 그리지 않는다', async () => {
    await mountHome({
      roster: asRoster({[AGENT_ID]: {hostOnline: true}}),
      liveness: {[AGENT_ID]: 'pending'},
    });
    await waitFor(() => expect(screen.getByTestId('sidebar-row-dm:ch-dm-agent')).toBeTruthy());
    expect(dotOf('dm:ch-dm-agent')).toBeNull();
  });

  it('판정이 없다고 확정되면(404) 호스트 연결만으로: 닿아 있을 때만 초록 점', async () => {
    await mountHome({roster: asRoster({[AGENT_ID]: {hostOnline: true}})});
    const node = await waitFor(() => {
      const found = dotOf('dm:ch-dm-agent');
      expect(found).toBeTruthy();
      return found!;
    });
    expect([lightPalette.ok, darkPalette.ok]).toContain(bg(node));
    // 닿아 있지 않은 에이전트(헤르메스)에는 점이 없다.
    expect(dotOf(`agent:${HERMES_ID}`)).toBeNull();
  });

  it('경고색: 역할이 없는 보는 사람에게는 같은 사실이 회색 고리다', async () => {
    await mountHome({liveness: {[AGENT_ID]: 'woken_not_collected'}});
    const asMember = await waitFor(() => {
      const found = dotOf('dm:ch-dm-agent');
      expect(found).toBeTruthy();
      return found!;
    });
    expect([lightPalette.surface, darkPalette.surface]).toContain(bg(asMember));
  });

  it('경고색: 다시 깨울 수 있는 사람(owner)에게는 경고(주황)다', async () => {
    await mountHome({
      roster: asRoster({[SELF_ID]: {role: 'owner'}}),
      liveness: {[AGENT_ID]: 'woken_not_collected'},
    });
    const asOwner = await waitFor(() => {
      const found = dotOf('dm:ch-dm-agent');
      expect(found).toBeTruthy();
      return found!;
    });
    expect([lightPalette.warn, darkPalette.warn]).toContain(bg(asOwner));
  });

  it('점이 있는 줄도 얼굴의 자리는 같다 — 얼굴 크기의 상자 안에서 모서리에 앉는다', async () => {
    await mountHome({liveness: {[AGENT_ID]: 'responsive'}});
    const face = await waitFor(() =>
      within(screen.getByTestId('sidebar-row-dm:ch-dm-agent')).getByTestId('home-row-face', {
        includeHiddenElements: true,
      }),
    );
    expect(flat(face.props.style)).toMatchObject({width: HOME.rowFace, height: HOME.rowFace});
  });
});

describe('홈 — 섹션 접기가 남는다', () => {
  it('접으면 읽은 채널이 숨고, 안 읽은 채널은 남고, 다시 열어도 접혀 있다', async () => {
    await mountHome();
    fireEvent.press(screen.getByTestId('home-section-toggle-channels'));
    expect(screen.queryByTestId('sidebar-row-channel:ch-design')).toBeNull();
    expect(screen.getByTestId('sidebar-row-channel:ch-general')).toBeTruthy();
    expect(
      screen.getByTestId('home-section-toggle-channels').props.accessibilityState,
    ).toMatchObject({expanded: false});
    expect(
      JSON.parse(mmkvStore.get(NON_SECRET_KEYS.homeCollapsedSections) ?? '{}'),
    ).toEqual({[WS]: ['channels']});

    screen.unmount();
    queryClient?.clear();
    renderShell();
    await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy());
    expect(screen.queryByTestId('sidebar-row-channel:ch-design')).toBeNull();
  });
});

function chooseFromMenu(section: 'channels' | 'dms', label: string): string[] {
  let offered: string[] = [];
  jest
    .spyOn(ActionSheetIOS, 'showActionSheetWithOptions')
    .mockImplementation((options, callback) => {
      offered = options.options;
      callback(options.options.indexOf(label));
    });
  fireEvent.press(screen.getByTestId(`home-section-menu-${section}`));
  return offered;
}

describe('홈 — 섹션 메뉴(⋯)는 문이다', () => {
  it('채널 메뉴: 이름으로 찾기 · 메시지 검색', async () => {
    await mountHome();
    const offered = chooseFromMenu('channels', '메시지 검색');
    expect(offered).toEqual([FILTER_ACTION, '메시지 검색', '취소']);
    await waitFor(() => expect(screen.getByTestId('search-input')).toBeTruthy());
  });

  it('DM 메뉴: 에이전트 목록이 에이전트 층을 연다 (탭이 흡수된 뒤의 문)', async () => {
    await mountHome();
    const offered = chooseFromMenu('dms', AGENT_LIST_ACTION);
    expect(offered).toEqual([FILTER_ACTION, AGENT_LIST_ACTION, '취소']);
    await waitFor(() => expect(screen.getByTestId('agent-list-pane')).toBeTruthy());
  });
});

describe('홈 — 「작업 중」 카드', () => {
  it('작업 중인 에이전트가 없으면 「작업」 머리도 「에이전트 부르기」 줄도 없다 (성재 2026-10-16)', async () => {
    await mountHome();
    expect(screen.queryByTestId('home-working-card')).toBeNull();
    expect(screen.queryByTestId('home-agents-idle')).toBeNull();
    expect(screen.queryByText('에이전트 부르기')).toBeNull();
    expect(screen.queryByText('지금 작업 중인 에이전트 없음', {exact: false})).toBeNull();
    // 에이전트 목록으로 가는 문은 DM 섹션 메뉴에 그대로 있다.
    const offered = chooseFromMenu('dms', AGENT_LIST_ACTION);
    expect(offered).toContain(AGENT_LIST_ACTION);
    await waitFor(() => expect(screen.getByTestId('agent-list-pane')).toBeTruthy());
  });

  it('턴이 열리면 카드가 첫 화면 맨 위에 서고, 누르면 그 대화가 열린다', async () => {
    await mountHome();
    act(() => markAgentWorking(signal()));
    const cardNode = await waitFor(() => screen.getByTestId('home-working-card'));
    expect(screen.queryByTestId('home-agents-idle')).toBeNull();
    expect(cardNode).toHaveTextContent(/김인턴/);
    expect(cardNode).toHaveTextContent(/에이전트/);
    expect(screen.getByTestId('home-working-line')).toHaveTextContent(
      '#agent-lab · 푸시 중복 수정 PR 초안 작성 중',
    );
    expect(screen.getByTestId('home-working-steps-2')).toBeTruthy();
    fireEvent.press(cardNode);
    await waitFor(() =>
      expect(screen.getByTestId('conversation-title')).toHaveTextContent(/agent-lab/),
    );
  });

  it('승인 대기로 멈춘 턴은 「승인 대기」, 세 칸, 맥박 없음', async () => {
    await mountHome();
    act(() => markAgentWorking(signal({state: 'awaiting_approval'})));
    await waitFor(() => expect(screen.getByTestId('home-working-state')).toHaveTextContent('승인 대기'));
    expect(screen.getByTestId('home-working-steps-3')).toBeTruthy();
    expect(screen.getByTestId('home-live-dot-still')).toBeTruthy();
  });

  it('동작 줄이기가 켜져 있으면 맥박이 멈춘다', async () => {
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
    await mountHome();
    act(() => markAgentWorking(signal()));
    await waitFor(() => expect(screen.getByTestId('home-working-card')).toBeTruthy());
    expect(screen.queryByTestId('home-live-dot-pulse')).toBeNull();
  });
});

// ---- 5. 새로 생긴 글자·바탕 쌍의 대비 (새벽하늘 라이트·다크) -----------------------


/** `#rrggbbaa` 를 불투명 바탕 위에 합성한다. */
function composite(top: string, base: string): string {
  const hex = (h: string, i: number) => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16);
  const alpha = top.length === 9 ? hex(top, 3) / 255 : 1;
  const out = [0, 1, 2].map(i =>
    Math.round(hex(top, i) * alpha + hex(base, i) * (1 - alpha))
      .toString(16)
      .padStart(2, '0'),
  );
  return `#${out.join('')}`;
}

describe.each([
  ['light', lightPalette],
  ['dark', darkPalette],
] as const)('홈 대비 — %s', (_mode, p) => {
  // 카드는 유리다: 바닥 세 정지점 위에 합성한 셋, 블러가 없을 때의 94% 셋, 불투명 하나.
  const stops = [p.canvasTop, p.bg, p.canvasBottom];
  const cardGrounds = [
    ...stops.map(stop => composite(p.glass, stop)),
    ...stops.map(stop => composite(p.glassFallback, stop)),
    p.surface,
  ];

  it('카드 안의 글자(이름·한 줄·작업 중·승인 대기)가 모든 유리 바탕에서 4.5 이상', () => {
    for (const ground of cardGrounds) {
      for (const ink of [p.text, p.textMuted, p.agent, p.accentText]) {
        expect(contrast(ink, ground)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('켜진 진행 칸이 유리 위에서 비텍스트 3:1', () => {
    for (const ground of cardGrounds) {
      expect(contrast(p.agent, ground)).toBeGreaterThanOrEqual(3);
    }
  });

  it('배지 두 벌과 에이전트 태그의 글자가 4.5 이상', () => {
    expect(contrast(p.onPrimary, p.primary)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(p.onAccent, p.accent)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(p.agent, p.agentSurface)).toBeGreaterThanOrEqual(4.5);
  });

  it('행·섹션 머리의 글자 없는 아이콘이 바닥 세 정지점에서 3:1', () => {
    for (const stop of stops) {
      expect(contrast(p.icon, stop)).toBeGreaterThanOrEqual(3);
      expect(contrast(p.text, stop)).toBeGreaterThanOrEqual(4.5);
    }
  });
});

// ---- 6. 검수 R1 수리 ---------------------------------------------------------------

describe('검수 R1', () => {
  it('H1: 카드의 문장은 어절에서 끊는다 (한 줄 · 끊김 이유)', async () => {
    await mountHome();
    act(() => markAgentWorking(signal()));
    await waitFor(() => expect(screen.getByTestId('home-working-line')).toBeTruthy());
    expect(screen.getByTestId('home-working-line').props.lineBreakStrategyIOS).toBe(
      'hangul-word',
    );
  });

  it('H1·L1: 끊긴 레일의 이유 줄도 어절에서 끊고, 진행 칸도 색을 벗는다', () => {
    const model = card(keyed(signal()), false);
    if (model === null) throw new Error('card');
    render(<WorkingCard card={model} onPress={() => {}} />);
    expect(screen.getByTestId('home-working-stale').props.lineBreakStrategyIOS).toBe(
      'hangul-word',
    );
    const steps = screen.getByTestId('home-working-steps-2').children as unknown as {
      props: {style: unknown};
    }[];
    const fills = steps.map(step => flat(step.props.style).backgroundColor);
    for (const palette of [lightPalette, darkPalette]) {
      expect(fills).not.toContain(palette.agent);
    }
  });

  it('M2: 구분선 위 틈은 시안의 마진 상쇄대로 14 하나다', async () => {
    await mountHome();
    expect(flat(screen.getByTestId('home-divider').props.style).marginTop).toBe(0);
  });

  it('M3: 배송되는 두 컨트롤이 그 상자를 쓴다', async () => {
    await mountHome();
    expect(screen.getByTestId('home-section-menu-channels').props.hitSlop).toEqual(
      CTL_SLOP_MORE,
    );
    expect(screen.getByTestId('home-section-toggle-channels').props.hitSlop).toEqual(
      CTL_SLOP_DOWN,
    );
  });

  it('M3: ⋯ 와 셰브론의 누르는 상자는 각각 44 이고 겹치지 않는다', () => {
    const width = (slop: typeof CTL_SLOP_MORE, glyph: number) => slop.left + glyph + slop.right;
    expect(width(CTL_SLOP_MORE, 20)).toBe(44);
    expect(width(CTL_SLOP_DOWN, 20)).toBe(44);
    expect(CTL_SLOP_MORE.top + 20 + CTL_SLOP_MORE.bottom).toBe(44);
    // 두 글리프 사이 틈(14)을 둘이 나눠 갖는다 — 합이 틈을 넘지 않는다.
    expect(CTL_SLOP_MORE.right + CTL_SLOP_DOWN.left).toBeLessThanOrEqual(HOME.ctlGap);
  });
});

describe('고지는 목록 상태와 무관하게 선다', () => {
  it('목록이 실패해도 알림 탭 영수증이 오류 상자와 함께 선다 (#2569 · #2584 M-1)', async () => {
    globalThis.fetch = jest.fn(async (url: string) => {
      if (url.includes('/channels')) return jsonResponse(500, {error: {message: 'boom'}});
      if (url.includes('/roster')) return jsonResponse(200, {members: ROSTER});
      return jsonResponse(200, {});
    }) as unknown as typeof fetch;
    queryClient = new QueryClient({
      defaultOptions: {queries: {retry: false, gcTime: 0}, mutations: {retry: false, gcTime: 0}},
    });
    render(
      <QueryClientProvider client={queryClient}>
        <SessionProvider member={SELF}>
          <SidebarScreen
            openChannelId={null}
            onOpenConversation={() => {}}
            onOpenSearch={() => {}}
            notificationNotice="그 대화를 열지 못했습니다."
          />
        </SessionProvider>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('channels-error')).toBeTruthy());
    expect(screen.getByTestId('notification-tap-notice')).toBeTruthy();
  });
});

// ---- 5. 나간 멤버와의 대화 (#4252) -------------------------------------------------
//
// 상대가 명부에 없고 안 읽은 것이 없는 DM 은 기본으로 접히고, DM 섹션 끝의 조용한 줄이 수를 센다. 판정은 코어
// `dmHiddenAsGone` 이고(웹 사이드바와 같은 함수) 여기서는 폰 화면이 그것을 제대로 그리는지 잰다.

describe('홈 — 나간 멤버와의 대화 (#4252)', () => {
  const GONE_ID = 'ffffffff-1111-4111-8111-ffffffffffff';
  const GONE_DM = {
    id: 'ch-dm-gone',
    workspaceId: WS,
    kind: 'dm',
    muted: false,
    memberIds: [SELF_ID, GONE_ID],
  };
  // 채널은 하나만 둔다: `SectionList` 는 처음에 열 항목만 그리고(`initialNumToRender`, 시험 렌더러에는 레이아웃이
  // 없어 창이 자라지 않는다) 접힌 행은 목록의 끝에 서므로, 앞이 길면 펼친 행이 창 밖에 있다.
  const withGone = [CHANNELS[1], CHANNELS[3], CHANNELS[4], GONE_DM];
  const GONE_ROW = 'sidebar-row-dm:ch-dm-gone';

  it('접힌 줄이 DM 섹션 끝에 서고, 나간 멤버 행은 기본으로 보이지 않는다', async () => {
    await mountHome({channels: withGone});
    const toggle = await screen.findByTestId('sidebar-gone-toggle');
    expect(toggle).toHaveTextContent('나간 멤버와의 대화 1개');
    expect(toggle.props.accessibilityLabel).toBe('나간 멤버와의 대화 1개');
    expect(toggle.props.accessibilityState).toMatchObject({expanded: false});
    expect(screen.queryByTestId(GONE_ROW)).toBeNull();
    // 줄은 DM 행들 뒤, 구역의 마지막이다.
    const order = screen
      .getAllByTestId(/^sidebar-(row-(dm|agent):|gone-toggle)/)
      .map(node => node.props.testID);
    expect(order[order.length - 1]).toBe('sidebar-gone-toggle');
    expect(order).toContain('sidebar-row-dm:ch-dm-human');
  });

  it('누르면 접힌 대화가 줄 아래에 펼쳐지고, 얼굴은 빈 원이 아니라 기본 아바타다', async () => {
    await mountHome({channels: withGone});
    fireEvent.press(await screen.findByTestId('sidebar-gone-toggle'));
    const goneRow = await screen.findByTestId(GONE_ROW);
    expect(goneRow).toHaveTextContent('나간 멤버');
    expect(
      within(goneRow).getByTestId('home-default-face', {includeHiddenElements: true}),
    ).toBeTruthy();
    const order = screen
      .getAllByTestId(/^sidebar-(row-(dm|agent):|gone-toggle)/)
      .map(node => node.props.testID);
    // 줄이 먼저, 접힌 행이 그 뒤다(눌렀던 줄이 손가락 밑에 그대로 있다).
    expect(order.indexOf('sidebar-gone-toggle')).toBeLessThan(order.indexOf('sidebar-row-dm:ch-dm-gone'));
    expect(screen.getByTestId('sidebar-gone-toggle').props.accessibilityState).toMatchObject({
      expanded: true,
    });
    // 접힌 대화의 행은 그대로 대화로 간다(접힘은 진열일 뿐이다).
    fireEvent.press(screen.getByTestId('sidebar-gone-toggle'));
    await waitFor(() => expect(screen.queryByTestId(GONE_ROW)).toBeNull());
  });

  it('접힌 줄의 글자는 행의 이름처럼 사용자의 글자 크기를 따르고, 가장 큰 크기에서도 자르지 않고 줄을 바꾼다', async () => {
    // AX5 에서 「나간 멤버와의 대화 2개」가 한 줄에 안 들어갈 때 말줄임이 지우는 것은 끝의 「N개」다. 배율 상한도 두지
    // 않는다(행의 이름과 같은 규칙): 상한이 있으면 이 줄만 혼자 작게 남는다.
    await mountHome({channels: withGone});
    const label = within(await screen.findByTestId('sidebar-gone-toggle')).getByText(
      '나간 멤버와의 대화 1개',
    );
    expect(label.props.numberOfLines).toBeUndefined();
    expect(label.props.maxFontSizeMultiplier).toBeUndefined();
    // 줄이 바뀌어도 한글 낱말 가운데서 끊지 않는다(AX5 실측: 「대 / 화 2개」).
    expect(label.props.lineBreakStrategyIOS).toBe('hangul-word');
  });

  it('줄을 펼치면 내용이 자란 뒤 한 번만 끝으로 내린다 (줄이 목록 맨 끝이라 결과가 화면 밖에 서기 쉽다, design-review M1)', async () => {
    const scrollToEnd = jest.fn();
    jest
      .spyOn(SectionList.prototype, 'getScrollResponder')
      .mockReturnValue({scrollToEnd} as never);
    await mountHome({channels: withGone});
    const list = await screen.findByTestId('sidebar-list');
    // 펼치기 전의 크기 변화는 아무 일도 하지 않는다.
    fireEvent(list, 'contentSizeChange', 320, 900);
    expect(scrollToEnd).not.toHaveBeenCalled();
    fireEvent.press(await screen.findByTestId('sidebar-gone-toggle'));
    await screen.findByTestId(GONE_ROW);
    fireEvent(list, 'contentSizeChange', 320, 1200);
    expect(scrollToEnd).toHaveBeenCalledTimes(1);
    expect(scrollToEnd).toHaveBeenCalledWith({animated: true});
    // 한 번만: 같은 펼침의 다음 크기 변화(새로고침 등)는 내리지 않는다.
    fireEvent(list, 'contentSizeChange', 320, 1300);
    expect(scrollToEnd).toHaveBeenCalledTimes(1);
    // 접을 때는 내리지 않는다.
    fireEvent.press(screen.getByTestId('sidebar-gone-toggle'));
    fireEvent(list, 'contentSizeChange', 320, 900);
    expect(scrollToEnd).toHaveBeenCalledTimes(1);
  });

  it('기본 아바타는 나간 멤버에만 선다: 상대가 명부에 있는 DM 은 그 사람의 얼굴이다', async () => {
    await mountHome({channels: withGone});
    await screen.findByTestId('sidebar-gone-toggle');
    expect(
      within(screen.getByTestId('sidebar-row-dm:ch-dm-human')).queryByTestId('home-default-face', {
        includeHiddenElements: true,
      }),
    ).toBeNull();
  });

  // 안 읽음이 있는 나간 멤버 DM 은 그 안 읽음이 사람이 읽을 것인지 안 읽은 쪽을 읽어 가른다(`useGoneUnreadVerdicts`, 이슈 AC
  // 「안 읽은 사람 메시지」). 응답 메시지는 와이어가 아니라 `fetchMessages` 가 받아들이는 형상이다.
  const wireMessage = (seq: number, type = 'text', props?: Record<string, unknown>) => ({
    id: `m${seq}`,
    channelId: 'ch-dm-gone',
    authorMemberId: GONE_ID,
    seq,
    hlcTs: seq,
    hlcCount: 0,
    createdAtMs: seq,
    type,
    ...(props ? {props} : {}),
  });
  const goneRead = (lastRead: number, latest: number, extra: Record<string, unknown> = {}) => ({
    channel_id: 'ch-dm-gone',
    last_read_seq: lastRead,
    latest_seq: latest,
    unread_count: Math.max(0, latest - lastRead),
    mention_count: 0,
    ...extra,
  });
  const goneMessageCalls = (fetchMock: jest.Mock) =>
    fetchMock.mock.calls
      .map(call => String(call[0]))
      .filter(url => url.includes('/channels/ch-dm-gone/messages'));
  const AMBIENT = [wireMessage(2, 'system'), wireMessage(3, 'text', {kind: 'work_session'})];

  it('안 읽은 사람 메시지가 있으면 접히지 않고, 줄도 없다', async () => {
    await mountHome({
      channels: withGone,
      readStates: [...READ_STATES, goneRead(1, 3)],
      messages: [wireMessage(2, 'text'), wireMessage(3, 'system')],
    });
    await waitFor(() => expect(screen.getByTestId(GONE_ROW)).toBeTruthy());
    expect(screen.queryByTestId('sidebar-gone-toggle')).toBeNull();
  });

  it('안 읽음이 기계 메시지뿐이면 접힌다: 끈 에이전트의 DM 이 작업 상태 줄 때문에 남지 않는다', async () => {
    const fetchMock = await mountHome({
      channels: withGone,
      readStates: [...READ_STATES, goneRead(1, 3)],
      messages: AMBIENT,
    });
    await waitFor(() => expect(goneMessageCalls(fetchMock)).toHaveLength(1));
    await act(async () => {
      await Promise.resolve();
    });
    const toggle = await screen.findByTestId('sidebar-gone-toggle');
    expect(toggle).toHaveTextContent('나간 멤버와의 대화 1개');
    expect(screen.queryByTestId(GONE_ROW)).toBeNull();
    // 마지막으로 읽은 seq 뒤를 한 번만 읽는다.
    const [call] = goneMessageCalls(fetchMock);
    expect(call).toContain('after=1');
    // 서버가 한 쪽에 줄 수 있는 최대(200건)까지 읽는다: 안 읽은 기계 메시지가 많아도 접힌다(design-review M-A).
    expect(call).toContain('limit=200');
  });

  it('판정이 오는 중이면 접힌 채다 (읽는 중에 깜빡이며 나타나지 않는다)', async () => {
    const fetchMock = await mountHome({
      channels: withGone,
      readStates: [...READ_STATES, goneRead(1, 3)],
      messages: 'pending',
    });
    await waitFor(() => expect(goneMessageCalls(fetchMock)).toHaveLength(1));
    expect(await screen.findByTestId('sidebar-gone-toggle')).toHaveTextContent(
      '나간 멤버와의 대화 1개',
    );
    expect(screen.queryByTestId(GONE_ROW)).toBeNull();
  });

  it('메시지를 못 읽었으면 보인다 (안 읽은 것이 사람이 읽을 것인지 모를 때 숨기는 쪽이 최악이다)', async () => {
    await mountHome({
      channels: withGone,
      readStates: [...READ_STATES, goneRead(1, 3)],
      messages: 'fail',
    });
    await waitFor(() => expect(screen.getByTestId(GONE_ROW)).toBeTruthy(), {timeout: 3000});
    expect(screen.queryByTestId('sidebar-gone-toggle')).toBeNull();
  });

  it('멘션이 있는 DM 은 메시지를 읽지 않고 보인다 (사람이 부른 것이다)', async () => {
    const fetchMock = await mountHome({
      channels: withGone,
      readStates: [...READ_STATES, goneRead(3, 3, {mention_count: 1})],
      messages: AMBIENT,
    });
    await waitFor(() => expect(screen.getByTestId(GONE_ROW)).toBeTruthy());
    expect(goneMessageCalls(fetchMock)).toEqual([]);
  });

  it('사람이 직접 한 「여기부터 안 읽음」 표시가 있는 DM 은 메시지를 읽지 않고 보인다 (사람의 뜻이다)', async () => {
    const fetchMock = await mountHome({
      channels: withGone,
      readStates: [...READ_STATES, goneRead(3, 3, {marked_unread_before_seq: 2})],
      messages: AMBIENT,
    });
    await waitFor(() => expect(screen.getByTestId(GONE_ROW)).toBeTruthy());
    expect(goneMessageCalls(fetchMock)).toEqual([]);
  });

  it('안 읽음이 없는 나간 멤버 DM 은 메시지를 읽지 않고 접힌다', async () => {
    const fetchMock = await mountHome({channels: withGone, messages: AMBIENT});
    await screen.findByTestId('sidebar-gone-toggle');
    expect(goneMessageCalls(fetchMock)).toEqual([]);
  });

  it('읽음 투영을 한 번도 못 읽으면 나간 멤버 DM 이 도로 보이고, 고지가 그 이유를 말한다 (「목록은 그대로」는 거짓이다)', async () => {
    installFetch({channels: withGone});
    (globalThis.fetch as jest.Mock).mockImplementation(async (url: string) => {
      if (String(url).includes('/read-state')) return jsonResponse(500, {error: {message: 'boom'}});
      if (String(url).includes('/channels') && !String(url).includes('/messages')) {
        return jsonResponse(200, {channels: withGone});
      }
      if (String(url).includes('/roster')) return jsonResponse(200, {members: ROSTER});
      return jsonResponse(200, {});
    });
    renderShell();
    await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy());
    const notice = await screen.findByTestId('read-state-error');
    expect(notice).toHaveTextContent(/안 읽음 표시를 불러오지 못했습니다\./);
    expect(notice).toHaveTextContent(/나간 멤버와의 대화도 접지 못했어요\./);
    expect(notice).not.toHaveTextContent(/목록은 그대로/);
    // 접지 않는다: 나간 멤버 DM 이 목록에 있고 접힌 줄은 없다.
    expect(screen.getByTestId(GONE_ROW)).toBeTruthy();
    expect(screen.queryByTestId('sidebar-gone-toggle')).toBeNull();
  });

  it('읽음 투영 실패라도 나간 멤버 DM 이 없으면 목록은 그대로라고 말한다', async () => {
    installFetch();
    (globalThis.fetch as jest.Mock).mockImplementation(async (url: string) => {
      if (String(url).includes('/read-state')) return jsonResponse(500, {error: {message: 'boom'}});
      if (String(url).includes('/channels') && !String(url).includes('/messages')) {
        return jsonResponse(200, {channels: CHANNELS});
      }
      if (String(url).includes('/roster')) return jsonResponse(200, {members: ROSTER});
      return jsonResponse(200, {});
    });
    renderShell();
    await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy());
    const notice = await screen.findByTestId('read-state-error');
    expect(notice).toHaveTextContent(/목록은 그대로이고, 안 읽은 개수만 지금 알 수 없습니다\./);
    expect(notice).not.toHaveTextContent(/접지 못했어요/);
  });

  it('접힌 대화가 없어지면 펼침은 닫힌 채로 돌아간다 (웹과 같다)', async () => {
    await mountHome({channels: withGone});
    fireEvent.press(await screen.findByTestId('sidebar-gone-toggle'));
    await screen.findByTestId(GONE_ROW);
    // 안 읽은 사람 글이 오면 그 DM 이 보이게 되고 접힌 줄이 사라진다.
    const projection = (lastRead: number, latest: number) => [
      {
        channelId: 'ch-dm-gone',
        lastReadSeq: lastRead,
        latestSeq: latest,
        unreadCount: Math.max(0, latest - lastRead),
        mentionCount: 0,
        markedUnreadBeforeSeq: null,
      },
    ];
    // 사람이 읽을 쪽을 돌려줘서 보이게 한다.
    (globalThis.fetch as jest.Mock).mockImplementation(async (url: string) =>
      String(url).includes('/messages')
        ? jsonResponse(200, {messages: [wireMessage(2, 'text')]})
        : jsonResponse(200, {}),
    );
    act(() => {
      queryClient!.setQueryData(workspaceKeys.readState(WS), projection(1, 3));
    });
    // 판정(안 읽은 쪽 읽기)이 돌아올 시간을 준다.
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 300));
    });
    await waitFor(() => expect(screen.queryByTestId('sidebar-gone-toggle')).toBeNull());
    expect(screen.getByTestId(GONE_ROW)).toBeTruthy();
    // 읽으면 다시 접힌다: 줄은 처음처럼 접힌 채 선다.
    act(() => {
      queryClient!.setQueryData(workspaceKeys.readState(WS), projection(3, 3));
    });
    const toggle = await screen.findByTestId('sidebar-gone-toggle');
    expect(toggle.props.accessibilityState).toMatchObject({expanded: false});
    expect(screen.queryByTestId(GONE_ROW)).toBeNull();
  });

  it('DM 섹션을 접으면 줄도 접힌다', async () => {
    await mountHome({channels: withGone});
    await screen.findByTestId('sidebar-gone-toggle');
    fireEvent.press(screen.getByTestId('home-section-toggle-dms'));
    await waitFor(() => expect(screen.queryByTestId('sidebar-gone-toggle')).toBeNull());
  });

  it('이름으로 찾으면 접힌 대화도 나오고, 줄은 서지 않는다', async () => {
    await mountHome({channels: withGone});
    await screen.findByTestId('sidebar-gone-toggle');
    chooseFromMenu('dms', FILTER_ACTION);
    fireEvent.changeText(await screen.findByTestId('sidebar-search'), '나간');
    await waitFor(() => expect(screen.getByTestId(GONE_ROW)).toBeTruthy());
    expect(screen.queryByTestId('sidebar-gone-toggle')).toBeNull();
  });

  it('나간 멤버 DM 뿐이어도 목록이 선다 (「참여한 채널이 없다」고 말하지 않는다)', async () => {
    await mountHome({channels: [GONE_DM]});
    expect(await screen.findByTestId('sidebar-gone-toggle')).toHaveTextContent(
      '나간 멤버와의 대화 1개',
    );
    expect(screen.queryByTestId('channels-empty')).toBeNull();
  });
});

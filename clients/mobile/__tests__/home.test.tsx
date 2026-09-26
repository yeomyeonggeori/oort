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
import {AccessibilityInfo, ActionSheetIOS, StyleSheet} from 'react-native';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {darkPalette, lightPalette} from '../src/design/tokens';
import {
  markAgentWorking,
  resetAgentWorking,
} from '../src/features/agents/workingSignal';
import {parseCollapsed, visibleRows} from '../src/features/home/collapsedSections';
import {buildWorkingCard, workingStep} from '../src/features/home/workingCard';
import {
  isWorkspaceAvatarPath,
  workspaceHeading,
} from '../src/features/home/workspaceLogo';
import type {SidebarRow, SidebarSection} from '../src/features/sidebar/rows';
import {
  AGENT_LIST_ACTION,
  FILTER_ACTION,
  HOME,
} from '../src/screens/SidebarScreen';
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
  workspace?: () => Response;
}

function installFetch(routes: Routes = {}): jest.Mock {
  const mock = jest.fn(async (url: string) => {
    if (url.includes('/reactions')) return jsonResponse(200, {});
    if (url.includes('/channels') && !url.includes('/messages')) {
      return jsonResponse(200, {channels: routes.channels ?? CHANNELS});
    }
    if (url.includes('/roster')) {
      return jsonResponse(200, {members: routes.roster ?? ROSTER});
    }
    if (url.includes('/read-state')) {
      return jsonResponse(200, {read_states: READ_STATES});
    }
    if (url.includes('/messages')) return jsonResponse(200, {messages: []});
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
  installFetch(routes);
  renderShell();
  await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy());
}

function flat(style: unknown): Record<string, unknown> {
  return (StyleSheet.flatten(style as never) ?? {}) as Record<string, unknown>;
}

describe('홈 — 머리', () => {
  it('큰 제목은 워크스페이스 이름이고 30/800 이다', async () => {
    await mountHome();
    await waitFor(() => expect(screen.getByTestId('home-title')).toHaveTextContent('여명거리'));
    const title = flat(screen.getByTestId('home-title').props.style);
    expect(title.fontSize).toBe(30);
    expect(title.fontWeight).toBe('800');
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

  it('DM 섹션의 에이전트는 둥근 사각이고 사람보다 앞이다', async () => {
    await mountHome();
    const dm = screen.getByTestId('home-section-dms');
    expect(dm).toBeTruthy();
    const agentRow = screen.getByTestId('sidebar-row-dm:ch-dm-agent');
    const square = within(agentRow).getByTestId('home-agent-square', {
      includeHiddenElements: true,
    });
    expect(flat(square.props.style)).toMatchObject({
      width: HOME.rowFace,
      height: HOME.rowFace,
      borderRadius: HOME.rowAgentCorner,
    });
    // DM 없는 에이전트도 같은 섹션의 행이다.
    expect(screen.getByTestId(`sidebar-row-agent:${HERMES_ID}`)).toBeTruthy();
    const humanRow = screen.getByTestId('sidebar-row-dm:ch-dm-human');
    expect(
      within(humanRow).queryByTestId('home-agent-square', {includeHiddenElements: true}),
    ).toBeNull();
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
  it('작업 중인 에이전트가 없으면 「에이전트 부르기」 한 줄이 서고, 에이전트 목록을 연다', async () => {
    await mountHome();
    expect(screen.queryByTestId('home-working-card')).toBeNull();
    const idle = screen.getByTestId('home-agents-idle');
    expect(idle).toHaveTextContent(/에이전트 부르기/);
    expect(idle).toHaveTextContent(/2명/);
    fireEvent.press(idle);
    await waitFor(() => expect(screen.getByTestId('agent-list-pane')).toBeTruthy());
  });

  it('에이전트가 하나도 없으면 그 한 줄도 없다', async () => {
    await mountHome({roster: [ROSTER[0], ROSTER[1]]});
    expect(screen.queryByTestId('home-agents-idle')).toBeNull();
    expect(screen.queryByTestId('home-working-card')).toBeNull();
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

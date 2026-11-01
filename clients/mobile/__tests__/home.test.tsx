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
import {AccessibilityInfo, ActionSheetIOS, Image, StyleSheet} from 'react-native';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {BAR_CONTROL_MAX_SCALE} from '../src/design/atoms';
import {HOME_ICON_SIZE, HOME_ICONS} from '../src/design/icons';
import {FixedScheme} from '../src/design/theme';
import {darkPalette, lightPalette} from '../src/design/tokens';
import {GroupCard} from '../src/design/sheetParts';
import {describeCloseContract} from './fixtures/sheetContract';
import {
  markAgentWorking,
  resetAgentWorking,
} from '../src/features/agents/workingSignal';
import {
  DM_CLOSED_LIST_LABEL,
} from '@momo/core/features/sidebar/dmVisibility';
import {DM_REOPEN_FAILURE} from '@momo/core/features/channels/model';
import {parseCollapsed, visibleRows} from '../src/features/home/collapsedSections';
import {pendingApprovalsKey} from '../src/features/conversation/usePendingApprovals';
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
  /** 참이면 읽음 투영 요청이 500 으로 실패한다(안 읽음 수를 모르는 화면, #4953). */
  readStatesFail?: boolean;
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
  /**
   * 승인 원장(`status=pending`)의 행(와이어 형상). 생략하면 비어 있다. 배열을 **참조로** 읽으므로 시험이 나중에 행을 더하거나 빼고
   * 원장을 무효화하면 다음 조회가 그것을 본다(#5085: 카드가 원장을 따라 바뀌는 순간을 재려고).
   */
  approvals?: unknown[];
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
      if (routes.readStatesFail) return jsonResponse(500, {error: {message: 'boom'}});
      return jsonResponse(200, {read_states: routes.readStates ?? READ_STATES});
    }
    if (url.includes('/messages')) {
      if (routes.messages === 'pending') return new Promise<Response>(() => {});
      if (routes.messages === 'fail') return jsonResponse(500, {error: {message: 'boom'}});
      return jsonResponse(200, {messages: routes.messages ?? []});
    }
    if (url.includes('/approvals')) {
      return jsonResponse(200, {approvals: routes.approvals ?? []});
    }
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

  it('승인 필요는 결코 「작업 중」이라고 말하지 않는다', () => {
    const model = card(keyed(signal({state: 'awaiting_approval'})));
    expect(model?.liveText).toBe('승인 필요');
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
    emphasis: {dim: false, bold: false, chip: null},
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

  it('사람: 접속 중은 채운 초록 점, 접속 없음은 속이 빈 회색 고리 — 에이전트의 두 끝과 같은 모양 (#4692)', async () => {
    const HUMAN2 = 'dddddddd-1111-4111-8111-dddddddddddd';
    await mountHome({
      roster: [
        ...asRoster({[HUMAN_ID]: {online: true}}),
        rosterMember({id: HUMAN2, displayName: '이도현', handle: 'dohyun', online: false}),
      ],
      channels: [
        ...CHANNELS,
        {id: 'ch-dm-human2', workspaceId: WS, kind: 'dm', muted: false, memberIds: [SELF_ID, HUMAN2]},
      ],
    });
    const on = await waitFor(() => {
      const node = dotOf('dm:ch-dm-human');
      expect(node).toBeTruthy();
      return node!;
    });
    expect([lightPalette.ok, darkPalette.ok]).toContain(bg(on));
    const off = await waitFor(() => {
      const node = dotOf('dm:ch-dm-human2');
      expect(node).toBeTruthy();
      return node!;
    });
    // 속이 빈 고리: 면 채움 + 선 색(textFaint) 둘레. 채운 초록과 한 점이 되지 않는다.
    expect([lightPalette.surface, darkPalette.surface]).toContain(bg(off));
    expect([lightPalette.textFaint, darkPalette.textFaint]).toContain(border(off));
    expect(bg(on)).not.toBe(bg(off));
    // 낱말은 낭독 라벨이 잇는다(점은 보조기술에서 숨는다).
    expect(screen.getByTestId('sidebar-row-dm:ch-dm-human').props.accessibilityLabel).toMatch(
      /, 온라인$/,
    );
    expect(screen.getByTestId('sidebar-row-dm:ch-dm-human2').props.accessibilityLabel).toMatch(
      /, 오프라인$/,
    );
  });

  it('사람: 스스로 정한 자리 비움은 접속 여부보다 먼저다 (#4692)', async () => {
    await mountHome({roster: asRoster({[HUMAN_ID]: {presenceStatus: 'away', online: true}})});
    const away = await waitFor(() => {
      const node = dotOf('dm:ch-dm-human');
      expect(node).toBeTruthy();
      return node!;
    });
    expect([lightPalette.warn, darkPalette.warn]).toContain(bg(away));
    expect(screen.getByTestId('sidebar-row-dm:ch-dm-human').props.accessibilityLabel).toMatch(
      /, 자리 비움$/,
    );
  });

  it('사람: 평소(auto)이고 접속 여부를 서버가 말하지 않았으면 점이 없다 — 근거 없는 온라인·회색 오프라인 점 금지', async () => {
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

  it('승인 필요로 멈춘 턴은 「승인 필요」, 세 칸, 맥박 없음', async () => {
    await mountHome();
    act(() => markAgentWorking(signal({state: 'awaiting_approval'})));
    await waitFor(() => expect(screen.getByTestId('home-working-state')).toHaveTextContent('승인 필요'));
    expect(screen.getByTestId('home-working-steps-3')).toBeTruthy();
    expect(screen.getByTestId('home-live-dot-still')).toBeTruthy();
  });

  // ---- 승인 원장이 레일보다 이긴다 (#5085, #5066 후속) ----------------------------------------------
  //
  // 서버는 승인에 걸린 run 을 DB 에서는 승인 대기로 세우지만 레일 프레임으로는 알리지 않는다(중간 프레임은 늘 `running`). 그래서 레일만
  // 읽는 홈 카드는 사람을 기다리는 에이전트를 「작업 중」이라고 말했고, 같은 승인이 대화 화면에서는 「승인을 기다립니다」였다(#5066 은
  // 대화 화면에만 원장 덮어쓰기를 더했다). 원장은 인박스·대화 화면과 같은 쿼리 캐시라서 시험은 원장 응답(`Routes.approvals`)에 행을 둔다.
  describe('승인 원장이 레일보다 이긴다 (#5085)', () => {
    const wireApproval = (over: Record<string, unknown> = {}) => ({
      id: 'ap-1',
      workspaceId: WS,
      runId: 'run-1',
      channelId: 'ch-agent-lab',
      requestedBy: AGENT_ID,
      actionType: 'tool_call',
      status: 'pending',
      expiresAtMs: Date.now() + 3_600_000,
      ...over,
    });
    // 카드가 원장을 읽기도 전에 「안 바뀐다」를 단정하면 아무것도 증명하지 못한다(#839). 원장이 캐시에 들어온 것을 보고 나서 잰다.
    const ledgerRows = (rows: number) =>
      waitFor(() =>
        expect(
          queryClient!.getQueryData<unknown[]>(pendingApprovalsKey(WS)),
        ).toHaveLength(rows),
      );
    const reread = () =>
      act(async () => {
        await queryClient!.invalidateQueries({queryKey: pendingApprovalsKey(WS)});
      });

    it('카드는 원장을 따른다: 대기가 아닌 승인은 그대로, 기다리는 승인이 서면 「승인 필요」, 결정돼 빠지면 다시 「작업 중」', async () => {
      const ledger: unknown[] = [
        // 다른 에이전트의 승인: 그 에이전트의 기다림이고 이 카드의 에이전트는 아니다(그 에이전트는 따로 열린 턴으로 세어진다).
        wireApproval({id: 'ap-2', requestedBy: HERMES_ID}),
        wireApproval({id: 'ap-3', status: 'approved'}), // 이미 결정된 승인
        wireApproval({id: 'ap-4', expiresAtMs: Date.now() - 60_000}), // 기한이 지난 승인(서버가 정리하기 전의 몇 초)
      ];
      await mountHome({approvals: ledger});
      await ledgerRows(3);
      act(() => markAgentWorking(signal()));
      const state = () => screen.getByTestId('home-working-state');
      const line = () => screen.getByTestId('home-working-line');
      await waitFor(() => expect(state()).toHaveTextContent('작업 중'));
      // 원장은 이미 읽혔는데도 카드는 레일이 말하는 그대로다. 세 승인 중 이 에이전트를 기다림으로 세우는 것은 없고(결정된 승인과
      // 기한이 지난 승인은 턴도 만들지 못해서 「그 밖에」는 3건이 아니라 다른 에이전트의 기다림 1건이다).
      expect(screen.getByTestId('home-working-steps-2')).toBeTruthy();
      expect(line()).toHaveTextContent(/푸시 중복 수정 PR 초안 작성 중/);
      expect(line()).toHaveTextContent(/그 밖에 1건/);

      // 이 에이전트가 올린 승인이 사람을 기다린다 → 같은 카드가 「승인 필요」를 말하고 에이전트가 쓰던 한 줄은 버린다.
      ledger.push(wireApproval());
      await reread();
      await waitFor(() => expect(state()).toHaveTextContent('승인 필요'));
      expect(state()).not.toHaveTextContent('작업 중');
      expect(screen.getByTestId('home-working-steps-3')).toBeTruthy();
      expect(screen.getByTestId('home-live-dot-still')).toBeTruthy();
      expect(line()).toHaveTextContent(/#agent-lab/);
      expect(line()).not.toHaveTextContent(/푸시 중복 수정/);

      // 다른 곳에서 결정돼 원장에서 빠지면 카드는 레일이 말하는 그대로 돌아온다.
      ledger.pop();
      await reread();
      await waitFor(() => expect(state()).toHaveTextContent('작업 중'));
      expect(screen.getByTestId('home-working-steps-2')).toBeTruthy();
      expect(line()).toHaveTextContent(/푸시 중복 수정 PR 초안 작성 중/);
    });

    it('레일이 아무 턴도 모르는데 사람을 기다리는 승인이 있으면 승인이 카드를 세우고, 누르면 그 대화가 열린다', async () => {
      await mountHome({approvals: [wireApproval({runId: 'run-9'})]});
      const cardNode = await waitFor(() => screen.getByTestId('home-working-card'));
      expect(cardNode).toHaveTextContent(/김인턴/);
      expect(screen.getByTestId('home-working-state')).toHaveTextContent('승인 필요');
      expect(screen.getByTestId('home-working-line')).toHaveTextContent('#agent-lab');
      expect(screen.getByTestId('home-working-steps-3')).toBeTruthy();
      fireEvent.press(cardNode);
      await waitFor(() =>
        expect(screen.getByTestId('conversation-title')).toHaveTextContent(/agent-lab/),
      );
    });
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

  it('카드 안의 글자(이름·한 줄·작업 중·승인 필요)가 모든 유리 바탕에서 4.5 이상', () => {
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

// ---- 5. 닫은 대화와 나간 멤버와의 대화 (#4367, 전 #4252) ---------------------------------
//
// 한 DM 이 목록에 서는가는 코어 `dmVisibility` 한 함수이고(웹 사이드바와 같다) 입력 모으기는 `dmVerdicts.ts` 다. 여기서는
// 폰 화면이 그것을 제대로 그리는지 잰다: 숨은 DM 은 행도 접힌 줄도 없고, 「⋯ › 닫은 대화」 시트가 그 문이다.

describe('홈 — 닫은 대화·나간 멤버와의 대화 (#4367)', () => {
  const GONE_ID = 'ffffffff-1111-4111-8111-ffffffffffff';
  const GONE_DM = {
    id: 'ch-dm-gone',
    workspaceId: WS,
    kind: 'dm',
    muted: false,
    memberIds: [SELF_ID, GONE_ID],
  };
  const withGone = [CHANNELS[1], CHANNELS[3], CHANNELS[4], GONE_DM];
  const GONE_ROW = 'sidebar-row-dm:ch-dm-gone';
  const HUMAN_ROW = 'sidebar-row-dm:ch-dm-human';

  /** DM 섹션 ⋯ 가 내놓는 항목들(눌러서 고르지 않고 취소한다). */
  const dmMenu = () => chooseFromMenu('dms', '취소');
  const hasClosedDoor = () => dmMenu().includes(DM_CLOSED_LIST_LABEL);
  /** 숨은 DM 이 「닫은 대화」 시트의 문으로 잡힐 때까지(= 판정이 자리 잡을 때까지) 기다린다. */
  const settledHidden = () => waitFor(() => expect(hasClosedDoor()).toBe(true));
  const openClosedSheet = () => chooseFromMenu('dms', DM_CLOSED_LIST_LABEL);
  /** 닫기·다시 열기 쓰기(`…/closure`)만 센다: 같은 앱의 다른 쓰기(푸시 토큰 등)는 이 시험의 일이 아니다. */
  const writes = (fetchMock: jest.Mock) =>
    fetchMock.mock.calls
      .map(call => ({url: String(call[0]), method: (call[1] as {method?: string} | undefined)?.method ?? 'GET'}))
      .filter(call => call.method !== 'GET' && call.url.includes('/closure'));

  // ---- 읽음 투영이 바뀐 뒤의 기다림 (#4406) ---------------------------------------------------------
  //
  // 「다른 기기가 닫았다·열었다」는 서버의 다음 투영을 바꾸고 캐시를 무효화해 그것이 이 화면에 서는지 잰다. 답이 캐시에 들어온 뒤에도
  // 화면까지 두 걸음이 남는다: react-query 가 구독자에게 알리는 `setTimeout(0)`, 그다음 React 가 다시 그리는 `setImmediate`.
  // 무효화 직후 곧장 `waitFor` 로 행을 기다리면 이 두 걸음이 `waitFor` 의 1초 창 안에서 일어난다. 이벤트 루프가 창보다 길게 멈추면
  // (부하가 걸린 CI) 창의 타이머(간격 검사·제한)가 그리기보다 먼저 한꺼번에 터져서, 캐시는 이미 닫힘인데 행이 남은 채 시간이
  // 초과된다(#4405 CI). 제한을 늘리지 않는다: 두 걸음을 시간 제한이 없는 `act` 안에서 끝낸 뒤 곧장 단정한다.
  /**
   * `work` 가 바꾼 캐시가 화면에 그려진 채로 돌아온다. 끝의 `setTimeout(0)` 한 걸음이 react-query 의 알림을 `act` 안으로 끌어들인다
   * (`act` 만으로는 알림이 그 뒤에 와서 `act` 밖에서 그려진다).
   */
  const settleAfter = async (work: () => void | Promise<unknown>) => {
    await act(async () => {
      await work();
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    });
  };
  const projectionCalls = (fetchMock: jest.Mock) =>
    fetchMock.mock.calls.filter(call => String(call[0]).includes('/read-state')).length;
  /**
   * 첫 읽음 투영 답이 캐시에 들어왔다. 「행이 보인다」는 오는 중(`hold`)에도 참이라 도착을 말해 주지 않는다. 답이 오기 전에 서버를 바꾸고
   * 무효화하면 react-query 는 오는 중인 첫 요청을 이어받아(데이터가 아직 없으면 취소하지 않는다) 옛 답을 그린다: 행은 영영 안 사라진다.
   */
  const projectionLanded = () =>
    waitFor(() => {
      const state = queryClient!.getQueryState(workspaceKeys.readState(WS));
      expect(state?.status).toBe('success');
      expect(state?.fetchStatus).toBe('idle');
    });
  /** `routes.readStates` 를 바꾼 뒤 부른다: 투영을 다시 읽어 그 답이 그려진 채로 돌아온다(새 요청이 나갔는지도 본다). */
  const reprojectReadStates = async (fetchMock: jest.Mock) => {
    const before = projectionCalls(fetchMock);
    await settleAfter(() => queryClient!.invalidateQueries({queryKey: workspaceKeys.readState(WS)}));
    expect(projectionCalls(fetchMock)).toBeGreaterThan(before);
  };

  it('나간 멤버 행은 목록에 없고, 접힌 줄도 없다: 문은 ⋯ 의 「닫은 대화」다', async () => {
    await mountHome({channels: withGone});
    await settledHidden();
    expect(screen.queryByTestId(GONE_ROW)).toBeNull();
    expect(screen.queryByTestId('sidebar-gone-toggle')).toBeNull();
    expect(screen.getByTestId(HUMAN_ROW)).toBeTruthy();
    expect(dmMenu()).toEqual([FILTER_ACTION, AGENT_LIST_ACTION, DM_CLOSED_LIST_LABEL, '취소']);
  });

  it('숨은 DM 이 없으면 ⋯ 에 「닫은 대화」가 서지 않는다 (항목이 없는 문은 문이 아니다)', async () => {
    await mountHome();
    expect(dmMenu()).toEqual([FILTER_ACTION, AGENT_LIST_ACTION, '취소']);
  });

  it('시트: 나간 멤버는 이름·이유 줄·「열기」, 누르면 쓰는 것 없이 그 대화가 열린다', async () => {
    const fetchMock = await mountHome({channels: withGone});
    await settledHidden();
    openClosedSheet();
    const item = await screen.findByTestId('dm-closed-item-ch-dm-gone');
    expect(item).toHaveTextContent(/나간 멤버/);
    expect(item).toHaveTextContent(/상대가 나갔고 안 읽은 메시지가 없어요/);
    const reopen = screen.getByTestId('dm-closed-reopen-ch-dm-gone');
    // 대화 하나는 행 하나이고 행 전체가 동사다(#4458): 동사는 오른쪽 값이다. 「열기」와 「다시 열기」는 다른 동사다.
    expect(within(reopen).getByText('열기')).toBeTruthy();
    expect(within(reopen).queryByText('다시 열기')).toBeNull();
    expect(reopen.props.accessibilityLabel).toBe('나간 멤버, 열기');
    fireEvent.press(reopen);
    await waitFor(() => expect(screen.getByTestId('conversation-pane')).toBeTruthy());
    // 풀 닫힘이 없다(D8): 서버에 아무것도 쓰지 않는다.
    expect(writes(fetchMock)).toEqual([]);
    expect(screen.queryByTestId('dm-closed-sheet')).toBeNull();
  });

  it('시트의 원형 X 와 배경이 시트를 닫는다 — 맨 아래 「닫기」 줄은 없다 (#4458)', async () => {
    await mountHome({channels: withGone});
    await settledHidden();
    openClosedSheet();
    await screen.findByTestId('dm-closed-sheet');
    fireEvent.press(screen.getByTestId('dm-closed-close'));
    await waitFor(() => expect(screen.queryByTestId('dm-closed-sheet')).toBeNull(), {timeout: 8000});
    openClosedSheet();
    fireEvent.press(await screen.findByTestId('dm-closed-backdrop', {includeHiddenElements: true}));
    await waitFor(() => expect(screen.queryByTestId('dm-closed-sheet')).toBeNull(), {timeout: 8000});
  });

  it('이름으로 찾으면 숨은 대화도 나오고, 얼굴은 빈 원이 아니라 기본 아바타다 (닫기는 지우기가 아니다)', async () => {
    await mountHome({channels: withGone});
    await settledHidden();
    chooseFromMenu('dms', FILTER_ACTION);
    fireEvent.changeText(await screen.findByTestId('sidebar-search'), '나간');
    const goneRow = await screen.findByTestId(GONE_ROW);
    expect(goneRow).toHaveTextContent('나간 멤버');
    expect(
      within(goneRow).getByTestId('home-default-face', {includeHiddenElements: true}),
    ).toBeTruthy();
  });

  it('기본 아바타는 나간 멤버에만 선다: 상대가 명부에 있는 DM 은 그 사람의 얼굴이다', async () => {
    await mountHome({channels: withGone});
    await settledHidden();
    expect(
      within(screen.getByTestId(HUMAN_ROW)).queryByTestId('home-default-face', {
        includeHiddenElements: true,
      }),
    ).toBeNull();
  });

  it('DM 섹션을 접어도 ⋯ 는 그대로 있다', async () => {
    await mountHome({channels: withGone});
    await settledHidden();
    fireEvent.press(screen.getByTestId('home-section-toggle-dms'));
    expect(hasClosedDoor()).toBe(true);
  });

  it('나간 멤버 DM 뿐이어도 DM 섹션 머리가 서고 「참여한 채널이 없다」고 말하지 않는다 (돌아올 길이 머리의 ⋯ 다)', async () => {
    await mountHome({channels: [GONE_DM]});
    await settledHidden();
    expect(screen.queryByTestId('channels-empty')).toBeNull();
    expect(screen.getByTestId('home-section-dms')).toBeTruthy();
    expect(screen.queryByTestId(GONE_ROW)).toBeNull();
  });

  // 옛 서버(닫기를 안 싣는 투영): 안 읽음이 있는 나간 멤버 DM 은 그 안 읽음이 사람이 읽을 것인지 안 읽은 쪽을 읽어 가른다
  // (`useGoneUnreadVerdicts`, 이슈 AC 「안 읽은 사람 메시지」). 응답 메시지는 와이어가 아니라 `fetchMessages` 가 받아들이는 형상이다.
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

  it('옛 서버: 안 읽은 사람 메시지가 있으면 보인다', async () => {
    await mountHome({
      channels: withGone,
      readStates: [...READ_STATES, goneRead(1, 3)],
      messages: [wireMessage(2, 'text'), wireMessage(3, 'system')],
    });
    await waitFor(() => expect(screen.getByTestId(GONE_ROW)).toBeTruthy());
    expect(hasClosedDoor()).toBe(false);
  });

  it('옛 서버: 안 읽음이 기계 메시지뿐이면 숨는다 — 끈 에이전트의 DM 이 작업 상태 줄 때문에 남지 않는다', async () => {
    const fetchMock = await mountHome({
      channels: withGone,
      readStates: [...READ_STATES, goneRead(1, 3)],
      messages: AMBIENT,
    });
    await waitFor(() => expect(goneMessageCalls(fetchMock)).toHaveLength(1));
    await settledHidden();
    expect(screen.queryByTestId(GONE_ROW)).toBeNull();
    // 마지막으로 읽은 seq 뒤를 한 번만, 서버가 한 쪽에 줄 수 있는 최대(200건)까지 읽는다.
    const [call] = goneMessageCalls(fetchMock);
    expect(call).toContain('after=1');
    expect(call).toContain('limit=200');
  });

  it('옛 서버: 판정이 오는 중이면 숨은 채다 (읽는 중에 깜빡이며 나타나지 않는다)', async () => {
    const fetchMock = await mountHome({
      channels: withGone,
      readStates: [...READ_STATES, goneRead(1, 3)],
      messages: 'pending',
    });
    await waitFor(() => expect(goneMessageCalls(fetchMock)).toHaveLength(1));
    await settledHidden();
    expect(screen.queryByTestId(GONE_ROW)).toBeNull();
  });

  it('옛 서버: 메시지를 못 읽었으면 보인다 (모를 때 숨기는 쪽이 최악이다)', async () => {
    await mountHome({
      channels: withGone,
      readStates: [...READ_STATES, goneRead(1, 3)],
      messages: 'fail',
    });
    await waitFor(() => expect(screen.getByTestId(GONE_ROW)).toBeTruthy(), {timeout: 3000});
  });

  it('옛 서버: 멘션이 있는 DM 은 메시지를 읽지 않고 보인다 (사람이 부른 것이다)', async () => {
    const fetchMock = await mountHome({
      channels: withGone,
      readStates: [...READ_STATES, goneRead(3, 3, {mention_count: 1})],
      messages: AMBIENT,
    });
    await waitFor(() => expect(screen.getByTestId(GONE_ROW)).toBeTruthy());
    expect(goneMessageCalls(fetchMock)).toEqual([]);
  });

  it('옛 서버: 사람이 직접 한 「여기부터 안 읽음」 표시가 있는 DM 은 메시지를 읽지 않고 보인다', async () => {
    const fetchMock = await mountHome({
      channels: withGone,
      readStates: [...READ_STATES, goneRead(3, 3, {marked_unread_before_seq: 2})],
      messages: AMBIENT,
    });
    await waitFor(() => expect(screen.getByTestId(GONE_ROW)).toBeTruthy());
    expect(goneMessageCalls(fetchMock)).toEqual([]);
  });

  it('옛 서버: 안 읽음이 없는 나간 멤버 DM 은 메시지를 읽지 않고 숨는다', async () => {
    const fetchMock = await mountHome({channels: withGone, messages: AMBIENT});
    await settledHidden();
    expect(goneMessageCalls(fetchMock)).toEqual([]);
  });

  it('옛 서버: 안 읽은 사람 글이 오면 돌아오고, 읽으면 다시 숨는다', async () => {
    await mountHome({channels: withGone});
    await settledHidden();
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
    (globalThis.fetch as jest.Mock).mockImplementation(async (url: string) =>
      String(url).includes('/messages')
        ? jsonResponse(200, {messages: [wireMessage(2, 'text')]})
        : jsonResponse(200, {}),
    );
    act(() => {
      queryClient!.setQueryData(workspaceKeys.readState(WS), projection(1, 3));
    });
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 300));
    });
    await waitFor(() => expect(screen.getByTestId(GONE_ROW)).toBeTruthy());
    await settleAfter(() => {
      queryClient!.setQueryData(workspaceKeys.readState(WS), projection(3, 3));
    });
    expect(screen.queryByTestId(GONE_ROW)).toBeNull();
    expect(hasClosedDoor()).toBe(true);
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
    // 제목과 설명이 같은 말투(해요체)다.
    expect(notice).toHaveTextContent(/안 읽음 표시를 불러오지 못했어요\./);
    expect(notice).toHaveTextContent(/나간 멤버와의 대화도 접지 못했어요\./);
    expect(notice).not.toHaveTextContent(/습니다/);
    expect(notice).not.toHaveTextContent(/목록은 그대로/);
    // 접지 않는다: 나간 멤버 DM 이 목록에 있고 「닫은 대화」 문은 없다.
    expect(screen.getByTestId(GONE_ROW)).toBeTruthy();
    expect(dmMenu()).not.toContain(DM_CLOSED_LIST_LABEL);
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
    expect(notice).toHaveTextContent(/안 읽음 표시를 불러오지 못했습니다\./);
    expect(notice).toHaveTextContent(/목록은 그대로이고, 안 읽은 개수만 지금 알 수 없습니다\./);
    expect(notice).not.toHaveTextContent(/접지 못했어요/);
  });

  // ---- 서버가 닫기를 싣는 투영 (ADR-0177 증보 D8) ---------------------------------------------
  //
  // 행이 `latest_readable_seq`·`closed_at_seq` 를 싣는다. 이 갈래는 서버가 이미 아는 것을 다시 계산하지 않는다: 메시지를 읽지 않는다.
  const serverRow = (
    channelId: string,
    lastRead: number,
    latest: number,
    closedAt: number | null,
    extra: Record<string, unknown> = {},
  ) => ({
    channel_id: channelId,
    last_read_seq: lastRead,
    latest_seq: latest,
    unread_count: Math.max(0, latest - lastRead),
    mention_count: 0,
    latest_readable_seq: latest,
    closed_at_seq: closedAt,
    ...extra,
  });
  /** 모든 행이 서버 갈래의 말을 싣는다(새 서버는 모든 행에 싣는다). 사람 DM 은 다 읽었다. */
  const serverRows = (humanClosedAt: number | null) => [
    serverRow('ch-agent-lab', 10, 12, null),
    serverRow('ch-general', 10, 15, null),
    serverRow('ch-dm-agent', 1, 2, null),
    serverRow('ch-dm-human', 4, 4, humanClosedAt),
  ];

  it('내가 닫은 DM(closed_at_seq ≥ 읽을 seq)은 목록에서 사라지고 「닫은 대화」 시트에 「내가 닫았어요」로 선다', async () => {
    const fetchMock = await mountHome({channels: withGone, readStates: serverRows(4)});
    await settledHidden();
    expect(screen.queryByTestId(HUMAN_ROW)).toBeNull();
    // 서버 갈래: 안 읽은 쪽 메시지를 다시 읽지 않는다(메시지 호출이 아예 없다).
    expect(goneMessageCalls(fetchMock)).toEqual([]);
    openClosedSheet();
    const item = await screen.findByTestId('dm-closed-item-ch-dm-human');
    expect(item).toHaveTextContent(/내가 닫았어요/);
    expect(within(screen.getByTestId('dm-closed-reopen-ch-dm-human')).getByText('다시 열기')).toBeTruthy();
    expect(within(screen.getByTestId('dm-closed-reopen-ch-dm-human')).queryByText('열기')).toBeNull();
    expect(screen.getByTestId('dm-closed-hint')).toHaveTextContent(
      /새 메시지가 오면 닫은 대화는 사이드바로 돌아와요\./,
    );
  });

  it('서버 갈래: 나간 멤버 DM 의 안 읽음이 기계 메시지뿐이어도(읽을 seq 가 읽은 자리) 메시지를 읽지 않고 숨는다', async () => {
    const fetchMock = await mountHome({
      channels: withGone,
      readStates: [
        ...serverRows(null),
        serverRow('ch-dm-gone', 3, 6, null, {latest_readable_seq: 3}),
      ],
      messages: AMBIENT,
    });
    await settledHidden();
    expect(screen.queryByTestId(GONE_ROW)).toBeNull();
    expect(goneMessageCalls(fetchMock)).toEqual([]);
  });

  it('닫은 뒤 읽을 메시지가 오면 돌아온다 (되살림)', async () => {
    await mountHome({
      channels: withGone,
      readStates: [
        ...serverRows(4).slice(0, 3),
        serverRow('ch-dm-human', 4, 6, 4),
      ],
    });
    await waitFor(() => expect(screen.getByTestId(HUMAN_ROW)).toBeTruthy());
  });

  it('다른 기기에서 닫은 DM 은 다음 읽음 투영에서 폰에서도 사라지고, 다시 열면 돌아온다 (#4367 AC)', async () => {
    const routes: Routes = {channels: withGone, readStates: serverRows(null)};
    const fetchMock = await mountHome(routes);
    await waitFor(() => expect(screen.getByTestId(HUMAN_ROW)).toBeTruthy());
    await projectionLanded();
    // 다른 기기가 닫았다: 서버의 다음 투영이 closed_at_seq 를 싣는다.
    routes.readStates = serverRows(4);
    await reprojectReadStates(fetchMock);
    expect(screen.queryByTestId(HUMAN_ROW)).toBeNull();
    expect(hasClosedDoor()).toBe(true);
    // 다른 기기가 다시 열었다.
    routes.readStates = serverRows(null);
    await reprojectReadStates(fetchMock);
    expect(screen.getByTestId(HUMAN_ROW)).toBeTruthy();
  });

  it('「다시 열기」: 서버의 닫힘을 풀고(DELETE …/closure 한 번) 그 대화를 연다', async () => {
    const routes: Routes = {channels: withGone, readStates: serverRows(4)};
    await mountHome(routes);
    await settledHidden();
    // 서버가 풀린 상태로 답하게 한다(DELETE 가 서버에 닿은 뒤의 투영).
    const inner = globalThis.fetch as unknown as (url: string, init?: {method?: string}) => Promise<Response>;
    globalThis.fetch = jest.fn(async (url: string, init?: {method?: string}) => {
      if (init?.method === 'DELETE' && String(url).includes('/closure')) {
        routes.readStates = serverRows(null);
        return jsonResponse(204, {});
      }
      return inner(url, init);
    }) as unknown as typeof fetch;
    openClosedSheet();
    fireEvent.press(await screen.findByTestId('dm-closed-reopen-ch-dm-human'));
    await waitFor(() => expect(screen.getByTestId('conversation-pane')).toBeTruthy());
    const deletes = (globalThis.fetch as jest.Mock).mock.calls.filter(
      call => (call[1] as {method?: string} | undefined)?.method === 'DELETE',
    );
    expect(deletes).toHaveLength(1);
    expect(String(deletes[0][0])).toContain('/channels/ch-dm-human/closure');
    expect(screen.queryByTestId('dm-closed-sheet')).toBeNull();
  });

  it('「다시 열기」가 거절되면 시트가 그대로 서서 이유를 말하고, 대화는 열리지 않는다', async () => {
    await mountHome({channels: withGone, readStates: serverRows(4)});
    await settledHidden();
    const inner = globalThis.fetch as unknown as (url: string, init?: {method?: string}) => Promise<Response>;
    globalThis.fetch = jest.fn(async (url: string, init?: {method?: string}) =>
      init?.method === 'DELETE'
        ? jsonResponse(500, {error: {message: 'boom'}})
        : inner(url, init),
    ) as unknown as typeof fetch;
    openClosedSheet();
    fireEvent.press(await screen.findByTestId('dm-closed-reopen-ch-dm-human'));
    expect(await screen.findByTestId('dm-closed-error')).toHaveTextContent(DM_REOPEN_FAILURE);
    expect(screen.getByTestId('dm-closed-sheet')).toBeTruthy();
    expect(screen.queryByTestId('conversation-pane')).toBeNull();
  });

  it('「다시 열기」 답을 기다리는 동안 같은 버튼·다른 행의 탭은 대화를 열지 않는다 (이중 탭 방지)', async () => {
    await mountHome({channels: withGone, readStates: serverRows(4)});
    await settledHidden();
    const inner = globalThis.fetch as unknown as (url: string, init?: {method?: string}) => Promise<Response>;
    let release: (() => void) | undefined;
    globalThis.fetch = jest.fn(async (url: string, init?: {method?: string}) => {
      if (init?.method === 'DELETE') {
        await new Promise<void>(resolve => {
          release = resolve;
        });
        return jsonResponse(204, {});
      }
      return inner(url, init);
    }) as unknown as typeof fetch;
    openClosedSheet();
    const human = await screen.findByTestId('dm-closed-reopen-ch-dm-human');
    fireEvent.press(human);
    expect(screen.getByTestId('dm-closed-reopen-ch-dm-human').props.accessibilityState).toMatchObject({busy: true});
    fireEvent.press(screen.getByTestId('dm-closed-reopen-ch-dm-human'));
    fireEvent.press(screen.getByTestId('dm-closed-reopen-ch-dm-gone'));
    expect(screen.queryByTestId('conversation-pane')).toBeNull();
    const deletes = (globalThis.fetch as jest.Mock).mock.calls.filter(
      call => (call[1] as {method?: string} | undefined)?.method === 'DELETE',
    );
    expect(deletes).toHaveLength(1);
    await act(async () => {
      release?.();
    });
    await waitFor(() => expect(screen.getByTestId('conversation-pane')).toBeTruthy());
  });

  it('시트가 열린 채 목록이 비면(다른 기기에서 다시 열었다) 빈 상태를 말한다', async () => {
    const routes: Routes = {channels: [CHANNELS[1], CHANNELS[3], CHANNELS[4]], readStates: serverRows(4)};
    const fetchMock = await mountHome(routes);
    await settledHidden();
    openClosedSheet();
    await screen.findByTestId('dm-closed-item-ch-dm-human');
    routes.readStates = serverRows(null);
    await reprojectReadStates(fetchMock);
    expect(screen.getByTestId('dm-closed-empty')).toHaveTextContent(/닫은 대화가 없어요\./);
  });

  it('닫은 DM 뿐이고 채널이 없어도 DM 섹션 머리가 서서 시트로 돌아갈 길이 있다', async () => {
    await mountHome({channels: [CHANNELS[4]], readStates: [serverRow('ch-dm-human', 4, 4, 4)]});
    await settledHidden();
    expect(screen.queryByTestId('channels-empty')).toBeNull();
    expect(screen.queryByTestId(HUMAN_ROW)).toBeNull();
  });

  it('대화 하나는 묶음 카드의 행 하나이고, 맨 아래 「닫기」 줄·외곽선 「다시 열기」 단추는 없다 (#4458)', async () => {
    await mountHome({channels: withGone, readStates: serverRows(4)});
    await settledHidden();
    openClosedSheet();
    await screen.findByTestId('dm-closed-sheet');
    expect(screen.UNSAFE_getAllByType(GroupCard)).toHaveLength(1);
    // 닫은 대화 둘(내가 닫은 것 · 상대가 나간 것) → 행 둘 → 구분선 하나(카드가 그린다).
    await screen.findByTestId('dm-closed-item-ch-dm-gone');
    await screen.findByTestId('dm-closed-item-ch-dm-human');
    expect(screen.getAllByTestId(/^dm-closed-item-/)).toHaveLength(2);
    expect(screen.getAllByTestId('group-divider')).toHaveLength(1);
    // 행 전체가 동사다: 이름 줄과 동사 단추가 따로 있지 않다.
    const reopenRow = screen.getByTestId('dm-closed-reopen-ch-dm-gone');
    expect(reopenRow.props.accessibilityRole).toBe('button');
    expect(within(screen.getByTestId('dm-closed-item-ch-dm-gone')).getAllByRole('button')).toHaveLength(1);
    expect(screen.queryByText('닫기')).toBeNull();
  });

  describeCloseContract({
    name: 'DmClosedSheet',
    open: async () => {
      await mountHome({channels: withGone});
      await settledHidden();
      openClosedSheet();
      await screen.findByTestId('dm-closed-sheet');
    },
    // 부모(사이드바)가 시트를 걷는다 — 시트가 사라졌으면 「닫아 달라」고 한 것이다.
    closedCount: () => (screen.queryByTestId('dm-closed-sheet') === null ? 1 : 0),
    closeTestID: 'dm-closed-close',
    closeLabel: '닫은 대화 닫기',
    scrimTestID: 'dm-closed-backdrop',
    scrimLabel: '닫은 대화 닫기',
  });
});

// =============================================================================
// #4953 — 폰 홈 채널 줄의 네 상태를 **실제 화면**에서 잰다 (라이트·다크 둘 다).
//
// 판정(`rowEmphasis`)과 줄에 싣는 길은 `sidebarRowEmphasis.test.ts` 가 잰다. 여기서 재는 것은 그 판정이 **색 토큰으로
// 옮겨져 화면에 나온다는 것**이다: 이름·아이콘의 색, 칩의 채움·글자 색, 칩 숫자. 기대값은 스킴마다 그 스킴의 팔레트
// 낱값 그대로이고(「둘 중 하나」가 아니다), 두 스킴에서 같은 뜻 — 회색 ↔ 진한 글자 — 이어야 한다.
//
// 큰 글씨는 jest 가 레이아웃을 재지 못해 **구조**로 잰다(아래 마지막 둘). 눈으로 보는 캡처는 스택 검증의 몫이다.
// =============================================================================

const HUSH_CHANNEL = {id: 'ch-hush', workspaceId: WS, kind: 'public', name: 'hush', muted: true};
const STATE_CHANNELS = [...CHANNELS, HUSH_CHANNEL];
const STATE_READS = [
  ...READ_STATES,
  {channel_id: 'ch-hush', last_read_seq: 0, latest_seq: 4, unread_count: 4, mention_count: 0},
];

async function mountHomeIn(scheme: 'light' | 'dark', routes: Routes = {}) {
  const fetchMock = installFetch(routes);
  queryClient = new QueryClient({
    defaultOptions: {
      queries: {retry: false, gcTime: 0},
      mutations: {retry: false, gcTime: 0},
    },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <FixedScheme scheme={scheme}>
        <AppShell member={SELF} />
      </FixedScheme>
    </QueryClientProvider>,
  );
  await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy());
  return fetchMock;
}

function channelRowEl(id: string) {
  return screen.getByTestId(`sidebar-row-channel:${id}`);
}

function titleStyle(id: string, name: string): Record<string, unknown> {
  return flat(within(channelRowEl(id)).getByText(name).props.style);
}

function chipIds(id: string): string[] {
  return within(channelRowEl(id))
    .queryAllByTestId(/^home-badge-/)
    .map(node => node.props.testID as string);
}

describe.each([
  ['라이트', 'light', lightPalette],
  ['다크', 'dark', darkPalette],
] as const)('홈 — 채널 줄의 네 상태, %s 스킴 (#4953)', (_name, scheme, p) => {
  async function mountStates() {
    await mountHomeIn(scheme, {channels: STATE_CHANNELS, readStates: STATE_READS});
    await waitFor(() =>
      expect(within(channelRowEl('ch-general')).getByTestId('home-badge-unread')).toBeTruthy(),
    );
  }

  it('읽음 — 이름·아이콘이 회색(textMuted)이고 굵지 않고, 칩이 없다', async () => {
    await mountStates();
    const title = titleStyle('ch-design', 'design-2.0');
    expect(title.color).toBe(p.textMuted);
    expect(title.fontWeight).not.toBe('700');
    const icon = within(channelRowEl('ch-design')).getByTestId('home-row-lock');
    expect(flat(icon.props.style).tintColor).toBe(p.textMuted);
    expect(chipIds('ch-design')).toEqual([]);
  });

  it('안 읽음 — 이름·아이콘이 본문색(text)이고 굵고, 신호색 칩이 5 를 말한다', async () => {
    await mountStates();
    const title = titleStyle('ch-general', 'general');
    expect(title.color).toBe(p.text);
    expect(title.fontWeight).toBe('700');
    const icon = within(channelRowEl('ch-general')).getByTestId('home-row-hash');
    expect(flat(icon.props.style).tintColor).toBe(p.text);
    expect(chipIds('ch-general')).toEqual(['home-badge-unread']);
    const chip = within(channelRowEl('ch-general')).getByTestId('home-badge-unread');
    expect(flat(chip.props.style).backgroundColor).toBe(p.accent);
    expect(flat(within(chip).getByText('5').props.style).color).toBe(p.onAccent);
  });

  it('멘션 — 칩 하나가 잉크 @2 이고(안 읽음 2 는 칩에 오르지 않는다), 이름은 본문색·굵게', async () => {
    await mountStates();
    const title = titleStyle('ch-agent-lab', 'agent-lab');
    expect(title.color).toBe(p.text);
    expect(title.fontWeight).toBe('700');
    expect(chipIds('ch-agent-lab')).toEqual(['home-badge-mention']);
    const chip = within(channelRowEl('ch-agent-lab')).getByTestId('home-badge-mention');
    expect(flat(chip.props.style).backgroundColor).toBe(p.primary);
    expect(flat(within(chip).getByText('@2').props.style).color).toBe(p.onPrimary);
  });

  it('음소거 — 새 글이 4 개 있어도 이름·아이콘이 회색·굵지 않음이고, 칩은 신호색도 잉크도 아닌 흐린 칩이다', async () => {
    await mountStates();
    const title = titleStyle('ch-hush', 'hush');
    expect(title.color).toBe(p.textMuted);
    expect(title.fontWeight).not.toBe('700');
    const icon = within(channelRowEl('ch-hush')).getByTestId('home-row-hash');
    expect(flat(icon.props.style).tintColor).toBe(p.textMuted);
    expect(chipIds('ch-hush')).toEqual(['home-badge-muted']);
    const chip = within(channelRowEl('ch-hush')).getByTestId('home-badge-muted');
    const fill = flat(chip.props.style).backgroundColor;
    expect(fill).toBe(p.surfaceMuted);
    expect([p.accent, p.primary]).not.toContain(fill);
    expect(flat(within(chip).getByText('4').props.style).color).toBe(p.textMuted);
    // 흐려도 읽혀야 한다: 이 짝(중성 채움 위 흐린 글자)은 새 토큰이 아니라 기존 둘의 조합이라, 대비는 여기서 잰다.
    expect(contrast(p.textMuted, p.surfaceMuted)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('홈 — 채널 줄의 아이콘과 큰 글씨 (#4953)', () => {
  it('아이콘 종류 — 공개는 #, 비공개는 자물쇠, DM 은 글리프 없이 상대 얼굴', async () => {
    await mountHomeIn('light', {channels: STATE_CHANNELS, readStates: STATE_READS});
    // testID 는 이미지와 따로 계산된다 — 그래서 **실제로 그려지는 자산**을 잰다. 두 자산이 구별되지 않으면 아래 단정은
    // 아이콘이 뒤바뀌어도 초록이다(사보타주가 한 번 그렇게 통과했다).
    expect(HOME_ICONS.hash).not.toEqual(HOME_ICONS.lock);
    const general = channelRowEl('ch-general');
    expect(within(general).getByTestId('home-row-hash').props.source).toBe(HOME_ICONS.hash);
    expect(within(general).queryByTestId('home-row-lock')).toBeNull();
    const design = channelRowEl('ch-design');
    expect(within(design).getByTestId('home-row-lock').props.source).toBe(HOME_ICONS.lock);
    expect(within(design).queryByTestId('home-row-hash')).toBeNull();
    const dm = screen.getByTestId('sidebar-row-dm:ch-dm-human');
    expect(within(dm).queryByTestId('home-row-hash')).toBeNull();
    expect(within(dm).queryByTestId('home-row-lock')).toBeNull();
    expect(within(dm).getByTestId('avatar-initial', {includeHiddenElements: true})).toBeTruthy();
  });

  it('큰 글씨에서 칩이 잘리지 않는 구조 — 칩은 자라고, 모자란 폭은 이름이 먼저 내준다, 아이콘은 줄 높이를 흔들지 않는다', async () => {
    await mountHomeIn('light', {channels: STATE_CHANNELS, readStates: STATE_READS});
    await waitFor(() =>
      expect(within(channelRowEl('ch-general')).getByTestId('home-badge-unread')).toBeTruthy(),
    );
    const rowEl = channelRowEl('ch-general');
    const chip = within(rowEl).getByTestId('home-badge-unread');
    const box = flat(chip.props.style);
    // 높이·너비는 하한뿐이다: 고정 높이였다면 글자가 커질 때 칩이 글자를 자른다.
    expect(box.minWidth).toBe(HOME.badge);
    expect(box.minHeight).toBe(HOME.badge);
    for (const fixed of ['width', 'height', 'maxWidth', 'maxHeight', 'overflow']) {
      expect(box[fixed]).toBeUndefined();
    }
    // 줄어들지 않는 flex 자식이다: 폭이 모자라면 칩이 아니라 이름이 줄어든다.
    expect(box.flexShrink ?? 0).toBe(0);
    const title = within(rowEl).getByText('general');
    expect(flat(title.props.style).flexShrink).toBe(1);
    expect(title.props.numberOfLines).toBe(1);
    // 칩 글자는 컨트롤 글자의 상한을 따른다(이름만 끝까지 커진다).
    expect(within(chip).getByText('5').props.maxFontSizeMultiplier).toBe(BAR_CONTROL_MAX_SCALE);
    // 줄은 최소 높이뿐이고, 아이콘은 글자 배율과 무관한 고정 22 다.
    const rowStyle = flat(rowEl.props.style);
    expect(rowStyle.minHeight).toBe(HOME.row);
    expect(rowStyle.height).toBeUndefined();
    const icon = flat(within(rowEl).getByTestId('home-row-hash').props.style);
    expect(icon.width).toBe(HOME_ICON_SIZE.hash);
    expect(icon.height).toBe(HOME_ICON_SIZE.hash);
  });

  it('읽음 투영이 실패하면 새 글 없는 줄을 회색으로 칠하지 않는다 — 실패 안내가 선 채, 음소거만 회색이다', async () => {
    await mountHomeIn('dark', {channels: STATE_CHANNELS, readStatesFail: true});
    await screen.findByTestId('read-state-error');
    // 안 읽음 수를 모르는 줄은 「다 읽었다」가 아니라 모름이다: 본문색.
    expect(titleStyle('ch-design', 'design-2.0').color).toBe(darkPalette.text);
    expect(titleStyle('ch-general', 'general').color).toBe(darkPalette.text);
    expect(chipIds('ch-general')).toEqual([]);
    // 음소거는 읽음 투영이 아니라 채널이 말하는 사실이다.
    expect(titleStyle('ch-hush', 'hush').color).toBe(darkPalette.textMuted);
  });
});

// 섹션 머리의 글리프는 [머리 아이콘, 메뉴(…), 접기(⌄)] 세 개다 (`SectionHead`).
function headGlyphs(key: 'channels' | 'dms') {
  return within(screen.getByTestId(`home-section-${key}`)).UNSAFE_queryAllByType(Image);
}

describe.each([
  ['라이트', 'light', lightPalette],
  ['다크', 'dark', darkPalette],
] as const)('홈 — 섹션 머리 아이콘, %s 스킴 (#4979)', (_name, scheme, p) => {
  it('채널 머리는 줄의 #·자물쇠가 아닌 layers, DM 머리는 dms 그대로다 — 실제로 그려지는 자산을 잰다', async () => {
    // testID 는 이미지와 따로 계산된다(#4953) — 그래서 머리가 **실제로 그리는 자산**을 잰다. 등록한 자산이 옛 것과 구별되지
    // 않으면 아래 단정은 머리가 옛 `#` 로 돌아가도 초록이다(`layers` 가 `hash.png` 를 가리키는 사보타주).
    expect(HOME_ICONS.layers).not.toEqual(HOME_ICONS.hash);
    expect(HOME_ICONS.layers).not.toEqual(HOME_ICONS.lock);
    expect(HOME_ICONS.layers).not.toEqual(HOME_ICONS.dms);
    await mountHomeIn(scheme);
    expect(headGlyphs('channels').map(node => node.props.source)).toEqual([
      HOME_ICONS.layers,
      HOME_ICONS.more,
      HOME_ICONS.down,
    ]);
    // DM 머리는 손대지 않는다: 아이콘은 `dms`, 뒤의 두 글리프는 채널 머리와 같다.
    expect(headGlyphs('dms').map(node => node.props.source)).toEqual([
      HOME_ICONS.dms,
      HOME_ICONS.more,
      HOME_ICONS.down,
    ]);
  });

  it('머리 아이콘은 22 이고 본문색(text)으로 칠한다 — tintColor 로 칠하는 PNG 라 색이 빠지면 검은 채로 남는다', async () => {
    await mountHomeIn(scheme);
    const icon = flat(headGlyphs('channels')[0].props.style);
    expect(icon.width).toBe(HOME_ICON_SIZE.layers);
    expect(icon.height).toBe(HOME_ICON_SIZE.layers);
    expect(icon.tintColor).toBe(p.text);
  });

  it('접근성은 그대로다 — 이름은 머리 글자가 말하고 아이콘은 장식이다', async () => {
    await mountHomeIn(scheme);
    const head = screen.getByTestId('home-section-channels');
    expect(within(head).getByRole('header')).toHaveTextContent('채널');
    expect(screen.getByTestId('home-section-menu-channels').props.accessibilityLabel).toBe(
      '채널 섹션 메뉴',
    );
    expect(screen.getByTestId('home-section-toggle-channels').props.accessibilityLabel).toBe(
      '채널 섹션',
    );
    // 머리 아이콘에는 이름도 대체 글도 없고 보조기술이 따로 멈추는 자리도 아니다.
    const props = headGlyphs('channels')[0].props;
    expect(props.accessibilityLabel).toBeUndefined();
    expect(props.alt).toBeUndefined();
    expect(props.accessible).not.toBe(true);
  });
});

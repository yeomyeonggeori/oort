import type {Member, WorkSession} from '@momo/core/lib/api';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react-native';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import {AccessibilityInfo, StyleSheet} from 'react-native';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {
  darkPalette,
  lightPalette,
  TOUCH_TARGET,
} from '../src/design/tokens';
import {
  WORK_CONSOLE_LIMIT,
  workConsoleSessions,
  workSessionRecentTimeLabel,
} from '../src/features/work/model';
import AppShell from '../src/shell/AppShell';
import {
  __resetSessionStore,
  sessionPort,
} from '../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';

// The RN Jest renderer has no native tag, so its default findNodeHandle returns
// null. Give accessibility-focus tests a stable native seam while leaving the
// rest of RendererProxy unchanged.
jest.mock('react-native/Libraries/ReactNative/RendererProxy', () => ({
  ...jest.requireActual('react-native/Libraries/ReactNative/RendererProxy'),
  findNodeHandle: jest.fn(() => 1292),
}));

const WS = '22222222-2222-4222-8222-222222222222';
const SELF_ID = '11111111-1111-4111-8111-111111111111';
const AGENT_ID = 'cccccccc-1111-4111-8111-cccccccccccc';
const BASE = 'https://api.example.com';
const NOW = 1_786_435_200_000;

const SELF: Member = {
  id: SELF_ID,
  workspaceId: WS,
  kind: 'human',
  displayName: '곽성재',
  handle: 'seongjae',
};

const LOGIN_BODY = {
  accessToken: 'access-token-1',
  refreshToken: 'refresh-token-1',
  realtimeWebSocketUrl: 'wss://api.example.com/connection/websocket',
  member: SELF,
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
  rosterMember({
    id: 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb',
    displayName: '김인턴',
    handle: 'intern-kim',
  }),
  rosterMember({
    id: AGENT_ID,
    kind: 'agent',
    displayName: '김인턴',
    handle: 'kim-intern',
    paused: false,
  }),
];

const CHANNELS = [
  {
    id: 'ch-general',
    workspaceId: WS,
    kind: 'public',
    name: 'general',
    muted: false,
  },
];

function workSession(over: Partial<WorkSession> & {id: string}): WorkSession {
  return {
    workspaceId: WS,
    channelId: 'ch-general',
    memberId: AGENT_ID,
    hostId: 'HOST-APP',
    rootMessageId: `root-${over.id.toLowerCase()}`,
    tool: 'codex',
    label: '작업',
    status: 'running',
    observation: 'open',
    observerGrantCount: 0,
    remoteAttachAvailable: false,
    startedAtMs: NOW,
    ...over,
  };
}

const WORK_SESSIONS: WorkSession[] = [
  workSession({
    id: 'SESSION-CLOUD',
    hostId: 'HOST-CLOUD',
    label: '완료된 클라우드 작업',
    tool: 'claude',
    status: 'ended',
    // Newer than every active row: status rank must still put it last.
    startedAtMs: NOW + 10_000,
    endedAtMs: NOW + 20_000,
  }),
  workSession({
    id: 'SESSION-UNKNOWN',
    hostId: 'HOST-MISSING',
    label: '호스트가 사라진 작업',
    tool: 'hermes',
    status: 'orphaned',
    startedAtMs: NOW - 10_000,
  }),
  workSession({
    id: 'SESSION-WORKD',
    hostId: 'HOST-WORKD',
    label: '셀프호스트 대기 작업',
    tool: 'prime',
    status: 'idle',
    startedAtMs: NOW - 20_000,
  }),
  workSession({
    id: 'SESSION-APP',
    hostId: 'HOST-APP',
    label: '릴레이 재시작 절차',
    tool: 'codex',
    status: 'running',
    startedAtMs: NOW - 30_000,
  }),
];

const WORK_HOSTS = [
  {
    id: 'HOST-APP',
    workspaceId: WS,
    scope: 'member',
    ownerMemberId: SELF_ID,
    type: 'app',
    displayName: '성재 맥북',
    capabilities: {},
    createdAtMs: 0,
    online: true,
  },
  {
    id: 'HOST-WORKD',
    workspaceId: WS,
    scope: 'workspace',
    ownerMemberId: SELF_ID,
    type: 'workd',
    displayName: '서울 셀프호스트',
    capabilities: {},
    createdAtMs: 0,
    online: true,
  },
  {
    id: 'HOST-CLOUD',
    workspaceId: WS,
    scope: 'workspace',
    ownerMemberId: SELF_ID,
    type: 'cloud',
    displayName: 'oort 클라우드',
    capabilities: {},
    createdAtMs: 0,
    online: true,
  },
];

function eventMessage(
  id: string,
  seq: number,
  event: Record<string, unknown>,
) {
  return {
    id,
    channelId: 'ch-general',
    seq,
    hlcTs: NOW + seq,
    hlcCount: 0,
    authorMemberId: AGENT_ID,
    type: 'system',
    // Typed work rows never render this transport body.
    body: 'DO_NOT_RENDER_MESSAGE_BODY',
    state: 'sent',
    createdAtMs: NOW + seq,
    props: {
      kind: 'work_session_event',
      schema: 'momo.work_session.acp_event.v1',
      event_type: 'agent.status',
      event_id: id,
      event_ts: NOW + seq,
      event: {work_session_id: 'SESSION-APP', ...event},
    },
  };
}

const SESSION_EVENTS = [
  eventMessage('EVENT-1', 1, {terminal_event: 'created'}),
  eventMessage('EVENT-2', 2, {
    tool_call_name: 'read_file',
    detail: '구성 파일을 확인했습니다.',
    command: 'DO_NOT_RENDER_RAW_COMMAND',
    plan: [
      {content: '구성 확인', status: 'completed'},
      {content: '회귀 테스트', status: 'in_progress'},
    ],
  }),
];

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

interface RouteOverrides {
  workSessions?: () => Response | Promise<Response>;
  workHosts?: () => Response | Promise<Response>;
  sessionEvents?: () => Response | Promise<Response>;
}

function installFetch(overrides: RouteOverrides = {}): jest.Mock {
  const mock = jest.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('/work-sessions')) {
      return overrides.workSessions
        ? overrides.workSessions()
        : jsonResponse(200, {workSessions: WORK_SESSIONS});
    }
    if (url.includes('/work-hosts')) {
      return overrides.workHosts
        ? overrides.workHosts()
        : jsonResponse(200, {workHosts: WORK_HOSTS});
    }
    if (url.includes('/replies')) {
      return overrides.sessionEvents
        ? overrides.sessionEvents()
        : jsonResponse(200, {messages: SESSION_EVENTS});
    }
    if (url.includes('/reactions')) return jsonResponse(200, {});
    if (url.includes('/channels') && !url.includes('/messages')) {
      return jsonResponse(200, {channels: CHANNELS});
    }
    if (url.includes('/roster')) return jsonResponse(200, {members: ROSTER});
    if (url.includes('/read-state')) {
      return jsonResponse(200, {read_states: []});
    }
    if (url.includes('/approvals')) return jsonResponse(200, {approvals: []});
    if (url.includes('/messages')) return jsonResponse(200, {messages: []});
    throw new Error(`unrouted request: ${url}`);
  });
  globalThis.fetch = mock as unknown as typeof fetch;
  return mock;
}

let queryClient: QueryClient | null = null;

function renderShell(): ReturnType<typeof render> {
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

beforeEach(() => {
  mmkvStore.clear();
  __resetSessionStore();
  __resetServerBaseCache();
  setServerBase(BASE);
  sessionPort.applyLogin(LOGIN_BODY);
});

afterEach(() => {
  cleanup();
  queryClient?.clear();
  queryClient = null;
  jest.useRealTimers();
});

async function openWorkTab(): Promise<void> {
  renderShell();
  await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy());
  fireEvent.press(screen.getByTestId('tab-work'));
  await waitFor(() => expect(screen.getByTestId('work-list')).toBeTruthy());
}

describe('workspace-wide 작업 tab', () => {
  it('mounts lazily, then shows running-first rows with exact shared location labels', async () => {
    const fetchMock = installFetch();
    renderShell();
    await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy());
    expect(screen.getByTestId('tab-work')).toBeTruthy();
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes('/work-sessions')),
    ).toBe(false);

    fireEvent.press(screen.getByTestId('tab-work'));
    expect(screen.getByTestId('work-loading')).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('work-list')).toBeTruthy());
    expect(screen.getByTestId('work-title')).toHaveTextContent('작업 콘솔');

    expect(
      screen.getAllByTestId(/^work-row-/).map(node => node.props.testID),
    ).toEqual([
      'work-row-SESSION-APP',
      'work-row-SESSION-WORKD',
      'work-row-SESSION-UNKNOWN',
      'work-row-SESSION-CLOUD',
    ]);
    expect(screen.getByTestId('work-location-SESSION-APP')).toHaveTextContent(
      /T1 · 데스크톱 앱/,
    );
    expect(screen.getByTestId('work-location-SESSION-WORKD')).toHaveTextContent(
      /T2 · 셀프호스트/,
    );
    expect(screen.getByTestId('work-location-SESSION-CLOUD')).toHaveTextContent(
      /T3 · 클라우드/,
    );
    expect(screen.getByTestId('work-location-SESSION-UNKNOWN')).toHaveTextContent(
      /실행 위치 확인 필요/,
    );
    expect(screen.getByTestId('work-row-SESSION-APP')).toHaveTextContent(
      /general · 담당 김인턴 @kim-intern/,
    );
    expect(screen.getByTestId('work-row-SESSION-APP')).toHaveTextContent(
      /도구 codex · 시작 \d{2}:\d{2}/,
    );
    expect(screen.getByTestId('work-row-SESSION-WORKD')).toHaveTextContent(
      /도구 prime · 시작 \d{2}:\d{2}/,
    );
    expect(screen.getByTestId('work-row-SESSION-UNKNOWN')).toHaveTextContent(
      /도구 hermes · 시작 \d{2}:\d{2}/,
    );
    expect(screen.getByTestId('work-row-SESSION-CLOUD')).toHaveTextContent(
      /도구 claude · 종료 \d{2}:\d{2}/,
    );
    expect(screen.getByTestId('work-location-SESSION-UNKNOWN')).toHaveProp(
      'accessibilityLabel',
      '실행 위치를 확인해야 합니다',
    );

    fireEvent.press(screen.getByTestId('work-filter-active'));
    expect(screen.getAllByTestId(/^work-row-/).map(node => node.props.testID)).toEqual([
      'work-row-SESSION-APP',
      'work-row-SESSION-WORKD',
    ]);
  });

  it('keeps the visited tab mounted without polling its ledger while hidden', async () => {
    const fetchMock = installFetch();
    await openWorkTab();
    const reads = () =>
      fetchMock.mock.calls.filter(([url]) => String(url).includes('/work-sessions'))
        .length;
    const before = reads();
    fireEvent.press(screen.getByTestId('tab-channels'));
    jest.useFakeTimers();
    act(() => jest.advanceTimersByTime(120_000));
    expect(reads()).toBe(before);
  });

  it('renders an empty ledger as empty', async () => {
    installFetch({workSessions: () => jsonResponse(200, {workSessions: []})});
    renderShell();
    await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy());
    fireEvent.press(screen.getByTestId('tab-work'));
    await waitFor(() => expect(screen.getByTestId('work-empty')).toBeTruthy());
  });

  it('renders a failed first read as an error and retries it', async () => {
    let attempts = 0;
    installFetch({
      workSessions: () => {
        attempts += 1;
        return attempts === 1
          ? jsonResponse(500, {error: {message: 'DO_NOT_RENDER_SERVER_BODY'}})
          : jsonResponse(200, {workSessions: WORK_SESSIONS});
      },
    });
    renderShell();
    await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy());
    fireEvent.press(screen.getByTestId('tab-work'));
    await waitFor(() => expect(screen.getByTestId('work-error')).toBeTruthy());
    expect(screen.queryByText(/DO_NOT_RENDER_SERVER_BODY/)).toBeNull();
    fireEvent.press(screen.getByTestId('work-error-retry'));
    await waitFor(() => expect(screen.getByTestId('work-list')).toBeTruthy());
  });

  it('retains cached rows on refetch failure and when NetInfo goes offline', async () => {
    let fail = false;
    installFetch({
      workSessions: () =>
        fail
          ? jsonResponse(500, {error: {message: 'nope'}})
          : jsonResponse(200, {workSessions: WORK_SESSIONS}),
    });
    await openWorkTab();
    fail = true;
    await act(async () => {
      await queryClient?.invalidateQueries({queryKey: ['work-sessions', WS]});
    });
    await waitFor(() => expect(screen.getByTestId('work-stale-cached')).toBeTruthy());
    expect(screen.getByTestId('work-row-SESSION-APP')).toBeTruthy();

    const netInfo = jest.requireMock('@react-native-community/netinfo').default as {
      __emit: (state: {
        isConnected: boolean | null;
        isInternetReachable: boolean | null;
      }) => void;
    };
    act(() => {
      netInfo.__emit({isConnected: false, isInternetReachable: false});
    });
    await waitFor(() =>
      expect(screen.getByTestId('work-offline-cached')).toBeTruthy(),
    );
    expect(screen.getByTestId('work-row-SESSION-APP')).toBeTruthy();
  });
});

describe('read-only phone-native work detail', () => {
  it('shows typed plan/lifecycle/tool summaries, never raw payload/body, and returns from origin conversation', async () => {
    const focusSpy = jest
      .spyOn(AccessibilityInfo, 'setAccessibilityFocus')
      .mockImplementation(() => {});
    installFetch();
    await openWorkTab();
    fireEvent.press(screen.getByTestId('work-row-SESSION-APP'));

    expect(screen.getByTestId('work-detail-pane')).toHaveProp(
      'accessibilityViewIsModal',
      true,
    );
    await waitFor(() => expect(focusSpy).toHaveBeenCalled());
    const entryFocusCalls = focusSpy.mock.calls.length;
    expect(screen.getByTestId('work-detail-readonly')).toHaveTextContent(
      /작업 상태와 진행 요약만 보여 줍니다/,
    );
    expect(screen.getByTestId('work-detail-readonly')).toHaveTextContent(
      /터미널 화면이나 입력 내용, 실행 경로와 환경 정보는 표시하거나 기기에 저장하지 않습니다/,
    );
    expect(screen.getByTestId('work-detail-title')).toHaveProp(
      'accessibilityRole',
      'header',
    );
    await waitFor(() =>
      expect(screen.getByTestId('work-detail-plan')).toHaveTextContent(
        /구성 확인.*회귀 테스트/,
      ),
    );
    expect(screen.getByText('계획')).toHaveProp('accessibilityRole', 'header');
    expect(screen.getByTestId('work-detail-event-list')).toHaveTextContent(
      /세션을 시작함.*파일 읽는 중.*구성 파일을 확인했습니다/,
    );
    expect(screen.queryByText('read_file')).toBeNull();
    expect(screen.queryByText('DO_NOT_RENDER_RAW_COMMAND')).toBeNull();
    expect(screen.queryByText('DO_NOT_RENDER_MESSAGE_BODY')).toBeNull();

    fireEvent.press(screen.getByTestId('work-detail-origin'));
    await waitFor(() =>
      expect(screen.getByTestId('conversation-title')).toHaveTextContent('general'),
    );
    expect(screen.queryByTestId('work-detail-pane')).toBeNull();
    expect(
      screen.UNSAFE_getByProps({testID: 'work-detail-pane'}).props
        .accessibilityViewIsModal,
    ).toBe(false);
    expect(screen.getByTestId('conversation-pane')).toHaveProp(
      'accessibilityViewIsModal',
      true,
    );
    const backs = screen.getAllByTestId('header-back');
    fireEvent.press(backs[backs.length - 1]);
    await waitFor(() => expect(screen.queryByTestId('conversation-title')).toBeNull());
    expect(screen.getByTestId('work-detail-pane')).toHaveProp(
      'accessibilityViewIsModal',
      true,
    );
    await waitFor(() =>
      expect(focusSpy.mock.calls.length).toBeGreaterThan(entryFocusCalls),
    );
    const detailReturnFocusCalls = focusSpy.mock.calls.length;

    const detailBacks = screen.getAllByTestId('header-back');
    fireEvent.press(detailBacks[detailBacks.length - 1]);
    await waitFor(() => expect(screen.getByTestId('work-list')).toBeTruthy());
    await waitFor(() =>
      expect(focusSpy.mock.calls.length).toBeGreaterThan(detailReturnFocusCalls),
    );
  });

  it.each([
    [
      'SESSION-WORKD',
      /원격 호스트에서 대기 중인 세션입니다.*진행 내역 중계는 아직 검증되지 않았으므로/,
    ],
    [
      'SESSION-CLOUD',
      /원격 호스트에서 실행된 세션입니다.*진행 내역 중계는 아직 검증되지 않았으므로/,
    ],
    [
      'SESSION-UNKNOWN',
      /호스트를 확인하지 못했습니다.*진행 내역이 모두 도착했는지 보장할 수 없습니다/,
    ],
  ] as const)(
    'does not call an empty %s relay a complete empty ledger',
    async (sessionId, copy) => {
      installFetch();
      await openWorkTab();
      fireEvent.press(screen.getByTestId(`work-row-${sessionId}`));
      await waitFor(() =>
        expect(screen.getByTestId('work-detail-host-unverified')).toHaveTextContent(
          copy,
        ),
      );
      await waitFor(() =>
        expect(screen.queryByTestId('work-detail-events-loading')).toBeNull(),
      );
      expect(screen.queryByTestId('work-detail-events-empty')).toBeNull();
    },
  );

  it('keeps essential text scalable and every new direct control at least 44pt', async () => {
    installFetch();
    await openWorkTab();
    const filterStyle = StyleSheet.flatten(
      screen.getByTestId('work-filter-active').props.style,
    );
    expect(filterStyle.minHeight).toBeGreaterThanOrEqual(TOUCH_TARGET);
    expect([darkPalette.textFaint, lightPalette.textFaint]).toContain(
      filterStyle.borderColor,
    );
    const agentTabLabel = screen.getByTestId('tab-label-agents');
    const agentTabStyle = StyleSheet.flatten(agentTabLabel.props.style);
    expect(agentTabLabel.props.numberOfLines).toBeUndefined();
    expect(agentTabLabel.props.allowFontScaling).not.toBe(false);
    expect(agentTabStyle.flexShrink).toBe(1);
    expect(agentTabStyle.textAlign).toBe('center');
    expect(screen.getByTestId('work-title')).toHaveProp(
      'accessibilityRole',
      'header',
    );
    const title = screen.getByText('릴레이 재시작 절차');
    expect(title.props.numberOfLines).toBeUndefined();
    expect(title.props.allowFontScaling).not.toBe(false);

    fireEvent.press(screen.getByTestId('work-row-SESSION-APP'));
    const originStyle = StyleSheet.flatten(
      screen.getByTestId('work-detail-origin').props.style,
    );
    expect(originStyle.minHeight).toBeGreaterThanOrEqual(TOUCH_TARGET);
    for (const label of ['작업 정보', '진행 내역']) {
      expect(screen.getByText(label)).toHaveProp('accessibilityRole', 'header');
    }
  });
});

describe('bounded model and privacy boundary', () => {
  it('uses status as the timestamp fact and fails closed on a missing end time', () => {
    expect(
      workSessionRecentTimeLabel(
        workSession({id: 'ENDED-WITHOUT-TIME', status: 'ended'}),
      ),
    ).toBe('종료 시각 확인 필요');
    expect(
      workSessionRecentTimeLabel(
        workSession({
          id: 'RUNNING-WITH-STALE-END',
          status: 'running',
          endedAtMs: NOW + 60_000,
        }),
      ),
    ).toMatch(/^시작 \d{2}:\d{2}$/);
  });

  it('caps defensive rendering at the same 200 rows as the membership-scoped endpoint', () => {
    const many = Array.from({length: WORK_CONSOLE_LIMIT + 5}, (_, index) =>
      workSession({id: `SESSION-${index}`, startedAtMs: index}),
    );
    expect(workConsoleSessions(many, 'all')).toHaveLength(WORK_CONSOLE_LIMIT);
  });

  it('contains no terminal attach, WebView, secret, or durable-storage path', () => {
    const files = [
      '../src/features/work/queries.ts',
      '../src/screens/WorkConsoleScreen.tsx',
      '../src/screens/WorkSessionDetailScreen.tsx',
    ];
    const source = files
      .map(file => fs.readFileSync(path.resolve(__dirname, file), 'utf8'))
      .join('\n');
    expect(source).not.toMatch(
      /issueObserverTerminalAttach|TerminalAttachGrant|WebView|capability_token|attach_endpoint|pty_id|AsyncStorage|MMKV|console\.(?:log|info|warn|error)/,
    );
  });
});

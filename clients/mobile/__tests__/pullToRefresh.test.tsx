import type {Member} from '@momo/core/lib/api';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {act, cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react-native';
import React from 'react';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import AppShell from '../src/shell/AppShell';
import HostedConnectionsScreen from '../src/screens/HostedConnectionsScreen';
import {SessionProvider} from '../src/session/useSession';
import {CONNECTING_BAND_DELAY_MS} from '../src/realtime/connectionDisplay';
import {__resetSessionStore, sessionPort} from '../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';
import {
  installAppClock,
  SHELL_WAIT_TEST_TIMEOUT_MS,
} from './fixtures/fakeClock';

// =============================================================================
// 당겨서 새로고침 (goal RN-B4b / #1026)
//
// 성재 파이널 체크에서 나온 것 — 목록을 당겼는데 아무 일도 일어나지 않는다.
//
// 이 파일이 재는 것은 「컨트롤이 붙어 있다」가 아니라 **당김이 서버까지 간다**이다.
// 그래서 목은 `fetch` 하나뿐이고, 그 아래 react-query 배선·무효화·화면은 전부
// 진짜다. 컨트롤만 붙이고 재조회를 연결하지 않은 수정은 여기서 초록이 되지 않는다.
//
// 각 표면은 **이미 자기를 다시 읽는 법을 알고 있었다**(`refetch`/`invalidateQueries`).
// 그러니 이 배치가 더한 것은 조회 경로가 아니라 그 경로의 새 입구 하나이고, 아래
// 단정도 그렇게 쓰여 있다 — 당기기 전후로 **같은 라우트**가 다시 불렸는가.
//
// Owner 2026-10-30 (#4783): 「대화 화면 당겨서 새로고침 = 다시 맞추기」.
// connected 에서는 이전 이력을 다 읽은 뒤에만, 복구 중에는 이력이 남아 있어도 다시 맞춘다.
// =============================================================================

const WS = '22222222-2222-4222-8222-222222222222';
const SELF_ID = '11111111-1111-4111-8111-111111111111';
const BASE = 'https://api.example.com';

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
    id: 'cccccccc-1111-4111-8111-cccccccccccc',
    kind: 'agent',
    displayName: '김인턴',
    handle: 'kim-intern',
  }),
];

const CHANNELS = [
  {id: 'ch-general', workspaceId: WS, kind: 'public', name: 'general', muted: false},
];

const READ_STATES = [
  {
    channel_id: 'ch-general',
    last_read_seq: 10,
    latest_seq: 13,
    unread_count: 3,
    mention_count: 1,
  },
];

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** 목록을 비운다 — 빈 화면에서도 당길 수 있는가를 재는 두 테스트가 쓴다. */
interface Overrides {
  emptyRoster?: boolean;
  emptyChannels?: boolean;
  timelineHasOlder?: boolean;
}

function installFetch(overrides: Overrides = {}): jest.Mock {
  const mock = jest.fn(async (url: string) => {
    if (url.includes('/reactions')) return jsonResponse(200, {});
    // 인박스 투영이 없는 구 서버(ADR-0199): 404 -> 클라이언트 조합이 원장을 다시 읽는다.
    if (/\/inbox(\/|$)/.test(new URL(url).pathname)) {
      return jsonResponse(404, {error: {code: 'not_found', message: 'not found'}});
    }
    if (url.includes('/work-sessions')) return jsonResponse(200, {sessions: []});
    if (url.includes('/work-hosts')) return jsonResponse(200, {hosts: []});
    if (url.includes('/channels') && !url.includes('/messages')) {
      return jsonResponse(200, {
        channels: overrides.emptyChannels ? [] : CHANNELS,
      });
    }
    if (url.includes('/roster')) {
      return jsonResponse(200, {
        members: overrides.emptyRoster
          ? [rosterMember({id: SELF_ID, displayName: '곽성재', handle: 'seongjae'})]
          : ROSTER,
      });
    }
    if (url.includes('/read-state')) {
      return jsonResponse(200, {read_states: READ_STATES});
    }
    if (url.includes('/messages')) return jsonResponse(200, {messages:
      overrides.timelineHasOlder ? Array.from({length: 50}, (_, i) => ({
        id: `history-${i}`, channelId: 'ch-general', seq: i + 1,
        hlcTs: i + 1, hlcCount: 0, authorMemberId: SELF_ID, type: 'text',
        body: `history ${i}`, state: 'sent', createdAtMs: 1_800_000_000_000,
      })) : [],
      ...(overrides.timelineHasOlder ? {nextBefore: 1} : {}),
    });
    if (url.includes('/approvals')) return jsonResponse(200, {approvals: []});
    if (url.includes('/agent-runs') || url.includes('/runs')) {
      return jsonResponse(200, {runs: []});
    }
    throw new Error(`unrouted request: ${url}`);
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

/** 특정 라우트가 지금까지 몇 번 불렸는가. 당김의 증거는 이 숫자가 오르는 것이다. */
function callsTo(mock: jest.Mock, fragment: string): number {
  return mock.mock.calls.filter(([url]) => String(url).includes(fragment)).length;
}

/**
 * 손을 아래로 당겼다.
 *
 * `RefreshControl` 은 스크롤뷰의 **prop** 이지 자식이 아니라, 트리에서 testID 로
 * 집히지 않는다. 그래서 목록 자신에게 물어본다 — 컨트롤이 붙어 있지 않으면 이 줄이
 * 「당김 컨트롤이 없다」로 이름 있게 실패한다.
 */
function pull(surfaceTestID: string) {
  const control = screen.getByTestId(surfaceTestID).props.refreshControl;
  if (control === undefined || control === null) {
    throw new Error(`${surfaceTestID} 에 당김 컨트롤이 없다`);
  }
  act(() => {
    control.props.onRefresh();
  });
}

/**
 * 목록의 당김이 **받는 중**인가. 실제 컨트롤만 `onRefresh` 를 든다. 당김이 꺼져도 `refreshControl` 자리는 비지
 * 않는다(빈 요소) — 자리를 비웠다 채우면 RN iOS 가 내용 컨테이너를 통째로 다시 세운다(#4949, `Timeline` 의 `NoPullSlot`).
 */
function timelinePullIsLive(): boolean {
  const control = screen.getByTestId('timeline-list').props.refreshControl;
  return typeof control?.props?.onRefresh === 'function';
}

const mmkvStore = (
  jest.requireMock('react-native-mmkv') as {__store: Map<string, string>}
).__store;

jest.setTimeout(SHELL_WAIT_TEST_TIMEOUT_MS);

beforeEach(() => {
  installAppClock();
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

describe('채널 목록', () => {
  it('당기면 채널·명부·안 읽음을 다시 읽는다', async () => {
    const fetchMock = installFetch();
    renderShell();
    await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy());

    const before = {
      channels: callsTo(fetchMock, '/channels'),
      roster: callsTo(fetchMock, '/roster'),
      readState: callsTo(fetchMock, '/read-state'),
    };

    pull('sidebar-list');

    // 셋 전부다. 하나라도 빠지면 화면의 절반이 낡은 채로 남고, 당긴 사람은 그것을
    // 알 방법이 없다 — 목록은 새 것처럼 보인다.
    await waitFor(() => {
      expect(callsTo(fetchMock, '/channels')).toBeGreaterThan(before.channels);
      expect(callsTo(fetchMock, '/roster')).toBeGreaterThan(before.roster);
      expect(callsTo(fetchMock, '/read-state')).toBeGreaterThan(before.readState);
    });
  });

  it('참여한 채널이 없어도 당길 수 있다', async () => {
    // 빈 목록이야말로 당김이 가장 필요한 자리다. 「아직 참여한 채널이 없습니다」를
    // 의심하는 방법은 당기는 것 하나뿐이고, 당길 목록이 없다는 것은 구현의
    // 사정이지 사람의 사정이 아니다.
    const fetchMock = installFetch({emptyChannels: true, emptyRoster: true});
    renderShell();
    await waitFor(() => expect(screen.getByTestId('channels-empty')).toBeTruthy());

    const before = callsTo(fetchMock, '/channels');
    pull('channels-empty');
    await waitFor(() =>
      expect(callsTo(fetchMock, '/channels')).toBeGreaterThan(before),
    );
  });
});

describe('에이전트 탭', () => {
  it('당기면 명부와 작업 세션을 다시 읽는다', async () => {
    const fetchMock = installFetch();
    renderShell();
    await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy());
    // 탭이던 것이 + 메뉴의 행이 되었다 (ADR-0189 D1, #2714 → #2750).
    fireEvent.press(screen.getByTestId('shell-plus'));
    fireEvent.press(screen.getByTestId('plus-menu-ai'));
    fireEvent.press(screen.getByTestId('ai-row-agents'));
    await waitFor(() => expect(screen.getByTestId('agents-list')).toBeTruthy());

    const before = {
      roster: callsTo(fetchMock, '/roster'),
      sessions: callsTo(fetchMock, '/work-sessions'),
    };

    pull('agents-list');

    await waitFor(() => {
      expect(callsTo(fetchMock, '/roster')).toBeGreaterThan(before.roster);
      expect(callsTo(fetchMock, '/work-sessions')).toBeGreaterThan(before.sessions);
    });
  });

  it('에이전트가 하나도 없어도 당길 수 있다', async () => {
    const fetchMock = installFetch({emptyRoster: true});
    renderShell();
    await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy());
    // 탭이던 것이 + 메뉴의 행이 되었다 (ADR-0189 D1, #2714 → #2750).
    fireEvent.press(screen.getByTestId('shell-plus'));
    fireEvent.press(screen.getByTestId('plus-menu-ai'));
    fireEvent.press(screen.getByTestId('ai-row-agents'));
    await waitFor(() => expect(screen.getByTestId('agents-empty')).toBeTruthy());

    const before = callsTo(fetchMock, '/roster');
    pull('agents-empty');
    await waitFor(() => expect(callsTo(fetchMock, '/roster')).toBeGreaterThan(before));
  });
});

describe('인박스', () => {
  it('결정할 일이 없다는 화면에서도 당기면 원장을 다시 읽는다', async () => {
    // #1020 이 사는 자리다. 「지금 결정할 일이 없습니다」가 60초 동안 거짓이었던
    // 화면에서, 당김은 사람이 그 말을 의심할 수 있는 유일한 방법이었다.
    const fetchMock = installFetch();
    renderShell();
    await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy());
    fireEvent.press(screen.getByTestId('tab-inbox'));
    await waitFor(() => expect(screen.getByTestId('inbox-empty')).toBeTruthy());

    const before = callsTo(fetchMock, '/approvals');
    pull('inbox-empty');
    await waitFor(() =>
      expect(callsTo(fetchMock, '/approvals')).toBeGreaterThan(before),
    );
  });
});

describe('대화 당겨서 다시 맞추기 — owner 10-30 (#4783)', () => {
  it('이력을 모두 읽었으면 당겨서 소켓을 다시 열고 최신 메시지를 읽는다', async () => {
    const fetchMock = installFetch();
    renderShell();
    await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy());
    fireEvent.press(screen.getByTestId('sidebar-row-channel:ch-general'));
    // 머리 고지(#4789 headerContent)가 있으면 빈 상태는 바깥 스크롤 안에 서고, 당김은 그 바깥 스크롤이 받는다.
    const emptyPullTarget = () => screen.queryByTestId('timeline-empty-scroll') ? 'timeline-empty-scroll' : 'timeline-empty';
    await waitFor(() => expect(screen.getByTestId(emptyPullTarget()).props.refreshControl).toBeTruthy());
    const clients = (jest.requireMock('centrifuge') as {__clients: {connectCount: number}[]}).__clients;
    const client = clients[clients.length - 1];
    const connects = client.connectCount;
    const reads = callsTo(fetchMock, '/messages');
    pull(emptyPullTarget());
    await waitFor(() => expect(callsTo(fetchMock, '/messages')).toBeGreaterThan(reads));
    expect(client.connectCount).toBe(connects + 1);
  });

  it.each([CONNECTING_BAND_DELAY_MS, 10_000])('연결 복구 %dms 뒤에도 이전 이력이 남은 방을 당기면 다시 맞춘다', async elapsedMs => {
    const fetchMock = installFetch({timelineHasOlder: true});
    renderShell();
    await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy());
    fireEvent.press(screen.getByTestId('sidebar-row-channel:ch-general'));
    await waitFor(() => expect(screen.getByTestId('timeline-list')).toBeTruthy());
    expect(timelinePullIsLive()).toBe(false);
    const clients = (jest.requireMock('centrifuge') as {
      __clients: {connectCount: number; disconnect: () => void}[];
    }).__clients;
    const client = clients[clients.length - 1];
    act(() => {
      client.disconnect();
      jest.advanceTimersByTime(CONNECTING_BAND_DELAY_MS - 1);
    });
    // 끊긴 첫 1초는 띠가 조용하고(#4949) 당김의 문도 그대로다 — 「연결 복구 중」은 사람이 보는 띠가 선 동안이다.
    expect(timelinePullIsLive()).toBe(false);
    act(() => {
      jest.advanceTimersByTime(elapsedMs - (CONNECTING_BAND_DELAY_MS - 1));
    });
    await waitFor(() => expect(timelinePullIsLive()).toBe(true));
    const connects = client.connectCount;
    const reads = callsTo(fetchMock, '/messages');
    pull('timeline-list');
    await waitFor(() => expect(callsTo(fetchMock, '/messages')).toBeGreaterThan(reads));
    expect(client.connectCount).toBe(connects + 1);
    await waitFor(() => expect(timelinePullIsLive()).toBe(false));
  });

  it('연결됐고 더 읽을 이전 이력이 있으면 당김 대신 이전 대화를 불러온다', async () => {
    const fetchMock = installFetch({timelineHasOlder: true});
    renderShell();
    await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy());
    fireEvent.press(screen.getByTestId('sidebar-row-channel:ch-general'));
    await waitFor(() => expect(screen.getByTestId('timeline-list')).toBeTruthy());
    expect(timelinePullIsLive()).toBe(false);
    fireEvent(screen.getByTestId('timeline-list'), 'scrollBeginDrag');
    const reads = callsTo(fetchMock, '/messages');
    fireEvent(screen.getByTestId('timeline-list'), 'startReached', {distanceFromStart: 0});
    await waitFor(() => expect(callsTo(fetchMock, '/messages')).toBeGreaterThan(reads));
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('before=1'))).toBe(true);
  });
});

// =============================================================================
// 호스팅 연결 (#3962): 이 화면의 재조회는 옛 훅 때 `refetch().then(() => undefined)` 로 **결과를 버렸다**(훅이
// 결과를 안 봐서 필요했던 줄). 새 훅은 결과의 오류 상태를 읽어 실패 햅틱과 실패 안내를 내므로 결과를 그대로
// 돌려준다. 이 시험이 그 줄이 되살아나는 것을 막는다.
//
// red proof: `HostedConnectionsScreen` 의 재조회를 `refetch().then(() => undefined)` 로 되돌리면 → 붉다.
// =============================================================================
describe('호스팅 연결 당김 (#3962)', () => {
  const haptic = jest.requireMock('expo-haptics') as {__calls: string[]};
  const notifications = () => haptic.__calls.filter(c => c.startsWith('notification:'));

  it('목록 읽기가 실패하면 당김은 경고 햅틱과 실패 안내로 끝난다', async () => {
    haptic.__calls.length = 0;
    installFetch();
    const inner = globalThis.fetch as unknown as jest.Mock;
    let failHosted = false;
    globalThis.fetch = jest.fn(async (url: string, init?: unknown) => {
      if (String(url).includes('hosted')) {
        return failHosted
          ? jsonResponse(500, {error: {code: 'internal', message: 'x'}})
          : jsonResponse(200, {connections: []});
      }
      return inner(url, init);
    }) as unknown as typeof fetch;
    queryClient = new QueryClient({
      defaultOptions: {queries: {retry: false, gcTime: 0}, mutations: {retry: false, gcTime: 0}},
    });
    render(
      <QueryClientProvider client={queryClient}>
        <SessionProvider member={SELF}>
          <HostedConnectionsScreen onBack={() => undefined} onOpenConnection={() => undefined} />
        </SessionProvider>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('hosted-list-empty')).toBeTruthy());
    failHosted = true;
    pull('hosted-list-empty');
    await waitFor(() => expect(notifications()).toEqual(['notification:warning']), {timeout: 5000});
    // 이 화면은 읽기가 실패하면 목록을 통째로 오류 상태로 바꿔 스스로 말한다(머리가 선 빈 상태 스크롤뷰는 내려간다).
    expect(screen.queryByTestId('hosted-list-error')).not.toBeNull();
  });
});

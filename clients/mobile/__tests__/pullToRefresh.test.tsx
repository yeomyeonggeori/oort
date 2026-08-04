import type {Member} from '@momo/core/lib/api';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {act, cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react-native';
import React from 'react';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import AppShell from '../src/shell/AppShell';
import {__resetSessionStore, sessionPort} from '../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';

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
// 대화 타임라인은 일부러 빠져 있다(패킷 §Goal 2). 그 표면의 정본은 리얼타임이고,
// 당김은 위로 올라가는 이력 페이지네이션과 같은 제스처를 두고 다툰다. 마지막
// 테스트가 그 부재를 못 박는다 — 「빠뜨렸다」와 「빼기로 했다」는 다르다.
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
}

function installFetch(overrides: Overrides = {}): jest.Mock {
  const mock = jest.fn(async (url: string) => {
    if (url.includes('/reactions')) return jsonResponse(200, {});
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
    if (url.includes('/messages')) return jsonResponse(200, {messages: []});
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
    fireEvent.press(screen.getByTestId('tab-agents'));
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
    fireEvent.press(screen.getByTestId('tab-agents'));
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

describe('대화 타임라인은 빠져 있다 — 빠뜨린 것이 아니라', () => {
  it('타임라인에는 당김 컨트롤이 없다', async () => {
    installFetch();
    renderShell();
    await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy());
    fireEvent.press(screen.getByTestId('sidebar-row-channel:ch-general'));
    await waitFor(() =>
      expect(screen.queryByTestId('timeline-list') ?? screen.getByTestId('timeline-empty')).toBeTruthy(),
    );

    const list = screen.queryByTestId('timeline-list');
    if (list !== null) expect(list.props.refreshControl).toBeUndefined();
    // 리얼타임이 이 표면의 정본이고, 위로 당기는 제스처는 이미 이력 페이지네이션의
    // 것이다. 둘을 한 제스처에 겹치면 「더 읽기」와 「다시 읽기」가 같은 손짓이 된다.
    expect(screen.queryByTestId('timeline-empty')?.props.refreshControl).toBeUndefined();
  });
});

import type {Member} from '@momo/core/lib/api';
import {centrifugoOnlineChannelName} from '@momo/core/lib/realtimeEvents';
import type {Centrifuge} from 'centrifuge';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {cleanup, render, screen, waitFor} from '@testing-library/react-native';
import React from 'react';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {createChannelRail} from '../src/realtime/channelRail';
import AppShell from '../src/shell/AppShell';
import {__resetSessionStore, sessionPort} from '../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';
import {installAppClock, SHELL_WAIT_TEST_TIMEOUT_MS} from './fixtures/fakeClock';

// =============================================================================
// 작업공간 출석부에 세어지는 일 (ADR-0160 ② 가용성, #4692).
//
// 이 폰이 `online:ws<WS>` 에 붙어 있는 동안 서버(Centrifugo presence 를 읽는다)가 이 사람을 「접속 중」으로
// 센다. 구독에서 받는 것은 없으므로(핸들러가 없다) 이 레일의 계약은 **무엇을 붙이는가**뿐이다: 어느 채널,
// 어떤 옵션, 언제 붙고 언제 떠나는가. 그래서 두 층에서 잰다 - 레일 하나(구독 이름·옵션·refcount)와, 실제
// `AppShell` (앱이 뜨면 붙고, 내려가면 떠난다). 목은 `fetch` 와 소켓 둘뿐이다.
// =============================================================================

const WS = '22222222-2222-4222-8222-222222222222';
const OTHER_WS = '33333333-3333-4333-8333-333333333333';
const SELF_ID = '11111111-1111-4111-8111-111111111111';
const BASE = 'https://api.example.com';

const SELF: Member = {
  id: SELF_ID,
  workspaceId: WS,
  kind: 'human',
  displayName: '이도현',
  handle: 'dohyun',
};

interface FakeSubscription {
  channel: string;
  options: unknown;
  state: string;
}
interface FakeClient {
  subs: Map<string, FakeSubscription>;
}
const centrifugeMock = jest.requireMock('centrifuge') as {
  __clients: FakeClient[];
  __reset: () => void;
  Centrifuge: new (url: string, options: unknown) => Centrifuge;
};

const latestClient = (): FakeClient =>
  centrifugeMock.__clients[centrifugeMock.__clients.length - 1];

describe('레일: joinOnlineRollCall', () => {
  const fakeClient = () =>
    new centrifugeMock.Centrifuge(
      'wss://example.test/connection/websocket',
      {},
    ) as unknown as Centrifuge & FakeClient;

  it('같은 클라이언트에 `online:ws<대문자 WS>` 를 복구·위치 추적 없이 붙인다', () => {
    const client = fakeClient();
    const rail = createChannelRail(() => client);
    rail.joinOnlineRollCall(WS);

    const name = centrifugoOnlineChannelName(WS);
    expect(name).toBe(`online:ws${WS.toUpperCase()}`);
    expect([...client.subs.keys()]).toEqual([name]);
    // 되살릴 과거가 없다(`history_size: 0`).
    expect(client.subs.get(name)?.options).toEqual({
      recoverable: false,
      positioned: false,
    });
    expect(client.subs.get(name)?.state).toBe('subscribed');
  });

  it('떠나면 구독이 사라지고, 같은 작업공간을 두 번 붙여도 하나를 나눠 쓴다', () => {
    const client = fakeClient();
    const rail = createChannelRail(() => client);
    const leaveFirst = rail.joinOnlineRollCall(WS);
    const leaveSecond = rail.joinOnlineRollCall(WS);
    expect(client.subs.size).toBe(1);

    leaveFirst();
    leaveFirst(); // 이중 정리가 남의 몫을 놓지 않는다
    expect(client.subs.size).toBe(1);
    leaveSecond();
    expect(client.subs.size).toBe(0);
  });

  it('작업공간마다 따로 있고, 어느 것도 대화 레일이 아니다', () => {
    const client = fakeClient();
    const rail = createChannelRail(() => client);
    rail.joinOnlineRollCall(WS);
    rail.joinOnlineRollCall(OTHER_WS);
    const names = [...client.subs.keys()];
    expect(names).toEqual([
      `online:ws${WS.toUpperCase()}`,
      `online:ws${OTHER_WS.toUpperCase()}`,
    ]);
    for (const name of names) expect(name.split('.')).toHaveLength(1);
  });
});

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function installFetch(): jest.Mock {
  const mock = jest.fn(async (url: string) => {
    if (url.includes('/roster')) {
      return jsonResponse(200, {
        members: [
          {
            id: SELF_ID,
            workspaceId: WS,
            kind: 'human',
            status: 'active',
            displayName: '이도현',
            handle: 'dohyun',
            channelCount: 0,
            channelIds: [],
            capabilities: [],
            createdAtMs: 0,
            updatedAtMs: 0,
          },
        ],
      });
    }
    if (url.includes('/channels') && !url.includes('/messages')) {
      return jsonResponse(200, {
        channels: [
          {id: 'ch-general', workspaceId: WS, kind: 'public', name: 'general', muted: false},
        ],
      });
    }
    if (url.includes('/read-state')) return jsonResponse(200, {read_states: []});
    if (url.includes('/approvals')) return jsonResponse(200, {approvals: []});
    if (url.includes('/work-sessions')) return jsonResponse(200, {sessions: []});
    if (url.includes('/work-hosts')) return jsonResponse(200, {hosts: []});
    if (url.includes('/agent-runs') || url.includes('/runs')) {
      return jsonResponse(200, {runs: []});
    }
    if (url.includes('/messages')) return jsonResponse(200, {messages: []});
    return jsonResponse(200, {});
  });
  globalThis.fetch = mock as unknown as typeof fetch;
  return mock;
}

const mmkvStore = (
  jest.requireMock('react-native-mmkv') as {__store: Map<string, string>}
).__store;

let queryClient: QueryClient | null = null;

jest.setTimeout(SHELL_WAIT_TEST_TIMEOUT_MS);

beforeEach(() => {
  installAppClock();
  mmkvStore.clear();
  __resetSessionStore();
  __resetServerBaseCache();
  setServerBase(BASE);
  centrifugeMock.__reset();
  sessionPort.applyLogin({
    accessToken: 'access-token-1',
    refreshToken: 'refresh-token-1',
    realtimeWebSocketUrl: 'wss://api.example.com/connection/websocket',
    member: SELF,
  });
  installFetch();
});

afterEach(() => {
  cleanup();
  queryClient?.clear();
  queryClient = null;
  jest.useRealTimers();
});

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

describe('앱: 로그인한 동안 출석부에 세어진다', () => {
  it('셸이 뜨면 이 작업공간의 출석부에 붙고, 앱이 내려가면 떠난다', async () => {
    const view = renderShell();
    await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy());

    const name = centrifugoOnlineChannelName(WS);
    await waitFor(() => expect(latestClient()?.subs.has(name)).toBe(true));
    expect(latestClient().subs.get(name)?.options).toEqual({
      recoverable: false,
      positioned: false,
    });
    // 세어지는 것이 전부다: 이 구독 말고 새 레일은 생기지 않았다.
    expect(name.split('.')).toHaveLength(1);

    const client = latestClient();
    view.unmount();
    expect(client.subs.has(name)).toBe(false);
  });
});

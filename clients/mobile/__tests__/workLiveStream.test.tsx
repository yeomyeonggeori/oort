import type {Member, WorkSession} from '@momo/core/lib/api';
import {
  centrifugoChannelName,
  type WorkSessionACPFrame,
} from '@momo/core/lib/realtimeEvents';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
} from '@testing-library/react-native';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {
  RealtimeContext,
  type RealtimeContextValue,
} from '../src/realtime/RealtimeProvider';
import {createChannelRail} from '../src/realtime/channelRail';
import WorkSessionDetailScreen from '../src/screens/WorkSessionDetailScreen';
import {SessionProvider} from '../src/session/useSession';
import {
  __resetSessionStore,
  sessionPort,
} from '../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';
import {haptics} from '../src/lib/haptics';
import {
  __resetWorkStreamTimings,
  computeStreamTiming,
  workStreamTimings,
} from '../src/features/work/workStreamTiming';

jest.mock('../src/lib/haptics', () => ({
  haptics: {
    selection: jest.fn(),
    light: jest.fn(),
    medium: jest.fn(),
    success: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock('react-native/Libraries/ReactNative/RendererProxy', () => ({
  ...jest.requireActual('react-native/Libraries/ReactNative/RendererProxy'),
  findNodeHandle: jest.fn(() => 1292),
}));

const WS = '22222222-2222-4222-8222-222222222222';
const SELF_ID = '11111111-1111-4111-8111-111111111111';
const AGENT_ID = 'cccccccc-1111-4111-8111-cccccccccccc';
const BASE = 'https://api.example.com';
const NOW = 1_786_435_200_000;
const CH = 'ch-general';
const SID = 'SESSION-APP';

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

let sessionStatus: WorkSession['status'] = 'running';

function session(): WorkSession {
  return {
    id: SID,
    workspaceId: WS,
    channelId: CH,
    memberId: AGENT_ID,
    hostId: 'HOST-APP',
    rootMessageId: 'root-session-app',
    tool: 'codex',
    label: '릴레이 재시작 절차',
    status: sessionStatus,
    observation: 'open',
    observerGrantCount: 0,
    remoteAttachAvailable: false,
    remoteDisplayAvailable: false,
    startedAtMs: NOW,
    ...(sessionStatus === 'ended' ? {endedAtMs: NOW + 9_000} : {}),
  };
}

const HOSTS = [
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
];

function eventMessage(
  id: string,
  seq: number,
  type: string,
  event: Record<string, unknown>,
) {
  return {
    id,
    channelId: CH,
    seq,
    hlcTs: NOW + seq,
    hlcCount: 0,
    authorMemberId: AGENT_ID,
    type: 'system',
    body: 'DO_NOT_RENDER_MESSAGE_BODY',
    state: 'sent',
    createdAtMs: NOW + seq,
    props: {
      kind: 'work_session_event',
      schema: 'momo.work_session.acp_event.v1',
      event_type: type,
      event_id: id,
      event_ts: NOW + seq,
      event: {work_session_id: SID, event_id: id, ...event},
    },
  };
}

let durable = [
  eventMessage('EVENT-1', 1, 'agent.status', {terminal_event: 'created'}),
];

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

let repliesDelayMs = 0;

function installFetch(): jest.Mock {
  const mock = jest.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('/work-sessions')) {
      return jsonResponse(200, {workSessions: [session()]});
    }
    if (url.includes('/work-hosts')) {
      return jsonResponse(200, {workHosts: HOSTS});
    }
    if (url.includes('/replies')) {
      if (repliesDelayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, repliesDelayMs));
      }
      return jsonResponse(200, {messages: durable});
    }
    if (url.includes('/channels') && !url.includes('/messages')) {
      return jsonResponse(200, {
        channels: [
          {id: CH, workspaceId: WS, kind: 'public', name: 'general', muted: false},
        ],
      });
    }
    if (url.includes('/roster')) return jsonResponse(200, {members: []});
    throw new Error(`unrouted request: ${url}`);
  });
  globalThis.fetch = mock as unknown as typeof fetch;
  return mock;
}

const count = (mock: jest.Mock, needle: string) =>
  mock.mock.calls.filter(([url]) => String(url).includes(needle)).length;

type Handlers = Parameters<
  NonNullable<RealtimeContextValue['rail']>['subscribeWorkSession']
>[2];

interface FakeRail {
  value: (wanted?: boolean) => RealtimeContextValue;
  handlers: Map<string, Handlers>;
  unsubscribed: string[];
}

function fakeRail(): FakeRail {
  const handlers = new Map<string, Handlers>();
  const unsubscribed: string[] = [];
  const rail = {
    subscribeWorkSession: (_ws: string, channelId: string, h: Handlers) => {
      handlers.set(channelId, h);
      return () => {
        unsubscribed.push(channelId);
        handlers.delete(channelId);
      };
    },
  } as unknown as RealtimeContextValue['rail'];
  return {
    value: (wanted = true) => ({
      rail,
      status: 'connected',
      subscriptionsWanted: wanted,
    }),
    handlers,
    unsubscribed,
  };
}

function partial(
  id: string,
  seq: number,
  text: string,
  sid = SID,
): WorkSessionACPFrame {
  return {
    type: 'agent.partial',
    v: 1,
    ts: NOW + seq * 1_000,
    seq,
    payload: {
      event_id: id,
      work_session_id: sid,
      run_id: 'run-1',
      channel_id: CH,
      message_id: id,
      root_message_id: 'root-session-app',
      text_delta: text,
    },
  };
}

let queryClient: QueryClient | null = null;

function tree(active: boolean, realtime: RealtimeContextValue) {
  return (
    <QueryClientProvider client={queryClient as QueryClient}>
      <SessionProvider member={SELF}>
        <RealtimeContext.Provider value={realtime}>
          <WorkSessionDetailScreen
            active={active}
            sessionId={SID}
            onBack={() => {}}
            onOpenConversation={() => {}}
          />
        </RealtimeContext.Provider>
      </SessionProvider>
    </QueryClientProvider>
  );
}

function renderDetail(active: boolean, realtime: RealtimeContextValue) {
  queryClient = new QueryClient({
    defaultOptions: {
      queries: {retry: false, gcTime: 0},
      mutations: {retry: false, gcTime: 0},
    },
  });
  return render(tree(active, realtime));
}

const mmkvStore = (
  jest.requireMock('react-native-mmkv') as {__store: Map<string, string>}
).__store;

beforeEach(() => {
  mmkvStore.clear();
  __resetSessionStore();
  __resetServerBaseCache();
  __resetWorkStreamTimings();
  setServerBase(BASE);
  sessionPort.applyLogin(LOGIN_BODY);
  sessionStatus = 'running';
  repliesDelayMs = 0;
  durable = [
    eventMessage('EVENT-1', 1, 'agent.status', {terminal_event: 'created'}),
  ];
  jest.mocked(haptics.light).mockClear();
});

afterEach(() => {
  cleanup();
  queryClient?.clear();
  queryClient = null;
});

async function ready(rail: FakeRail) {
  await waitFor(() =>
    expect(screen.getByTestId('work-detail-event-list')).toHaveTextContent(
      /세션을 시작함/,
    ),
  );
  await waitFor(() => expect(rail.handlers.has(CH)).toBe(true));
}

describe('작업 상세 라이브 갱신 (N2 #3594)', () => {
  it('새로고침 없이 답 조각이 한 줄에 이어 붙는다', async () => {
    const fetchMock = installFetch();
    const rail = fakeRail();
    renderDetail(true, rail.value());
    await ready(rail);
    const repliesBefore = count(fetchMock, '/replies');

    act(() => rail.handlers.get(CH)?.onAcpEvent(partial('P-1', 2, '안녕')));
    await waitFor(() =>
      expect(screen.getByTestId('work-detail-event-list')).toHaveTextContent(
        /안녕/,
      ),
    );
    act(() => rail.handlers.get(CH)?.onAcpEvent(partial('P-2', 3, '하세요')));
    await waitFor(() =>
      expect(screen.getByTestId('work-detail-event-list')).toHaveTextContent(
        /안녕하세요/,
      ),
    );
    // 조각마다 줄이 새로 생기지 않는다: 시작 줄 + 답 한 줄.
    expect(screen.getAllByTestId('work-detail-event-row')).toHaveLength(2);
    // 읽기를 부르지 않았다 - 순수하게 프레임으로 자랐다.
    expect(count(fetchMock, '/replies')).toBe(repliesBefore);
    expect(screen.getByTestId('work-detail-writing')).toBeTruthy();
    // 같은 프레임이 두 번 와도 글자가 두 배가 되지 않는다.
    act(() => rail.handlers.get(CH)?.onAcpEvent(partial('P-2', 3, '하세요')));
    expect(screen.getByTestId('work-detail-event-list')).toHaveTextContent(
      /^.*안녕하세요(?!하세요).*$/,
    );
  });

  it('다른 세션의 조각은 이 화면에 섞이지 않는다', async () => {
    installFetch();
    const rail = fakeRail();
    renderDetail(true, rail.value());
    await ready(rail);
    act(() =>
      rail.handlers
        .get(CH)
        ?.onAcpEvent(partial('P-X', 2, 'OTHER_SESSION_TEXT', 'SESSION-OTHER')),
    );
    expect(screen.queryByText(/OTHER_SESSION_TEXT/)).toBeNull();
  });

  it('가려진 화면과 백그라운드(소켓 정책 off)에서는 구독하지 않는다', async () => {
    installFetch();
    const rail = fakeRail();
    const hidden = renderDetail(false, rail.value());
    await waitFor(() =>
      expect(screen.getByTestId('work-detail-event-list')).toHaveTextContent(
        /세션을 시작함/,
      ),
    );
    expect(rail.handlers.size).toBe(0);

    // 백그라운드 정책이 소켓을 접으면 보이는 화면이어도 듣지 않는다.
    hidden.rerender(tree(true, rail.value(false)));
    expect(rail.handlers.size).toBe(0);

    // 보이고 소켓이 있으면 듣는다.
    hidden.rerender(tree(true, rail.value(true)));
    await waitFor(() => expect(rail.handlers.has(CH)).toBe(true));

    // 다시 가려지면(대화가 위에 열림) 구독이 풀린다.
    hidden.rerender(tree(false, rail.value(true)));
    await waitFor(() => expect(rail.unsubscribed).toContain(CH));
    expect(rail.handlers.size).toBe(0);
  });

  it('끝난 세션은 구독하지 않는다', async () => {
    sessionStatus = 'ended';
    installFetch();
    const rail = fakeRail();
    renderDetail(true, rail.value());
    await waitFor(() =>
      expect(screen.getByTestId('work-detail-event-list')).toHaveTextContent(
        /세션을 시작함/,
      ),
    );
    expect(rail.handlers.size).toBe(0);
  });

  it('끝남 프레임이 오면 세션과 진행 내역을 다시 읽고, 읽은 뒤에도 글자는 그대로다', async () => {
    const fetchMock = installFetch();
    const rail = fakeRail();
    renderDetail(true, rail.value());
    await ready(rail);
    act(() => rail.handlers.get(CH)?.onAcpEvent(partial('P-1', 2, '끝까지 쓴 답')));
    await waitFor(() =>
      expect(screen.getByTestId('work-detail-event-list')).toHaveTextContent(
        /끝까지 쓴 답/,
      ),
    );
    const replies = count(fetchMock, '/replies');
    const sessions = count(fetchMock, '/work-sessions');

    // 서버가 조각을 영속한 뒤 세션이 끝났다.
    durable = [
      ...durable,
      eventMessage('P-1', 2, 'agent.partial', {text_delta: '끝까지 쓴 답'}),
    ];
    sessionStatus = 'ended';
    act(() =>
      rail.handlers.get(CH)?.onLifecycle({
        type: 'work.session.ended',
        v: 1,
        ts: NOW + 9_000,
        seq: 9,
        payload: {
          session_id: SID,
          channel_id: CH,
          root_message_id: 'root-session-app',
          member_id: AGENT_ID,
          host_id: 'HOST-APP',
          tool: 'codex',
          label: 'x',
          ended_at: NOW + 9_000,
        },
      }),
    );
    await waitFor(() => expect(count(fetchMock, '/replies')).toBeGreaterThan(replies));
    await waitFor(() =>
      expect(count(fetchMock, '/work-sessions')).toBeGreaterThan(sessions),
    );
    await waitFor(() => expect(screen.queryByTestId('work-detail-writing')).toBeNull());
    // 읽기가 같은 조각을 담았으므로 두 번 그려지지 않는다.
    expect(screen.getAllByTestId('work-detail-event-row')).toHaveLength(2);
    expect(screen.getByTestId('work-detail-event-list')).toHaveTextContent(
      /끝까지 쓴 답/,
    );
    expect(screen.getByTestId('work-detail-event-list')).not.toHaveTextContent(
      /끝까지 쓴 답끝까지 쓴 답/,
    );
  });

  it('재구독(되쏘기 후 resync) 읽기 동안 글자가 사라지지 않고 안내 블록이 끼지 않는다', async () => {
    installFetch();
    const rail = fakeRail();
    renderDetail(true, rail.value());
    await ready(rail);
    act(() => rail.handlers.get(CH)?.onAcpEvent(partial('P-1', 2, '유지되는 글자')));
    await waitFor(() =>
      expect(screen.getByTestId('work-detail-event-list')).toHaveTextContent(
        /유지되는 글자/,
      ),
    );
    repliesDelayMs = 80;
    act(() => rail.handlers.get(CH)?.onResync());
    // 읽기가 진행 중인 동안에도 글자는 그대로, 「새로 확인하는 중」 블록은 없다.
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(screen.getByTestId('work-detail-event-list')).toHaveTextContent(
      /유지되는 글자/,
    );
    expect(screen.queryByTestId('work-detail-events-refetching')).toBeNull();
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(screen.getByTestId('work-detail-event-list')).toHaveTextContent(
      /유지되는 글자/,
    );
  });

  it('새 조각이 와도 햅틱을 부르지 않는다', async () => {
    installFetch();
    const rail = fakeRail();
    renderDetail(true, rail.value());
    await ready(rail);
    act(() => rail.handlers.get(CH)?.onAcpEvent(partial('P-1', 2, '조각')));
    await waitFor(() =>
      expect(screen.getByTestId('work-detail-event-list')).toHaveTextContent(/조각/),
    );
    for (const fn of Object.values(haptics)) {
      expect(fn).not.toHaveBeenCalled();
    }
    for (const file of [
      '../src/features/work/useWorkSessionLive.ts',
      '../src/screens/WorkSessionDetailScreen.tsx',
    ]) {
      const source = fs.readFileSync(path.resolve(__dirname, file), 'utf8');
      expect(source.length).toBeGreaterThan(500);
      expect(source).not.toMatch(/from\s+['"][^'"]*haptics['"]/);
    }
  });

  it('첫 글자까지·총 시간을 기록한다', async () => {
    installFetch();
    const rail = fakeRail();
    renderDetail(true, rail.value());
    await ready(rail);
    act(() => rail.handlers.get(CH)?.onAcpEvent(partial('P-1', 2, '가')));
    act(() => rail.handlers.get(CH)?.onAcpEvent(partial('P-2', 5, '나')));
    await waitFor(() => {
      const timing = workStreamTimings().find(t => t.sessionId === SID);
      expect(timing).toMatchObject({
        firstTextMs: 2_000,
        totalMs: 5_000,
        deltas: 2,
        complete: false,
      });
    });
  });
});

describe('computeStreamTiming', () => {
  const base = {id: 'S', startedAtMs: 1_000, status: 'ended' as const};
  const ev = (type: 'agent.partial' | 'agent.status', atMs: number) => ({
    eventId: `e${atMs}`,
    type,
    sessionId: 'S',
    atMs,
    payload: {},
  });
  it('시작 → 첫 조각, 시작 → 종료 시각', () => {
    expect(
      computeStreamTiming({...base, endedAtMs: 9_000}, [
        ev('agent.status', 1_500),
        ev('agent.partial', 3_000),
        ev('agent.partial', 4_000),
      ]),
    ).toEqual({
      sessionId: 'S',
      firstTextMs: 2_000,
      totalMs: 8_000,
      complete: true,
      deltas: 2,
    });
  });
  it('조각이 없으면 첫 글자는 null, 시계가 어긋나도 음수는 기록하지 않는다', () => {
    expect(
      computeStreamTiming({...base, status: 'running'}, [ev('agent.status', 500)]),
    ).toMatchObject({firstTextMs: null, totalMs: 0, complete: false});
  });
});

describe('channelRail.subscribeWorkSession', () => {
  function fakeClient() {
    const subs = new Map<
      string,
      {
        options: unknown;
        state: string;
        listeners: Map<string, Set<(c: unknown) => void>>;
      }
    >();
    const client = {
      subs,
      getSubscription: (name: string) => {
        const s = subs.get(name);
        return s ? (s as never) : null;
      },
      newSubscription: (name: string, options: unknown) => {
        const listeners = new Map<string, Set<(c: unknown) => void>>();
        const sub = {
          options,
          state: 'unsubscribed',
          listeners,
          on(event: string, fn: (c: unknown) => void) {
            listeners.set(event, (listeners.get(event) ?? new Set()).add(fn));
          },
          off(event: string, fn: (c: unknown) => void) {
            listeners.get(event)?.delete(fn);
          },
          subscribe() {},
          unsubscribe() {},
          emit(event: string, ctx: unknown) {
            for (const fn of listeners.get(event) ?? []) fn(ctx);
          },
        };
        subs.set(name, sub);
        return sub as never;
      },
      removeSubscription: (sub: unknown) => {
        for (const [name, s] of subs) if (s === sub) subs.delete(name);
      },
    };
    return client;
  }

  it('메시지 레일과 같은 구독·옵션을 나눠 쓰고, ACP 프레임을 분류해 넘기며, 재구독은 resync다', () => {
    const client = fakeClient();
    const rail = createChannelRail(() => client as never);
    const acp: unknown[] = [];
    let resync = 0;
    const off = rail.subscribeWorkSession(WS, CH, {
      onAcpEvent: f => acp.push(f),
      onLifecycle: () => {},
      onToolTransition: () => {},
      onObserver: () => {},
      onResync: () => (resync += 1),
    });
    const name = centrifugoChannelName(WS, CH);
    const sub = client.subs.get(name) as unknown as {
      options: unknown;
      emit: (e: string, c: unknown) => void;
    };
    expect(sub.options).toEqual({recoverable: true, positioned: true});
    sub.emit('publication', {data: {type: 'message.new', payload: {}}});
    expect(acp).toHaveLength(0);
    sub.emit('publication', {data: partial('P-1', 2, 'x')});
    expect(acp).toHaveLength(1);
    sub.emit('subscribed', {wasRecovering: false, recovered: false});
    expect(resync).toBe(1);
    off();
    expect(client.subs.size).toBe(0);
  });
});

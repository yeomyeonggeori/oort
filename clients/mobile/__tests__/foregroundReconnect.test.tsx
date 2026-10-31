import { act, cleanup, renderHook } from '@testing-library/react-native';
import { AppState, type AppStateStatus } from 'react-native';
import '../src/boot/polyfills';
import '../src/boot/coreHost';
import {
  createRealtimeTransport,
  type RealtimeTransport,
} from '../src/realtime/centrifugeTransport';
import { createChannelRail } from '../src/realtime/channelRail';
import { useTimeline } from '../src/features/conversation/useTimeline';
import { sessionPort, __resetSessionStore } from '../src/storage/secureSession';
import {
  setServerBase,
  __resetServerBaseCache,
} from '../src/storage/serverBase';

// Real centrifuge-js, fake wire: inspect the FIRST connect command, rather than
// trusting a fake connect() that never asks for a token (#4783).
jest.mock('centrifuge', () => jest.requireActual('centrifuge'));
const WS = '22222222-2222-4222-8222-222222222222';
const CH = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const SELF = '11111111-1111-4111-8111-111111111111';
const AGENT = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
const originalSocket = globalThis.WebSocket;
const appStateDescriptor = Object.getOwnPropertyDescriptor(
  AppState,
  'currentState',
);
let transport: RealtimeTransport | undefined;
let clock = 1_800_000_000_000;
let handlers: ((state: AppStateStatus) => void)[] = [];
let attempts: { token: string; at: number }[] = [];
let calls: string[] = [];
let latest = 1;
let realtimeTokens = 0;
let visibility: AppStateStatus = 'active';
const jwt = (expiresAt: number) =>
  `e30.${Buffer.from(JSON.stringify({ exp: expiresAt / 1000 })).toString(
    'base64url',
  )}.signature`;
const message = (seq: number) => ({
  id: `message-${seq}`,
  channelId: CH,
  seq,
  hlcTs: seq,
  hlcCount: 0,
  authorMemberId: AGENT,
  type: 'text',
  body: `agent answer ${seq}`,
  state: 'sent',
  createdAtMs: clock,
});
const reply = (body: unknown) =>
  ({
    status: 200,
    ok: true,
    text: async () => JSON.stringify(body),
  } as Response);

class Socket {
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror = null;
  closed = false;
  constructor() {
    setTimeout(() => this.onopen?.(), 0);
  }
  close() {
    this.closed = true;
    setTimeout(() => this.onclose?.({ code: 1000, reason: '' }), 0);
  }
  send(data: string) {
    for (const line of data.split('\n')) {
      const command = JSON.parse(line);
      if (!command.id) continue;
      let result: unknown = {};
      const kind = command.connect
        ? 'connect'
        : command.subscribe
        ? 'subscribe'
        : 'other';
      if (kind === 'connect') {
        attempts.push({ token: command.connect.token, at: Date.now() });
        calls.push('socket');
        result = { client: 'fake', version: '6', ping: 25, pong: true };
      } else if (kind === 'subscribe') {
        result = {
          recoverable: true,
          positioned: true,
          offset: latest,
          epoch: 'epoch',
          recovered: false,
        };
      }
      setTimeout(() => {
        if (!this.closed)
          this.onmessage?.({
            data: JSON.stringify({ id: command.id, [kind]: result }),
          });
      }, 0);
    }
  }
}

function emit(state: AppStateStatus) {
  visibility = state;
  for (const handler of handlers) handler(state);
}
async function flush() {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(50);
  });
}
function start(
  options: Partial<Parameters<typeof createRealtimeTransport>[0]> = {},
) {
  transport = createRealtimeTransport({
    url: 'wss://api.example.invalid/connection/websocket',
    now: () => clock,
    ...options,
  });
  transport.start();
  return transport;
}

beforeEach(() => {
  jest.useFakeTimers();
  clock = 1_800_000_000_000;
  handlers = [];
  attempts = [];
  calls = [];
  latest = 1;
  realtimeTokens = 0;
  visibility = 'active';
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation((_type, handler) => {
      handlers.push(handler);
      return {
        remove: () => {
          handlers = handlers.filter(h => h !== handler);
        },
      };
    });
  Object.defineProperty(AppState, 'currentState', {
    configurable: true,
    get: () => visibility,
  });
  (
    jest.requireMock('react-native-mmkv') as { __store: Map<string, string> }
  ).__store.clear();
  __resetSessionStore();
  __resetServerBaseCache();
  setServerBase('https://api.example.invalid');
  sessionPort.applyLogin({
    accessToken: jwt(clock + 900_000),
    refreshToken: 'refresh-fixture',
    realtimeWebSocketUrl: 'wss://api.example.invalid/connection/websocket',
    member: {
      id: SELF,
      workspaceId: WS,
      kind: 'human',
      displayName: 'Fixture',
      handle: 'fixture',
    },
  });
  globalThis.fetch = jest.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url);
    if (path.pathname.endsWith('/refresh')) {
      calls.push('refresh');
      return reply({
        accessToken: jwt(clock + 900_000),
        refreshToken: 'rotated-fixture',
      });
    }
    if (path.pathname.endsWith('/realtime-token')) {
      calls.push('realtime');
      expect(new Headers(init?.headers).get('Authorization')).toBe(
        `Bearer ${sessionPort.getAccessToken()}`,
      );
      return reply({ token: `realtime-${++realtimeTokens}` });
    }
    if (path.pathname.endsWith('/messages')) {
      const after = path.searchParams.get('after');
      return reply({
        messages:
          after === null
            ? [message(1)]
            : latest > Number(after)
            ? [message(latest)]
            : [],
      });
    }
    if (path.pathname.endsWith('/pins')) return reply({ pins: [] });
    if (path.pathname.endsWith('/reactions')) return reply({});
    throw new Error('unexpected fixture route');
  }) as unknown as typeof fetch;
});
afterEach(() => {
  cleanup();
  transport?.dispose();
  transport = undefined;
  globalThis.WebSocket = originalSocket;
  if (appStateDescriptor)
    Object.defineProperty(AppState, 'currentState', appStateDescriptor);
  jest.restoreAllMocks();
  jest.useRealTimers();
});

it.each([840_000, 960_000])(
  'return at +%d ms: the FIRST connect uses a new token after access rotation',
  async elapsed => {
    const current = start();
    await flush();
    expect(attempts.map(a => a.token)).toEqual(['realtime-1']);
    emit('background');
    clock += elapsed; // before expiry (one minute left), or after expiry
    calls = [];
    const resumedAt = Date.now();
    if (elapsed === 840_000) emit('inactive'); // notification opening passes through inactive
    emit('active');
    await flush();
    expect(calls).toEqual(['refresh', 'realtime', 'socket']);
    expect(attempts.map(a => a.token)).toEqual(['realtime-1', 'realtime-2']);
    expect(attempts[1].at - resumedAt).toBeLessThan(500);
    expect(current.client().state).toBe('connected');
  },
);

it('inactive→active heals an agent DM with a half-open socket before any ping timeout', async () => {
  const statuses: string[] = [];
  const current = start({ onStatus: status => statuses.push(status) });
  const rail = createChannelRail(current.client);
  const { result } = renderHook(() => useTimeline(rail, WS, CH, SELF));
  await flush();
  expect(result.current.state.messages.map(m => m.seq)).toEqual([1]);
  act(() => emit('inactive')); // lock without a background event
  latest = 2; // reply committed while the old socket cannot deliver
  clock += 1_000;
  expect(current.client().state).toBe('connected'); // misleading cached state
  act(() => {
    emit('active');
    emit('active');
  }); // duplicate active is not another return
  await flush();
  expect(attempts).toHaveLength(2);
  expect(calls).not.toContain('refresh');
  expect(statuses.slice(-2)).toEqual(['connecting', 'connected']);
  expect(result.current.resume.resubscribeCount).toBe(1);
  expect(result.current.state.messages.map(m => m.body)).toEqual([
    'agent answer 1',
    'agent answer 2',
  ]);
});

it('a token response held across suspension is replaced before the first socket opens', async () => {
  let release!: (token: string) => void;
  const getToken = jest
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<string>(resolve => {
          release = resolve;
        }),
    )
    .mockResolvedValue('fresh-after-lock');
  start({ getToken });
  await flush();
  emit('inactive');
  clock += 300_000;
  emit('active');
  release('expired-while-suspended');
  await flush();
  expect(getToken).toHaveBeenCalledTimes(2);
  expect(attempts.map(a => a.token)).toEqual(['fresh-after-lock']);
});

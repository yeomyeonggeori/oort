import NetInfo from '@react-native-community/netinfo';
import type {RealtimeStatus} from '@momo/core/lib/realtimeEvents';
import {isOnlineFromNetInfo} from '../src/query/queryClient';
import {
  BACKGROUND_GRACE_MS,
  socketWanted,
  type RealtimePolicyState,
} from '../src/realtime/backgroundPolicy';
import {
  createRealtimeTransport,
  setReconnectCeiling,
  type RealtimeTransport,
} from '../src/realtime/centrifugeTransport';
import {
  formatRealtimeDiagnostics,
  realtimeDiagnostics,
  recordRealtimeDiagnostic,
  resetRealtimeDiagnostics,
} from '../src/realtime/diagnostics';

// =============================================================================
// #4895 — 앱을 앞에 둔 채로 「연결이 끊겼습니다」가 30초 넘게 남고, 화면을 잠갔다 켜야
// 나았다. 가짜 centrifuge(`jest.setup.js`)는 `connect()`가 곧바로 connected라 재시도
// 간격이 없다. 그래서 여기는 **진짜 centrifuge-js 5.7 + 가짜 WebSocket**이다 —
// 재시도 간격·끝난 상태(`disconnected`)가 라이브러리 자신의 것이어야 재현이 정직하다.
//
// 가짜 시계 위에서 `Math.random`을 1에 가깝게 못 박는다. centrifuge-js의 재시도 간격은
// 전체 지터(`backoff()`)라 매번 달라지는데, 못 박으면 **가능한 가장 긴 기다림**이
// 결정적으로 나온다: 1.0 → 1.5 → 2.5 → 4.5 → 8.5 → 16.5 → 20초(상한).
//
//   (a) 같은 연결 종류 안의 오프라인 → 온라인   NetInfo type 은 그대로(cellular),
//       isInternetReachable 만 false → true. 정책은 종류가 바뀔 때만 재연결했다.
//   (b) 앞에 둔 채로 몇 번 실패한 뒤 길이 살아남  다음 시도까지 최대 20초를 기다린다.
//   (c) 끝난 상태(`disconnected`)               라이브러리는 다시 시도하지 않는다.
// =============================================================================

jest.mock('centrifuge', () => jest.requireActual('centrifuge'));

// A hand-driven AppState, delivering transitions synchronously as RN does.
const appState: {
  currentState: string;
  handlers: ((status: string) => void)[];
} = {currentState: 'active', handlers: []};

jest.mock('react-native', () => ({
  AppState: {
    get currentState() {
      return appState.currentState;
    },
    addEventListener: (_event: string, fn: (status: string) => void) => {
      appState.handlers.push(fn);
      return {
        remove: () => {
          appState.handlers = appState.handlers.filter(h => h !== fn);
        },
      };
    },
  },
}));

interface Close {
  code: number;
  reason: string;
}

/** What the far end and the route under it are doing right now. */
const wire = {
  route: 'up' as 'up' | 'down',
  /** Every handshake is answered by closing the socket like this (null: accepted). */
  refuseWith: null as Close | null,
  sockets: [] as FakeSocket[],
  connects: [] as {token: string; at: number}[],
};

class FakeSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: {data: string}) => void) | null = null;
  onclose: ((event: Close) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  closed = false;
  readonly createdAt = Date.now();

  constructor(readonly url: string) {
    wire.sockets.push(this);
    setTimeout(() => {
      if (this.closed) return;
      if (wire.route === 'down') {
        this.end({code: 1006, reason: ''});
        return;
      }
      this.onopen?.();
    }, 0);
  }

  send(data: string): void {
    if (this.closed) return;
    for (const line of data.split('\n')) {
      if (line.trim() === '') continue;
      const command = JSON.parse(line) as {
        id?: number;
        connect?: {token?: string};
      };
      if (command.id === undefined || command.connect === undefined) continue;
      wire.connects.push({token: command.connect.token ?? '', at: Date.now()});
      const refusal = wire.refuseWith;
      if (refusal !== null) {
        setTimeout(() => this.end(refusal), 0);
        return;
      }
      const id = command.id;
      setTimeout(() => {
        if (this.closed) return;
        this.onmessage?.({
          data: JSON.stringify({
            id,
            connect: {client: 'fake', version: '6', ping: 0, pong: false},
          }),
        });
      }, 0);
    }
  }

  /** Our side closes it (centrifuge-js ignores the echo of a stale transport). */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    setTimeout(() => this.onclose?.({code: 1000, reason: ''}), 0);
  }

  /** The far end, or the route under it, goes away. */
  end(why: Close): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.(why);
  }
}

const netInfo = NetInfo as unknown as {__emit: (state: unknown) => void};
const originalSocket = globalThis.WebSocket;

const INVALID_TOKEN: Close = {
  code: 3500,
  reason: JSON.stringify({reason: 'invalid token', reconnect: false}),
};
const FORCE_DISCONNECT: Close = {
  code: 3503,
  reason: JSON.stringify({reason: 'force disconnect', reconnect: false}),
};

let transport: RealtimeTransport | null = null;
let statuses: RealtimeStatus[] = [];
let tokensMinted = 0;

function emitAppState(status: string): void {
  appState.currentState = status;
  for (const fn of [...appState.handlers]) fn(status);
}

function start(
  options: Partial<Parameters<typeof createRealtimeTransport>[0]> = {},
): RealtimeTransport {
  transport = createRealtimeTransport({
    url: 'wss://example.invalid/connection/websocket',
    onStatus: status => statuses.push(status),
    getToken: async () => `token-${++tokensMinted}`,
    ...options,
  });
  transport.start();
  return transport;
}

/** 50 ms steps keep the library's promise chains interleaved with its timers. */
async function advance(ms: number): Promise<void> {
  for (let left = ms; left > 0; left -= 50) {
    await jest.advanceTimersByTimeAsync(Math.min(50, left));
  }
}

/** Fake milliseconds until `done()`, or `limitMs` if it never becomes true. */
async function until(done: () => boolean, limitMs: number): Promise<number> {
  const from = Date.now();
  while (!done() && Date.now() - from < limitMs) {
    await jest.advanceTimersByTimeAsync(50);
  }
  return Date.now() - from;
}

const last = <T>(list: readonly T[]): T | undefined => list[list.length - 1];
const lastSocket = (): FakeSocket => wire.sockets[wire.sockets.length - 1];

/** A connected socket on a healthy route. */
async function connected(
  options: Partial<Parameters<typeof createRealtimeTransport>[0]> = {},
): Promise<RealtimeTransport> {
  const current = start(options);
  await advance(100);
  expect(last(statuses)).toBe('connected');
  return current;
}

/** The route dies under a connected socket and stays dead. */
function routeDies(): void {
  wire.route = 'down';
  lastSocket().end({code: 1006, reason: ''});
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.spyOn(Math, 'random').mockReturnValue(0.999999);
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  appState.currentState = 'active';
  appState.handlers = [];
  wire.route = 'up';
  wire.refuseWith = null;
  wire.sockets = [];
  wire.connects = [];
  statuses = [];
  tokensMinted = 0;
  resetRealtimeDiagnostics();
});

afterEach(() => {
  transport?.dispose();
  transport = null;
  globalThis.WebSocket = originalSocket;
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('(a) the same kind of connection, offline then online', () => {
  it('cuts the retry wait the moment reachability comes back, at the longest backoff', async () => {
    await connected();
    netInfo.__emit({type: 'cellular', isConnected: true, isInternetReachable: true});
    routeDies();
    // The radio is attached, there is just no data: the kind stays `cellular`.
    netInfo.__emit({type: 'cellular', isConnected: true, isInternetReachable: false});
    await advance(40_000);
    expect(last(statuses)).toBe('disconnected'); // the banner has been up for 30 s

    // Just after a failed attempt is the longest possible wait for the next one.
    const seen = wire.sockets.length;
    await until(() => wire.sockets.length > seen, 25_000);
    await advance(150);
    wire.route = 'up';
    netInfo.__emit({type: 'cellular', isConnected: true, isInternetReachable: true});
    const waited = await until(() => last(statuses) === 'connected', 30_000);
    // Not the backoff (up to 20 s, or 5 s with only a lower ceiling): at once.
    expect(waited).toBeLessThanOrEqual(1_500);
  });

  it('a burst of recoveries is one reconnect: the interval limit keeps a flapping radio from restarting the handshake', async () => {
    await connected();
    netInfo.__emit({type: 'wifi', isConnected: true, isInternetReachable: true});
    routeDies();
    netInfo.__emit({type: 'wifi', isConnected: true, isInternetReachable: false});
    await advance(30_000);
    const reconnects = () =>
      realtimeDiagnostics().filter(e => e.kind === 'policy' && e.detail === 'online-reconnect').length;
    // Recovery, a blip, recovery — all inside one second, and the route is still
    // dead, so the socket is down every time and the second recovery WOULD qualify.
    netInfo.__emit({type: 'wifi', isConnected: true, isInternetReachable: true});
    await advance(200);
    netInfo.__emit({type: 'wifi', isConnected: true, isInternetReachable: false});
    await advance(200);
    netInfo.__emit({type: 'wifi', isConnected: true, isInternetReachable: true});
    await advance(200);
    expect(reconnects()).toBe(1);
    // Once the interval is over, the next recovery is a new one.
    await advance(2_000);
    netInfo.__emit({type: 'wifi', isConnected: true, isInternetReachable: false});
    netInfo.__emit({type: 'wifi', isConnected: true, isInternetReachable: true});
    expect(reconnects()).toBe(2);
  });

  it('cuts a wait, not a healthy socket: a reachability probe that flaps does not reconnect a connected socket', async () => {
    await connected();
    netInfo.__emit({type: 'cellular', isConnected: true, isInternetReachable: true});
    const sockets = wire.sockets.length;
    netInfo.__emit({type: 'cellular', isConnected: true, isInternetReachable: false});
    await advance(8_000);
    netInfo.__emit({type: 'cellular', isConnected: true, isInternetReachable: true});
    await advance(2_000);
    expect(wire.sockets.length).toBe(sockets);
    // And nothing flashed 「연결 중…」 for it.
    expect(statuses).toEqual(['connected']);
    expect(formatRealtimeDiagnostics()).not.toMatch(/online-reconnect/);
  });
});

describe('(b) in front, several failures, then the route comes back', () => {
  it('does not wait out a 20 second backoff', async () => {
    await connected();
    routeDies();
    // 1.0 + 1.5 + 2.5 + 4.5 + 8.5 + 16.5 s of failed attempts; the next one would
    // be 20 s after the sixth.
    await advance(36_000);
    expect(last(statuses)).toBe('disconnected');
    wire.route = 'up';
    const waited = await until(() => last(statuses) === 'connected', 60_000);
    // 「몇 초 안에」(#4895): the old 20 s ceiling made this 18.5 s.
    expect(waited).toBeLessThanOrEqual(6_000);
  });

  it('keeps the old policy while offline: a known-offline radio is not hammered', async () => {
    await connected();
    netInfo.__emit({type: 'wifi', isConnected: true, isInternetReachable: true});
    routeDies();
    netInfo.__emit({type: 'none', isConnected: false, isInternetReachable: false});
    await advance(60_000); // the ceiling is reached well inside this
    const settled = wire.sockets.length;
    await advance(60_000);
    // Offline: at most one attempt per 20 s (the current policy), not one per 5 s.
    expect(wire.sockets.length - settled).toBeLessThanOrEqual(3);
  });
});

describe('(c) ended (`disconnected`) while the person is looking', () => {
  it('an invalid-token ending fetches a NEW token and reconnects by itself', async () => {
    await connected();
    lastSocket().end(INVALID_TOKEN);
    await advance(8_000);
    expect(wire.connects.map(c => c.token)).toEqual(['token-1', 'token-2']);
    expect(last(statuses)).toBe('connected');
  });

  it('a server that says "do not reconnect" is not retried, and the outage is shown at once', async () => {
    const current = await connected();
    lastSocket().end(FORCE_DISCONNECT);
    await advance(100);
    // Nothing is trying, so there is nothing to wait ten seconds for.
    expect(last(statuses)).toBe('disconnected');
    const sockets = wire.sockets.length;
    await advance(10 * 60_000);
    expect(wire.sockets.length).toBe(sockets);

    // 「지금 다시 연결」 — the same path as a foreground return.
    void current.reconnect().catch(() => undefined);
    await advance(300);
    expect(wire.sockets.length).toBe(sockets + 1);
    expect(last(statuses)).toBe('connected');
  });

  it('a token ending is retried a bounded number of times, then held; an explicit return starts over', async () => {
    wire.refuseWith = INVALID_TOKEN;
    start();
    await advance(60_000);
    expect(wire.sockets.length).toBe(3); // the first try and two retries
    expect(last(statuses)).toBe('disconnected');

    emitAppState('background');
    await advance(BACKGROUND_GRACE_MS + 1_000);
    emitAppState('active');
    await advance(60_000);
    expect(wire.sockets.length).toBe(6);
  });

  it('what we closed ourselves is left alone: foreground return, the background grace and stop()', async () => {
    const current = await connected();
    emitAppState('background');
    await advance(BACKGROUND_GRACE_MS - 1_000);
    emitAppState('active'); // a return inside the grace reopens on the same client
    await advance(300);
    expect(statuses).not.toContain('disconnected');

    emitAppState('background');
    await advance(BACKGROUND_GRACE_MS);
    // The grace dropped the socket on purpose: shown as a recovery, not an outage.
    expect(last(statuses)).toBe('connecting');
    const parked = wire.sockets.length;
    await advance(60_000);
    expect(wire.sockets.length).toBe(parked);

    emitAppState('active');
    await advance(300);
    expect(last(statuses)).toBe('connected');
    const running = wire.sockets.length;
    current.stop();
    await advance(60_000);
    expect(wire.sockets.length).toBe(running);
  });

  it('an ending that arrives in the background waits for the return', async () => {
    await connected();
    emitAppState('background');
    await advance(1_000);
    lastSocket().end(INVALID_TOKEN);
    await advance(10_000);
    expect(wire.sockets.length).toBe(1);
    emitAppState('active');
    await advance(300);
    expect(wire.sockets.length).toBe(2);
    expect(last(statuses)).toBe('connected');
  });
});

describe('the connection record (#4805) names the new paths', () => {
  it('records the reachability flip, the online reconnect, the ending and its answer — codes only', async () => {
    await connected();
    netInfo.__emit({type: 'cellular', isConnected: true, isInternetReachable: true});
    routeDies();
    netInfo.__emit({type: 'cellular', isConnected: true, isInternetReachable: false});
    await advance(5_000);
    wire.route = 'up';
    netInfo.__emit({type: 'cellular', isConnected: true, isInternetReachable: true});
    await advance(300);
    lastSocket().end(INVALID_TOKEN);
    await advance(2_000);
    lastSocket().end(FORCE_DISCONNECT);
    await advance(100);
    void transport?.reconnect().catch(() => undefined);
    await advance(300);

    const out = formatRealtimeDiagnostics();
    expect(out).toMatch(/network cellular->cellular unreachable/);
    expect(out).toMatch(/network cellular->cellular$/m);
    expect(out).toMatch(/policy online-reconnect/);
    expect(out).toMatch(/disconnected code=3500/);
    expect(out).toMatch(/policy code=3500 terminal-retry/);
    expect(out).toMatch(/disconnected code=3503/);
    expect(out).toMatch(/policy code=3503 terminal-hold/);
    expect(out).toMatch(/policy manual-reconnect/);
    expect(out).not.toMatch(/example\.invalid|token-\d|invalid token|force disconnect/);
  });
});

describe('the retry ceiling is the real library’s, and it follows the policy', () => {
  const ceiling = (current: RealtimeTransport): number =>
    (current.client() as unknown as {_config: {maxReconnectDelay: number}})
      ._config.maxReconnectDelay;

  it('is 5 s in front, 20 s while offline or in the background, and 5 s again after', async () => {
    const current = await connected();
    expect(ceiling(current)).toBe(5_000);
    netInfo.__emit({type: 'wifi', isConnected: false, isInternetReachable: false});
    expect(ceiling(current)).toBe(20_000);
    netInfo.__emit({type: 'wifi', isConnected: true, isInternetReachable: true});
    await advance(300);
    expect(ceiling(current)).toBe(5_000);
    emitAppState('background');
    expect(ceiling(current)).toBe(20_000);
    emitAppState('active');
    await advance(300);
    expect(ceiling(current)).toBe(5_000);
  });

  it('a ceiling lowered AFTER the client was built is obeyed by the next delay', async () => {
    // Launched in the background: the client is built with the old 20 s ceiling.
    appState.currentState = 'background';
    const current = start();
    await advance(100);
    expect(last(statuses)).toBe('connected');
    expect(ceiling(current)).toBe(20_000);
    emitAppState('active');
    await advance(300);
    expect(ceiling(current)).toBe(5_000);

    routeDies();
    const from = wire.sockets.length;
    await advance(90_000);
    const times = wire.sockets.slice(from).map(socket => socket.createdAt);
    const gaps = times.slice(1).map((at, i) => at - times[i]);
    // 1.0, 1.5, 2.5, 4.5, then 5 s steps: never the 8.5 / 16.5 / 20 s of the old ceiling.
    expect(gaps.length).toBeGreaterThan(10);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(5_100);
  });

  it('setReconnectCeiling writes the live library config and leaves a client without it alone', () => {
    const {Centrifuge} = jest.requireActual('centrifuge') as typeof import('centrifuge');
    const real = new Centrifuge('wss://example.invalid/connection/websocket', {
      maxReconnectDelay: 20_000,
    });
    expect(setReconnectCeiling(real, 5_000)).toBe(true);
    expect(
      (real as unknown as {_config: {maxReconnectDelay: number}})._config.maxReconnectDelay,
    ).toBe(5_000);
    expect(setReconnectCeiling({} as never, 5_000)).toBe(false);
  });
});

describe('what NetInfo says is read by the rest of the app’s rule', () => {
  it.each([
    [true, true],
    [true, false],
    [true, null],
    [true, undefined],
    [false, false],
    [false, null],
    [null, true],
    [null, null],
  ])('isConnected=%s isInternetReachable=%s', async (isConnected, isInternetReachable) => {
    const current = await connected();
    const reading = {type: 'wifi', isConnected, isInternetReachable};
    netInfo.__emit(reading);
    expect(current.policy().online).toBe(
      isOnlineFromNetInfo({
        isConnected: isConnected ?? null,
        isInternetReachable: isInternetReachable ?? null,
      }),
    );
  });
});

describe('the transport after it is gone', () => {
  it('dispose() publishes no policy afterwards — the provider has already said "no subscriptions"', async () => {
    const wanted: boolean[] = [];
    const current = await connected({
      onPolicy: (policy: RealtimePolicyState) => wanted.push(socketWanted(policy)),
    });
    const before = wanted.length;
    transport = null;
    current.dispose(); // its own disconnect() reports `disconnected`
    expect(wanted.length).toBe(before);
    await advance(10_000);
    expect(wanted.length).toBe(before);
  });

  it('a pending token retry does not reopen a stopped or a disposed transport', async () => {
    const stopped = await connected();
    lastSocket().end(INVALID_TOKEN);
    await advance(100);
    stopped.stop();
    const sockets = wire.sockets.length;
    await advance(10_000);
    expect(wire.sockets.length).toBe(sockets);

    transport = null;
    stopped.dispose();
    const disposed = await connected();
    lastSocket().end(INVALID_TOKEN);
    await advance(100);
    transport = null;
    disposed.dispose();
    const after = wire.sockets.length;
    await advance(10_000);
    expect(wire.sockets.length).toBe(after);
  });
});

describe('the connection record keeps free text out', () => {
  it('names the new details and drops everything else', () => {
    recordRealtimeDiagnostic({at: 1, kind: 'policy', detail: 'terminal-hold', code: 3503});
    recordRealtimeDiagnostic({at: 2, kind: 'policy', detail: 'terminal-retry token=secret-fixture'});
    recordRealtimeDiagnostic({at: 3, kind: 'network', detail: 'cellular->cellular unreachable'});
    recordRealtimeDiagnostic({at: 4, kind: 'network', detail: 'cellular->cellular unreachable at home'});
    recordRealtimeDiagnostic({at: 5, kind: 'network', detail: 'wifi->wifi offline'});
    expect(formatRealtimeDiagnostics().split('\n')).toEqual([
      '1970-01-01T00:00:00.001Z policy code=3503 terminal-hold',
      '1970-01-01T00:00:00.002Z policy',
      '1970-01-01T00:00:00.003Z network cellular->cellular unreachable',
      '1970-01-01T00:00:00.004Z network',
      '1970-01-01T00:00:00.005Z network wifi->wifi offline',
    ]);
  });
});

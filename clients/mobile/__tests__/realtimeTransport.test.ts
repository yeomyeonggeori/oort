import type {RealtimeStatus} from '@momo/core/lib/realtimeEvents';
import {readFileSync} from 'fs';
import {resolve} from 'path';
import NetInfo from '@react-native-community/netinfo';
import {BACKGROUND_GRACE_MS} from '../src/realtime/backgroundPolicy';
import {
  createRealtimeTransport,
  REALTIME_TOKEN_STALE_MS,
  type RealtimeTransport,
} from '../src/realtime/centrifugeTransport';
import {DISPLAY_GRACE_MS} from '../src/realtime/connectionDisplay';
import {
  formatRealtimeDiagnostics,
  realtimeDiagnostics,
  resetRealtimeDiagnostics,
} from '../src/realtime/diagnostics';

// =============================================================================
// #2751 — the transport, driven end to end against the fake Centrifuge client
// (`jest.setup.js`) with fake timers and a hand-driven AppState.
// =============================================================================

// Only `AppState` is read from react-native by the transport; a hand-driven one
// delivers transitions synchronously, as RN does.
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

type FakeClient = {
  state: string;
  _reconnecting?: boolean;
  connectCount: number;
  disconnectCount: number;
  setTokenCalls?: string[];
  options: {getToken: () => Promise<string>};
  __emit: (event: string, ctx: unknown) => void;
};

const centrifugeMock = jest.requireMock('centrifuge') as {
  __clients: FakeClient[];
  __reset: () => void;
};
const netInfo = NetInfo as unknown as {__emit: (state: unknown) => void};

function emitAppState(status: string): void {
  appState.currentState = status;
  for (const fn of [...appState.handlers]) fn(status);
}

let clock = 0;
let transport: RealtimeTransport | null = null;
let statuses: RealtimeStatus[] = [];

function start(): FakeClient {
  transport = createRealtimeTransport({
    url: 'wss://example.invalid/connection/websocket',
    onStatus: status => statuses.push(status),
    getToken: async () => 'token',
    now: () => clock,
  });
  transport.start();
  return centrifugeMock.__clients[centrifugeMock.__clients.length - 1];
}

function advance(ms: number): void {
  clock += ms;
  jest.advanceTimersByTime(ms);
}

beforeEach(() => {
  jest.useFakeTimers();
  centrifugeMock.__reset();
  resetRealtimeDiagnostics();
  appState.currentState = 'active';
  appState.handlers = [];
  clock = 0;
  statuses = [];
});

afterEach(() => {
  transport?.dispose();
  transport = null;
  jest.useRealTimers();
});

describe('display grace, through the transport', () => {
  it('a network-type force-reconnect never shows 「연결이 끊겼습니다」', () => {
    const client = start();
    expect(statuses).toEqual(['connected']);
    netInfo.__emit({type: 'wifi', isConnected: true});
    netInfo.__emit({type: 'cellular', isConnected: true});
    // force-reconnect = disconnect() then connect() on the same client; the
    // fake emits a raw `disconnected` for the first, which used to reach the
    // screen as-is.
    expect(client.disconnectCount).toBe(1);
    expect(client.connectCount).toBe(2);
    advance(DISPLAY_GRACE_MS * 3);
    expect(statuses).toEqual(['connected']);
  });

  it('a reconnect loop longer than the grace is shown, once, at the grace', () => {
    const client = start();
    client.state = 'connecting';
    client.__emit('connecting', {code: 1, reason: 'transport closed'});
    advance(DISPLAY_GRACE_MS - 1);
    expect(statuses).toEqual(['connected']);
    advance(1);
    expect(statuses).toEqual(['connected', 'disconnected']);
    client.__emit('connecting', {code: 1, reason: 'transport closed'});
    advance(DISPLAY_GRACE_MS * 3);
    expect(statuses).toEqual(['connected', 'disconnected']);
  });
});

describe('foreground return', () => {
  it('cuts a reconnect backoff short (connect() alone is a no-op while connecting)', () => {
    const client = start();
    emitAppState('background');
    // The radio died while away; centrifuge-js is in its backoff (no attempt
    // in flight).
    client.state = 'connecting';
    client._reconnecting = false;
    client.__emit('connecting', {code: 1, reason: 'transport closed'});
    const disconnectsBefore = client.disconnectCount;
    const connectsBefore = client.connectCount;
    emitAppState('active');
    expect(client.disconnectCount).toBe(disconnectsBefore + 1);
    expect(client.connectCount).toBe(connectsBefore + 1);
    expect(client.state).toBe('connected');
  });

  it('leaves an attempt already in flight to finish (review M2)', () => {
    const client = start();
    emitAppState('background');
    client.state = 'connecting';
    client.__emit('connecting', {code: 1, reason: 'transport closed'});
    // Token fetch / handshake under way.
    client._reconnecting = true;
    const disconnectsBefore = client.disconnectCount;
    emitAppState('active');
    expect(client.disconnectCount).toBe(disconnectsBefore);
  });

  it('leaves a socket that survived the absence alone', () => {
    const client = start();
    emitAppState('background');
    advance(1_000);
    emitAppState('active');
    expect(client.disconnectCount).toBe(0);
    expect(client.connectCount).toBe(1);
  });

  it('reconnects after the grace dropped the socket', () => {
    const client = start();
    emitAppState('background');
    advance(BACKGROUND_GRACE_MS);
    expect(client.disconnectCount).toBe(1);
    expect(client.state).toBe('disconnected');
    emitAppState('active');
    expect(client.state).toBe('connected');
    expect(client.connectCount).toBe(2);
  });

  it('clears a stale token before reconnecting, so the first attempt is not a 109', async () => {
    const client = start();
    await client.options.getToken(); // centrifuge-js fetched a token at t=0
    emitAppState('background');
    advance(BACKGROUND_GRACE_MS);
    advance(REALTIME_TOKEN_STALE_MS);
    emitAppState('active');
    expect(client.setTokenCalls).toEqual(['']);
  });

  it('keeps a fresh token', async () => {
    const client = start();
    await client.options.getToken();
    emitAppState('background');
    advance(BACKGROUND_GRACE_MS);
    emitAppState('active');
    expect(client.setTokenCalls ?? []).toEqual([]);
  });
});

describe('dispose (review M1)', () => {
  it('reports nothing after dispose — the closing disconnect must not arm a grace', () => {
    start();
    const t = transport as RealtimeTransport;
    transport = null;
    t.dispose();
    const after = statuses.length;
    advance(8_000);
    expect(statuses.length).toBe(after);
  });
});

describe('the stale-token threshold (review Low)', () => {
  it('is below the server default connection-token TTL', () => {
    // Read from the server source so the two cannot drift apart silently.
    // The server lets an operator override it (CENT_CONNECTION_TOKEN_TTL_SECONDS,
    // clamped 60–1800 s); the default is what this client is tuned to.
    const rust = readFileSync(
      resolve(__dirname, '../../../server-rust/crates/momo-auth/src/realtime.rs'),
      'utf8',
    );
    const m = rust.match(/CONNECTION_TOKEN_TTL_SECONDS:\s*i64\s*=\s*([0-9*\s]+);/);
    expect(m).not.toBeNull();
    const ttlSeconds = (m as RegExpMatchArray)[1]
      .split('*')
      .map(part => Number(part.trim()))
      .reduce((a, b) => a * b, 1);
    expect(ttlSeconds).toBe(300);
    expect(REALTIME_TOKEN_STALE_MS).toBeLessThan(ttlSeconds * 1000);
    expect(REALTIME_TOKEN_STALE_MS).toBeGreaterThan(0);
  });
});

describe('instrumentation (#2751)', () => {
  it('records lifetime and cause — e.g. the one client timer that CAN yield 20.7 s (background 5.7 s after connecting → 15 s grace drop); a mechanism demo, not the confirmed trigger', () => {
    const client = start();
    client.__emit('connected', {});
    advance(5_700);
    emitAppState('background');
    advance(BACKGROUND_GRACE_MS);
    expect(client.disconnectCount).toBe(1);
    const drop = realtimeDiagnostics().find(e => e.kind === 'disconnected');
    expect(drop?.lifetimeMs).toBe(20_700);
    // The policy action that caused it is recorded just before it.
    const kinds = realtimeDiagnostics().map(e =>
      e.kind === 'policy' ? `policy:${e.detail}` : e.kind,
    );
    const at = kinds.lastIndexOf('disconnected');
    expect(kinds.slice(at - 1, at + 1)).toEqual(['policy:disconnect', 'disconnected']);
    expect(formatRealtimeDiagnostics()).toMatch(/disconnected .*lifetime=20\.7s/);
  });

  it('records centrifuge codes and network types, and nothing that identifies anyone', async () => {
    const client = start();
    client.__emit('connected', {});
    advance(3_000);
    client.state = 'connecting';
    client.__emit('connecting', {code: 3, reason: 'subscribe timeout'});
    client.__emit('error', {
      type: 'connectToken',
      error: {code: 10, message: 'https://secret.example/v1/auth user@example.com'},
    });
    netInfo.__emit({type: 'wifi', isConnected: true});
    netInfo.__emit({type: 'cellular', isConnected: true});
    const out = formatRealtimeDiagnostics();
    expect(out).toMatch(/connecting code=3 subscribe timeout lifetime=3\.0s/);
    expect(out).toMatch(/error code=10 connectToken/);
    expect(out).toMatch(/network wifi->cellular/);
    expect(out).not.toMatch(/secret\.example|user@example\.com|example\.invalid/);
  });
});

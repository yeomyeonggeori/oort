// =============================================================================
// #2751 — which of centrifuge-js 5.7's own timers can end a phone socket, and
// after how long. Runs the REAL library (not the `jest.setup.js` fake) against
// an in-process mock Centrifugo that speaks the JSON protocol, with fake timers.
//
// The RCA (2026-09-26) measured socket lifetimes of 2.1 / 20.7 / 20.7 / 5.0 /
// 0.5 s and 34.5 / 29.2 s. This file pins down what the library itself
// produces so the next trace can be read against it:
//
//   subscribeTimeout (connecting code 3)  exactly `timeout` (5 s) after a
//     subscribe goes unanswered. IF Centrifugo answers one connection's
//     commands one at a time (its documented default without
//     `client.concurrency` — taken from the docs, NOT measured against the team
//     server), and every subscribe here crosses the subscribe proxy to the API,
//     then N subscriptions × proxy latency > 5 s drops the WHOLE connection, on
//     every reconnect. The mock below is serial on purpose to show that shape.
//     The 4985 ms socket in the trace has it.
//   noPing (connecting code 2)            server ping interval + 10 s = 35 s.
//     The 34.5 s socket has this shape.
//
// Neither is 20.7 s. The one fixed timer in this client that CAN produce a
// 20.7 s lifetime is the 15 s background grace armed 5.7 s after connecting
// (`realtimeTransport.test.ts`), and the RCA already judged that a poor fit for
// a back-to-back pair — so the instrumentation, not this file, has to name the
// trigger of the observed pair.
// =============================================================================

import {attemptInFlight} from '../src/realtime/centrifugeTransport';

type Handler = ((ev?: unknown) => void) | null;

interface ServerOptions {
  /** Delay before each subscribe reply; replies are serialised per socket. */
  subscribeLatencyMs: number;
  /** Server ping interval in seconds (0 = the server never pings). */
  pingSeconds: number;
  /** Does the server actually send the pings it announced? */
  sendPings: boolean;
}

interface SocketRecord {
  openedAt: number;
  closedAt: number | null;
}

function mockCentrifugo(options: ServerOptions) {
  const sockets: SocketRecord[] = [];

  class MockWebSocket {
    onopen: Handler = null;
    onclose: Handler = null;
    onerror: Handler = null;
    onmessage: Handler = null;
    private record: SocketRecord;
    private queue: Record<string, unknown>[] = [];
    private busy = false;
    private closed = false;
    private pinger: ReturnType<typeof setInterval> | null = null;

    constructor(_url: string) {
      this.record = {openedAt: Date.now(), closedAt: null};
      sockets.push(this.record);
      setTimeout(() => this.onopen?.(), 0);
    }

    send(data: string): void {
      for (const line of data.split('\n')) {
        if (line.trim() === '') continue;
        const cmd = JSON.parse(line) as Record<string, unknown>;
        if (cmd.id === undefined) continue; // pong
        this.queue.push(cmd);
      }
      this.pump();
    }

    close(): void {
      if (this.closed) return;
      this.closed = true;
      this.record.closedAt = Date.now();
      if (this.pinger) clearInterval(this.pinger);
      setTimeout(() => this.onclose?.({code: 1000, reason: ''}), 0);
    }

    private reply(obj: unknown): void {
      if (this.closed) return;
      this.onmessage?.({data: JSON.stringify(obj)});
    }

    /** One command at a time, like Centrifugo without `client.concurrency`. */
    private pump(): void {
      if (this.busy || this.closed) return;
      const cmd = this.queue.shift();
      if (!cmd) return;
      this.busy = true;
      const done = (obj: unknown) => {
        this.reply(obj);
        this.busy = false;
        this.pump();
      };
      if (cmd.connect !== undefined) {
        setTimeout(() => {
          done({
            id: cmd.id,
            connect: {
              client: 'c',
              version: '6',
              ping: options.pingSeconds,
              pong: true,
            },
          });
          if (options.sendPings && options.pingSeconds > 0) {
            this.pinger = setInterval(
              () => this.reply({}),
              options.pingSeconds * 1000,
            );
          }
        }, 20);
      } else if (cmd.subscribe !== undefined) {
        setTimeout(() => done({id: cmd.id, subscribe: {}}), options.subscribeLatencyMs);
      } else {
        setTimeout(() => done({id: cmd.id, [Object.keys(cmd).find(k => k !== 'id') ?? 'x']: {}}), 5);
      }
    }
  }

  return {MockWebSocket, sockets};
}

const {Centrifuge} = jest.requireActual('centrifuge') as typeof import('centrifuge');

interface Observed {
  codes: number[];
  lifetimesMs: number[];
  connectedCount: number;
  subscribedCount: number;
}

async function runFor(
  ms: number,
  server: ServerOptions,
  subscriptions: number,
): Promise<Observed> {
  const {MockWebSocket, sockets} = mockCentrifugo(server);
  const client = new Centrifuge('ws://mock/connection/websocket', {
    websocket: MockWebSocket,
    minReconnectDelay: 500,
    maxReconnectDelay: 20_000,
    getToken: async () => 'token',
  });
  const codes: number[] = [];
  let connectedCount = 0;
  let subscribedCount = 0;
  client.on('connecting', ctx => {
    if (ctx.code !== 0) codes.push(ctx.code);
  });
  client.on('connected', () => {
    connectedCount += 1;
  });
  for (let i = 0; i < subscriptions; i += 1) {
    const sub = client.newSubscription(`agent:ws.${i}`);
    sub.on('subscribed', () => {
      subscribedCount += 1;
    });
    sub.subscribe();
  }
  client.connect();
  await jest.advanceTimersByTimeAsync(ms);
  client.disconnect();
  const lifetimesMs = sockets
    .filter(s => s.closedAt !== null)
    .map(s => (s.closedAt as number) - s.openedAt);
  return {codes, lifetimesMs, connectedCount, subscribedCount};
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe('centrifuge-js 5.7 timers against a serial subscribe proxy', () => {
  it('34 subscriptions × 160 ms proxy latency → the whole socket drops at 5.0 s (subscribeTimeout), and keeps doing it', async () => {
    const {codes, lifetimesMs, connectedCount, subscribedCount} = await runFor(
      30_000,
      {subscribeLatencyMs: 160, pingSeconds: 25, sendPings: true},
      34,
    );
    expect(codes[0]).toBe(3);
    // It did connect: the drop is the subscribe storm, not the handshake.
    expect(connectedCount).toBeGreaterThanOrEqual(3);
    expect(subscribedCount).toBeGreaterThan(0);
    // connect reply (20 ms) + 5000 ms subscribe timeout
    expect(lifetimesMs[0]).toBeGreaterThanOrEqual(5_000);
    expect(lifetimesMs[0]).toBeLessThan(5_100);
    // Churn: every reconnect replays the same storm.
    expect(codes.filter(c => c === 3).length).toBeGreaterThanOrEqual(3);
  });

  it('the same subscriptions under 5 s total stay up', async () => {
    const {codes, connectedCount, subscribedCount, lifetimesMs} = await runFor(
      60_000,
      {subscribeLatencyMs: 100, pingSeconds: 25, sendPings: true},
      34,
    );
    expect(codes).toEqual([]);
    expect(connectedCount).toBe(1);
    expect(subscribedCount).toBe(34);
    // The only close is the test's own disconnect at 60 s: pings kept it alive.
    expect(lifetimesMs).toHaveLength(1);
    expect(lifetimesMs[0]).toBe(60_000);
  });

  it('a server whose pings never arrive → drop at ping + 10 s = 35 s (noPing)', async () => {
    const {codes, lifetimesMs} = await runFor(
      40_000,
      {subscribeLatencyMs: 10, pingSeconds: 25, sendPings: false},
      2,
    );
    expect(codes[0]).toBe(2);
    expect(lifetimesMs[0]).toBeGreaterThanOrEqual(35_000);
    expect(lifetimesMs[0]).toBeLessThan(35_100);
  });
});

describe('the private flag `resume` relies on (review M2)', () => {
  it('`_reconnecting` is true during an attempt and false while waiting out a backoff', async () => {
    const {MockWebSocket} = mockCentrifugo({
      subscribeLatencyMs: 10,
      pingSeconds: 25,
      sendPings: true,
    });
    let release: ((token: string) => void) | null = null;
    let calls = 0;
    const client = new Centrifuge('ws://mock/connection/websocket', {
      websocket: MockWebSocket,
      minReconnectDelay: 5_000,
      maxReconnectDelay: 20_000,
      getToken: () => {
        calls += 1;
        if (calls === 1) return Promise.reject(new Error('offline'));
        return new Promise<string>(r => {
          release = r;
        });
      },
    });
    client.on('error', () => {});
    client.connect();
    // First token fetch fails → backoff scheduled, nothing in flight.
    await jest.advanceTimersByTimeAsync(10);
    expect(client.state).toBe('connecting');
    expect(attemptInFlight(client)).toBe(false);
    // Backoff elapses → second attempt starts and waits on the token.
    await jest.advanceTimersByTimeAsync(10_000);
    expect(calls).toBe(2);
    expect(client.state).toBe('connecting');
    expect(attemptInFlight(client)).toBe(true);
    (release as unknown as (t: string) => void)('token');
    await jest.advanceTimersByTimeAsync(100);
    expect(client.state).toBe('connected');
    client.disconnect();
  });
});

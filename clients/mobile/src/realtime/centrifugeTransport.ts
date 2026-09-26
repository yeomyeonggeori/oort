import NetInfo from '@react-native-community/netinfo';
import {Centrifuge} from 'centrifuge';
import {fetchRealtimeToken} from '@momo/core/lib/api';
import type {RealtimeStatus} from '@momo/core/lib/realtimeEvents';
import {AppState, type AppStateStatus} from 'react-native';
import {
  initialPolicyState,
  policyStart,
  policyStep,
  policyStop,
  type AppVisibility,
  type RealtimeAction,
  type RealtimePolicyState,
  type RealtimeSignal,
} from './backgroundPolicy';
import {createConnectionDisplay} from './connectionDisplay';
import {recordRealtimeDiagnostic} from './diagnostics';

// =============================================================================
// The realtime TRANSPORT for iOS (ADR-0137 D4). Wiring only, by the terms of
// this batch: the socket lifecycle, the token source and the background policy.
//
// ## What this batch does and does not deliver
//
// The core owns the frame vocabulary and the `RealtimeHandle` interface
// (`@momo/core/lib/realtimeEvents`): every event shape, every `as*Frame`
// narrowing, `createReplayGate`, and the channel-name builders. `clients/web`
// implements that interface in `lib/realtime.ts` (409 lines of subscription
// bookkeeping and refcounts). **This file does not implement `RealtimeHandle`
// yet** — the subscription surface exists to serve timeline, inbox and work
// panels, none of which exist on this client until 이행 순서 4. Writing it now
// would be writing it against no caller.
//
// What IS here is the part the UI batch cannot supply for itself and that the
// ADR named specifically: a Centrifuge client built the way this product builds
// them, taking its token from the core, driven by D4's background policy.
//
// ## centrifuge-js is kept, and that is a decision (D4)
//
// Mattermost pushed its websocket into a native module and re-syncs the whole
// history over REST whenever it detects a gap. momo does something more precise:
// Centrifugo reports `recovered` / `hasRecoveredPublications` and
// `createReplayGate` tells a recovery batch apart from live traffic. Spike #837
// gate 3 measured that path intact on Hermes — 25/25 publications recovered over
// a 25-second cut, `ctx.recovered === true`. There is no reason to give it up.
//
// It also measured that **no `websocket` implementation needs to be injected**:
// React Native's global `WebSocket` was enough, and passing one changed nothing.
//
// ## KNOWN BLOCKER — `Origin` (spike #837 gate 3, unfixed and not fixable here)
//
// React Native's WebSocket **sends an `Origin` header**, and its value is the
// websocket URL's own origin. Pre-spike research had assumed it did not; the
// measurement disproved that. Against this repo's `infra/centrifugo.json`
// `client.allowed_origins`, the consequence is:
//
//   wss://app.oor7.com/...            Origin https://app.oor7.com     ACCEPTED
//   ws://<machine>.local:28001/...    Origin http://<machine>.local:28001  REJECTED
//   ws://127.0.0.1:<port>/...         Origin http://127.0.0.1:<port>       REJECTED
//
// A rejected handshake surfaces as `{"code":2,"message":"transport closed"}`
// repeating forever with the socket never once open. Self-hosting on a LAN is a
// product property, so this is a real defect and not a dev-only annoyance — but
// the fix is a server configuration and security decision (widen the list, relax
// the check on a native path, or generate the list per deployment), which is
// explicitly outside this batch. Recorded here and in the PR body so the next
// person meets it as a known issue rather than a mystery.
// =============================================================================

export interface RealtimeTransport {
  /** Open the socket. Idempotent. */
  start(): void;
  /** Close it and stop reacting to app-state or network changes. */
  stop(): void;
  /** The underlying client, for the batch that implements `RealtimeHandle`. */
  client(): Centrifuge;
  /** Release the AppState/NetInfo listeners. */
  dispose(): void;
  /** Inspectable for tests and the debug screen. */
  policy(): RealtimePolicyState;
}

export interface RealtimeTransportOptions {
  /**
   * The address login returned, used VERBATIM (ADR-0110). It is never derived
   * from the API base: the server is the only authority on where its own
   * websocket is.
   */
  url: string;
  /**
   * The status to SHOW, not the raw socket state: reconnects shorter than
   * `DISPLAY_GRACE_MS` are absorbed (see `./connectionDisplay.ts`, #2751).
   */
  onStatus?: (status: RealtimeStatus) => void;
  /**
   * Called after every policy transition, with the state that resulted (goal
   * RN-T2).
   *
   * The socket's STATUS cannot answer "should a subscription exist right now":
   * `disconnected` is emitted only when the server closes the session, so a
   * backgrounded app whose grace elapsed sits in the reconnect loop reporting
   * `connecting` forever. The agent rail needs the policy's own answer
   * (`socketWanted`), and this is how it gets it — without a second AppState
   * listener deciding foreground for itself, because two listeners is two
   * answers and the app only has one foreground.
   */
  onPolicy?: (state: RealtimePolicyState) => void;
  /**
   * Token source. Defaults to the core's `fetchRealtimeToken`, which is the
   * point — the token is minted by an authenticated REST call that already
   * knows about rotation and 401 handling, and none of that is re-implemented
   * here. Overridable so a test does not need a server.
   */
  getToken?: () => Promise<string>;
  /** Injected so tests can drive the grace period with fake timers. */
  now?: () => number;
}

type Timer = ReturnType<typeof setTimeout>;

/**
 * When a cached connection token is too old to present again.
 *
 * The server mints it for 300 s (`connection_token_ttl_seconds`,
 * `server-rust/.../routes/realtime.rs`). Reconnecting with an expired one costs
 * a guaranteed round-trip to be told so (`109 token expired`, then centrifuge-js
 * fetches a new one and tries again) — seen in the RCA trace at 03:18:55 as a
 * 0.4-second socket in front of every return from a long absence. 30 s of margin
 * covers clock skew and the handshake itself.
 */
export const REALTIME_TOKEN_STALE_MS = 270_000;

export function createRealtimeTransport(
  options: RealtimeTransportOptions,
): RealtimeTransport {
  const {
    url,
    onStatus,
    onPolicy,
    getToken: fetchToken = fetchRealtimeToken,
    now = Date.now,
  } = options;

  let client: Centrifuge | null = null;
  let graceTimer: Timer | null = null;
  /** When the cached token was minted (by our clock), null before the first. */
  let tokenAt: number | null = null;
  /** When the current connection reached `connected`, null while it is not. */
  let connectedAt: number | null = null;
  const display = createConnectionDisplay(status => onStatus?.(status));

  // Every token centrifuge-js presents comes through here — the first connect,
  // a 109 retry and the scheduled refresh alike — so this one stamp is always
  // the age of the token it is holding.
  const getToken = async (): Promise<string> => {
    const token = await fetchToken();
    tokenAt = now();
    recordRealtimeDiagnostic({at: Date.now(), kind: 'token'});
    return token;
  };
  // Not-background, rather than exactly-active. `policyStep` decides foreground
  // that way for every transition after this one ("iOS `inactive` is NOT
  // background" — see backgroundPolicy.ts), and the opening reading has to use
  // the same rule or the app starts out disagreeing with its own policy: a
  // launch caught at `inactive` (the state iOS passes through before `active`,
  // and the one the app switcher leaves behind) would have read as backgrounded
  // until the first change event arrived. Nothing depended on that until goal
  // RN-T2 gave `socketWanted` to the agent rail; now it decides whether 32
  // subscriptions exist, so the wrong opening value is a rail that starts silent.
  let state = initialPolicyState(AppState.currentState !== 'background');

  /**
   * Adopt a new policy state and tell whoever is listening. Every assignment to
   * `state` goes through here: a transition that updated the variable but not
   * the subscriber would leave the agent rail believing in a socket the policy
   * had already parked.
   */
  function commit(next: RealtimePolicyState): void {
    state = next;
    onPolicy?.(next);
  }

  function build(): Centrifuge {
    const next = new Centrifuge(url, {
      getToken,
      minReconnectDelay: 500,
      maxReconnectDelay: 20_000,
    });
    next.on('connecting', ctx => leave('connecting', ctx));
    next.on('connected', () => {
      connectedAt = now();
      recordRealtimeDiagnostic({at: Date.now(), kind: 'connected'});
      display.push({kind: 'raw', status: 'connected'});
    });
    next.on('disconnected', ctx => leave('disconnected', ctx));
    next.on('error', ctx => {
      // Type and code only. The message of a `connectToken` error is whatever
      // the HTTP layer threw, and may carry a URL or a response body.
      recordRealtimeDiagnostic({
        at: Date.now(),
        kind: 'error',
        code: ctx?.error?.code,
        detail: ctx?.type,
      });
    });
    return next;
  }

  /**
   * Any departure from `connected` — the reconnect loop (`connecting`) and a
   * deliberate close (`disconnected`, e.g. `force-reconnect`) alike. Both used
   * to reach the screen instantly; both now go through the display grace.
   */
  function leave(
    status: 'connecting' | 'disconnected',
    ctx: {code?: number; reason?: string} | undefined,
  ): void {
    const lifetimeMs = connectedAt === null ? undefined : now() - connectedAt;
    connectedAt = null;
    recordRealtimeDiagnostic({
      at: Date.now(),
      kind: status,
      code: ctx?.code,
      detail: ctx?.reason,
      lifetimeMs,
    });
    display.push({kind: 'raw', status});
  }

  /**
   * The person is back. Make a socket happen now, with a token that will be
   * accepted, without touching one that survived.
   */
  function resume(): void {
    const current = ensureClient();
    const socketState = String(current.state);
    if (socketState === 'connected') return;
    // Stale token first: a reconnect would present it and be refused (109).
    // Emptying it makes centrifuge-js call `getToken` before opening.
    if (tokenAt !== null && now() - tokenAt >= REALTIME_TOKEN_STALE_MS) {
      current.setToken('');
      tokenAt = null;
      recordRealtimeDiagnostic({
        at: Date.now(),
        kind: 'policy',
        detail: 'token-cleared',
      });
    }
    display.push({kind: 'resume'});
    if (socketState === 'connecting') {
      // `connect()` is a no-op while connecting, and the client may be sitting
      // in a backoff of up to 20 s. Closing and opening again resets it.
      current.disconnect();
    }
    current.connect();
  }

  function ensureClient(): Centrifuge {
    client ??= build();
    return client;
  }

  function apply(actions: RealtimeAction[]): void {
    for (const action of actions) {
      recordRealtimeDiagnostic({at: Date.now(), kind: 'policy', detail: action.kind});
      switch (action.kind) {
        case 'connect':
          ensureClient().connect();
          break;
        case 'disconnect':
          client?.disconnect();
          break;
        case 'arm-grace':
          if (graceTimer !== null) {
            clearTimeout(graceTimer);
          }
          graceTimer = setTimeout(() => {
            graceTimer = null;
            // iOS suspends a backgrounded app, timers included. On wake a timer
            // that fell due while suspended can run BEFORE the AppState `active`
            // event is delivered, and the policy — still believing it is in
            // the background — would then close the live socket of someone
            // who is looking at the screen, and reopen it a moment later (RCA
            // 2026-09-26 H1). Ask the platform what is true now, and let a
            // foreground reading cancel the drop the ordinary way.
            const current = AppState.currentState;
            if (current !== 'background' && current !== 'unknown' && current != null) {
              dispatch({kind: 'visibility', status: toVisibility(current)});
              return;
            }
            dispatch({kind: 'grace-elapsed'});
          }, action.delayMs);
          break;
        case 'cancel-grace':
          if (graceTimer !== null) {
            clearTimeout(graceTimer);
            graceTimer = null;
          }
          break;
        case 'resume':
          resume();
          break;
        case 'force-reconnect':
          // Disconnect and connect on the SAME client rather than rebuilding:
          // centrifuge-js keeps the recovery offset across a reconnect, which is
          // what lets `createReplayGate` receive a recovery batch instead of a
          // cold subscribe. A fresh client would throw that away and force the
          // full REST re-sync this product deliberately does not do.
          client?.disconnect();
          ensureClient().connect();
          break;
        default:
          break;
      }
    }
  }

  function dispatch(signal: RealtimeSignal): void {
    const step = policyStep(state, signal);
    commit(step.state);
    apply(step.actions);
  }

  const appStateSub = AppState.addEventListener(
    'change',
    (status: AppStateStatus) => {
      recordRealtimeDiagnostic({at: Date.now(), kind: 'app-state', detail: String(status)});
      dispatch({kind: 'visibility', status: toVisibility(status)});
    },
  );

  const netInfoUnsub = NetInfo.addEventListener(netState => {
    const type = netState.type ?? null;
    if (type !== state.networkType) {
      recordRealtimeDiagnostic({
        at: Date.now(),
        kind: 'network',
        detail: `${state.networkType ?? '?'}->${type ?? '?'}${netState.isConnected === false ? ' offline' : ''}`,
      });
    }
    dispatch({
      kind: 'network',
      networkType: netState.type ?? null,
      online: netState.isConnected !== false,
    });
  });

  return {
    start() {
      const step = policyStart(state);
      commit(step.state);
      apply(step.actions);
    },
    stop() {
      const step = policyStop(state);
      commit(step.state);
      apply(step.actions);
    },
    client: ensureClient,
    dispose() {
      if (graceTimer !== null) {
        clearTimeout(graceTimer);
        graceTimer = null;
      }
      display.dispose();
      appStateSub.remove();
      netInfoUnsub();
      client?.disconnect();
      client = null;
    },
    policy: () => state,
  };
}

function toVisibility(status: AppStateStatus): AppVisibility {
  return status === 'background'
    ? 'background'
    : status === 'inactive'
      ? 'inactive'
      : 'active';
}

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
  type RealtimeAction,
  type RealtimePolicyState,
  type RealtimeSignal,
} from './backgroundPolicy';

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
  onStatus?: (status: RealtimeStatus) => void;
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

export function createRealtimeTransport(
  options: RealtimeTransportOptions,
): RealtimeTransport {
  const {url, onStatus, getToken = fetchRealtimeToken} = options;

  let client: Centrifuge | null = null;
  let graceTimer: Timer | null = null;
  let state = initialPolicyState(AppState.currentState === 'active');

  function build(): Centrifuge {
    const next = new Centrifuge(url, {
      getToken,
      minReconnectDelay: 500,
      maxReconnectDelay: 20_000,
    });
    next.on('connecting', () => onStatus?.('connecting'));
    next.on('connected', () => onStatus?.('connected'));
    next.on('disconnected', () => onStatus?.('disconnected'));
    return next;
  }

  function ensureClient(): Centrifuge {
    client ??= build();
    return client;
  }

  function apply(actions: RealtimeAction[]): void {
    for (const action of actions) {
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
            dispatch({kind: 'grace-elapsed'});
          }, action.delayMs);
          break;
        case 'cancel-grace':
          if (graceTimer !== null) {
            clearTimeout(graceTimer);
            graceTimer = null;
          }
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
    state = step.state;
    apply(step.actions);
  }

  const appStateSub = AppState.addEventListener(
    'change',
    (status: AppStateStatus) => {
      dispatch({
        kind: 'visibility',
        status: status === 'background' ? 'background' : status === 'inactive' ? 'inactive' : 'active',
      });
    },
  );

  const netInfoUnsub = NetInfo.addEventListener(netState => {
    dispatch({
      kind: 'network',
      networkType: netState.type ?? null,
      online: netState.isConnected !== false,
    });
  });

  return {
    start() {
      const step = policyStart(state);
      state = step.state;
      apply(step.actions);
    },
    stop() {
      const step = policyStop(state);
      state = step.state;
      apply(step.actions);
    },
    client: ensureClient,
    dispose() {
      if (graceTimer !== null) {
        clearTimeout(graceTimer);
        graceTimer = null;
      }
      appStateSub.remove();
      netInfoUnsub();
      client?.disconnect();
      client = null;
    },
    policy: () => state,
  };
}

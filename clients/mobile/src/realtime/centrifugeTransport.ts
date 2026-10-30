import NetInfo from '@react-native-community/netinfo';
import {Centrifuge} from 'centrifuge';
import {fetchFreshRealtimeToken} from '@momo/core/lib/api';
import type {RealtimeStatus} from '@momo/core/lib/realtimeEvents';
import {AppState, type AppStateStatus} from 'react-native';
import {isOnlineFromNetInfo} from '../query/queryClient';
import {
  DISCONNECT_CALLED,
  initialPolicyState,
  policyStart,
  policyStep,
  policyStop,
  reconnectCeilingMs,
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
  /** Check/reopen now, retaining subscription recovery positions. */
  reconnect(): Promise<void>;
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
   * The status to SHOW: recovering reads `connecting` for ten seconds before
   * admitting an outage (see `./connectionDisplay.ts`, #4783).
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
   * Token source. Defaults to the core's `fetchFreshRealtimeToken`, which is the
   * point — the token is minted by an authenticated REST call that already
   * knows about rotation and 401 handling, and none of that is re-implemented
   * here. Overridable so a test does not need a server.
   */
  getToken?: () => Promise<string>;
  /** Injected so tests can drive the grace period with fake timers. */
  now?: () => number;
}

type Timer = ReturnType<typeof setTimeout>;

/** Do not use a token response that iOS held across suspension (#4783). */
export const TOKEN_RESPONSE_MAX_AGE_MS = 30_000;

export function createRealtimeTransport(
  options: RealtimeTransportOptions,
): RealtimeTransport {
  const {
    url,
    onStatus,
    onPolicy,
    now = Date.now,
    getToken: fetchToken = () => fetchFreshRealtimeToken(now()),
  } = options;

  let client: Centrifuge | null = null;
  let graceTimer: Timer | null = null;
  /** The pending reopen after a token ending (`terminal-retry`), if any. */
  let retryTimer: Timer | null = null;
  /** After `dispose()` nothing may dispatch: `onPolicy` would undo the provider's cleanup. */
  let disposed = false;
  /** When the current connection reached `connected`, null while it is not. */
  let connectedAt: number | null = null;
  const display = createConnectionDisplay(status => onStatus?.(status));

  // Every token centrifuge-js presents comes through here — the first connect,
  // a 109 retry and the scheduled refresh alike.
  const getToken = async (): Promise<string> => {
    let requestedAt = now();
    let token = await fetchToken();
    // A token request itself may have been suspended by iOS. Do not hand a
    // response held across a long lock straight to the socket.
    while (now() - requestedAt >= TOKEN_RESPONSE_MAX_AGE_MS) {
      requestedAt = now();
      token = await fetchToken();
    }
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
   * The retry ceiling the client was last given. It only changes when the policy
   * says so (`reconnectCeilingMs`), and it only governs the NEXT delay centrifuge
   * schedules — a wait already running is not shortened here; `resume` ends it.
   */
  let appliedCeiling = reconnectCeilingMs(state);

  /**
   * Adopt a new policy state and tell whoever is listening. Every assignment to
   * `state` goes through here: a transition that updated the variable but not
   * the subscriber would leave the agent rail believing in a socket the policy
   * had already parked.
   */
  function commit(next: RealtimePolicyState): void {
    state = next;
    const ceiling = reconnectCeilingMs(next);
    if (ceiling !== appliedCeiling) {
      appliedCeiling = ceiling;
      if (client !== null) setReconnectCeiling(client, ceiling);
    }
    onPolicy?.(next);
  }

  function build(): Centrifuge {
    const next = new Centrifuge(url, {
      getToken,
      minReconnectDelay: 500,
      maxReconnectDelay: appliedCeiling,
    });
    next.on('connecting', ctx => leave('connecting', ctx));
    next.on('connected', () => {
      connectedAt = now();
      recordRealtimeDiagnostic({at: Date.now(), kind: 'connected'});
      display.push({kind: 'raw', status: 'connected'});
      clearRetryTimer();
      dispatch({kind: 'connected'});
    });
    next.on('disconnected', ctx => {
      leave('disconnected', ctx);
      // The real client always gives a code; the test fake may not, and "no code"
      // must read as "we closed it" rather than as a server refusal.
      dispatch({kind: 'ended', code: ctx?.code ?? DISCONNECT_CALLED});
    });
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
    ctx: {code?: number} | undefined,
  ): void {
    const lifetimeMs = connectedAt === null ? undefined : now() - connectedAt;
    connectedAt = null;
    recordRealtimeDiagnostic({
      at: Date.now(),
      kind: status,
      code: ctx?.code,
      lifetimeMs,
    });
    display.push({kind: 'raw', status});
  }

  /** Reopen on the SAME client: even `connected` can be a half-open socket
   * after an inactive-only lock. Reopening checks the route immediately rather
   * than waiting 35 seconds for the ping timer, and preserves recovery offsets.
   *
   * One path for every explicit recovery: a foreground return, a network kind
   * change (`force-reconnect`), reachability coming back (`online-reconnect`), a
   * token ending's retry and the person's 「지금 다시 연결」 (`manual-reconnect`,
   * `reconnect()`). It also works from `disconnected`: `connect()` only refuses
   * while connecting or connected.
   */
  function resume(): void {
    if (!state.wantConnected) return;
    // An explicit recovery supersedes a token-ending retry that is still waiting.
    clearRetryTimer();
    const current = ensureClient();
    display.push({kind: 'resume'});
    // Do not duplicate an opening token request/handshake. Its token source
    // refreshes access first, and discards responses held across suspension.
    if (String(current.state) === 'connecting' && attemptInFlight(current)) return;
    // Connection tokens are capped by ACCESS expiry too, so age alone (270 s)
    // cannot prove one is usable after returning. Get one for this handshake.
    current.disconnect();
    current.setToken('');
    recordRealtimeDiagnostic({at: now(), kind: 'policy', detail: 'token-cleared'});
    current.connect(); // public connect() resets retry attempts to zero
  }

  function clearRetryTimer(): void {
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

  function ensureClient(): Centrifuge {
    client ??= build();
    return client;
  }

  function apply(actions: RealtimeAction[]): void {
    for (const action of actions) {
      recordRealtimeDiagnostic({
        at: Date.now(),
        kind: 'policy',
        detail: action.kind,
        code: 'code' in action ? action.code : undefined,
      });
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
          // RCA 2026-09-26 H1 asked whether a grace timer that fell due while
          // iOS held the app suspended can run before the AppState `active`
          // event on wake and close a socket the person is about to look at.
          // It can, and nothing here can tell: RN updates
          // `AppState.currentState` inside the same native event dispatch
          // that calls this file's listener, so re-reading it from the timer
          // still says `background`. Not guarded, deliberately — a timer that
          // ran late after a real suspension most often finds a socket that
          // is dead anyway, and the reconnect that follows is right. What the
          // person used to SEE (「연결이 끊겼습니다」 for the second it took)
          // is what the display grace now absorbs (#2751).
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
        case 'resume':
          if (visibility === 'active') resume();
          break;
        case 'force-reconnect':
        case 'online-reconnect':
        case 'manual-reconnect':
          // Disconnect and connect on the SAME client rather than rebuilding:
          // centrifuge-js keeps the recovery offset across a reconnect, which is
          // what lets `createReplayGate` receive a recovery batch instead of a
          // cold subscribe. A fresh client would throw that away and force the
          // full REST re-sync this product deliberately does not do.
          resume();
          break;
        case 'terminal-retry':
          // centrifuge-js stopped by itself (`disconnected`) because the token was
          // refused. `resume` clears the token, so the reopen fetches a new one.
          clearRetryTimer();
          retryTimer = setTimeout(() => {
            retryTimer = null;
            // Still ended, still wanted, still in front? Anything else has
            // already moved on (a return, a tap, a network change reopened it).
            if (
              client !== null &&
              String(client.state) === 'disconnected' &&
              state.wantConnected &&
              state.foreground
            ) {
              resume();
            }
          }, action.delayMs);
          break;
        case 'terminal-hold':
          // Nothing will reopen it, so there is no gap to wait ten seconds out.
          display.push({kind: 'terminal'});
          break;
        default:
          break;
      }
    }
  }

  function dispatch(signal: RealtimeSignal): void {
    if (disposed) return;
    const step = policyStep(state, signal);
    commit(step.state);
    apply(step.actions);
  }

  let visibility = AppState.currentState;
  const appStateSub = AppState.addEventListener(
    'change',
    (status: AppStateStatus) => {
      recordRealtimeDiagnostic({at: Date.now(), kind: 'app-state', detail: String(status)});
      const inactiveReturn = visibility === 'inactive' && status === 'active' && state.foreground;
      visibility = status;
      dispatch({kind: 'visibility', status: toVisibility(status)});
      if (inactiveReturn) resume();
    },
  );

  const netInfoUnsub = NetInfo.addEventListener(netState => {
    const type = netState.type ?? null;
    // Reachability, not just connectivity — the same rule the rest of the app
    // reads (`isOnlineFromNetInfo`): unknown counts as online. A Wi-Fi whose
    // uplink dropped or a cellular dead zone keeps its KIND and loses only this.
    const online = isOnlineFromNetInfo({
      isConnected: netState.isConnected ?? null,
      isInternetReachable: netState.isInternetReachable ?? null,
    });
    if (type !== state.networkType || online !== state.online) {
      const reading =
        netState.isConnected === false
          ? ' offline'
          : netState.isInternetReachable === false
            ? ' unreachable'
            : '';
      recordRealtimeDiagnostic({
        at: Date.now(),
        kind: 'network',
        detail: `${state.networkType ?? '?'}->${type ?? '?'}${reading}`,
      });
    }
    dispatch({
      kind: 'network',
      networkType: type,
      online,
      at: now(),
      socketUp: client !== null && String(client.state) === 'connected',
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
    reconnect() {
      // 「지금 다시 연결」 and pull to refresh: the policy decides (and records)
      // it, and it goes through the same `resume` as a foreground return.
      dispatch({kind: 'manual'});
      return ensureClient().ready(10_000);
    },
    client: ensureClient,
    dispose() {
      disposed = true;
      clearRetryTimer();
      if (graceTimer !== null) {
        clearTimeout(graceTimer);
        graceTimer = null;
      }
      appStateSub.remove();
      netInfoUnsub();
      // Disconnect BEFORE disposing the display: the disconnect emits a raw
      // `disconnected`, which would otherwise arm a fresh grace timer on a
      // display nobody will ever dispose again (review of #2755, M1).
      client?.disconnect();
      client = null;
      display.dispose();
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

/**
 * Is centrifuge-js in the middle of a connection attempt, as opposed to waiting
 * out a reconnect backoff?
 *
 * The public API cannot tell: both are `state === 'connecting'`. The private
 * `_reconnecting` flag (5.7: set when an attempt starts in `_startReconnecting`,
 * cleared when it fails, before the next backoff is scheduled, and on every
 * state change) is exactly that distinction. It is read defensively — if a
 * future version drops it, this answers `false` and `resume` falls back to
 * cutting the backoff, which is the pre-review behaviour. The flag's meaning is
 * pinned against the real library in `centrifugeChurnRepro.test.ts`, so an
 * upgrade that changes it fails there.
 */
export function attemptInFlight(client: Centrifuge): boolean {
  return (client as unknown as {_reconnecting?: unknown})._reconnecting === true;
}

/**
 * Give a running client a new retry ceiling (#4895).
 *
 * centrifuge-js reads `maxReconnectDelay` from its own config every time it
 * schedules a delay, but offers no setter, and the ceiling has to follow the
 * foreground/online state while ONE client lives on (a new client would drop the
 * recovery offsets). So this writes the private `_config`, defensively, like
 * `attemptInFlight` reads `_reconnecting`: a library that moves it makes this
 * answer `false` (the client keeps the ceiling it was built with — a 5 s ceiling
 * in the background instead of 20 s, a degradation and not a failure). Whether it
 * still works is pinned against the real library in `outageRecovery.test.ts`, so
 * an upgrade that changes it fails there.
 */
export function setReconnectCeiling(client: Centrifuge, ms: number): boolean {
  const config = (client as unknown as {_config?: {maxReconnectDelay?: unknown}})
    ._config;
  if (
    config === undefined ||
    config === null ||
    typeof config.maxReconnectDelay !== 'number'
  ) {
    return false;
  }
  config.maxReconnectDelay = ms;
  return true;
}

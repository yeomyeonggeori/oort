// =============================================================================
// When the realtime socket may be dropped and when it must be rebuilt
// (ADR-0137 D4). Pure: no AppState, no NetInfo, no timers, no Centrifuge — the
// transport in `./centrifugeTransport.ts` supplies the signals and performs the
// actions, and this file only decides. That split is what makes the 15-second
// grace testable at all; a policy tangled into the socket can only be verified
// by sitting and waiting.
//
// The policy is Mattermost's, adopted deliberately (D4):
//
//   background   do NOT drop the socket immediately. Most backgrounding is
//                seconds long — a glance at a notification, the app switcher,
//                answering a message elsewhere. Dropping instantly means the
//                person pays a full reconnect, a token fetch and a recovery
//                replay to look at their own home screen. Wait 15s first.
//   foreground   resume. Cancel a pending drop if the grace has not elapsed.
//                The transport checks the route by reopening on return (#4783).
//   network type FORCE a reconnect. This one is not an optimisation: a socket
//                held across a Wi-Fi -> cellular handover often survives as an
//                object while being attached to a dead route, so it neither
//                errors nor delivers. Only tearing it down surfaces the truth.
//
// And three rules for the person who is LOOKING at the app (#4895 — a team QA
// capture showed 「연결이 끊겼습니다」 for 30+ seconds in front, healed only by
// locking and unlocking the phone):
//
//   online       reachability coming back (`isConnected` / `isInternetReachable`
//   again        false -> true) reconnects at once even when the KIND of
//                connection never changed (a cellular dead zone, a Wi-Fi whose
//                uplink dropped). The kind-change rule above could not see it, and
//                the browser `online` event centrifuge-js listens for is never
//                dispatched on React Native, so the only thing left was the retry
//                backoff. It cuts a wait, so a socket that is still `connected` is
//                left alone.
//   ceiling      in front and online the retry backoff tops out at 5 s, not 20 s.
//                A phone that cannot see why it is offline (server, route) would
//                otherwise sit up to 20 s with a working road. Background and an
//                offline radio keep the old 20 s: nobody is waiting, and a radio
//                that is known to be off is not worth waking more often.
//   ended        centrifuge-js stops retrying on its own once it reports
//                `disconnected`. A token problem is fixed by a fresh token, so it
//                is retried (a bounded number of times); "do not reconnect" from
//                the server is shown and left alone; what WE closed
//                (`disconnectCalled`, code 0) is never an ending to answer.
//
// iOS `inactive` is NOT background. The app is `inactive` while the notification
// shade is pulled down, during an incoming call, and mid-app-switcher — states a
// person is still looking at and returns from immediately. Treating it as
// background would arm the grace timer many times a session for no reason.
// =============================================================================

/** How long a backgrounded app keeps its socket. Mattermost's number (D4). */
export const BACKGROUND_GRACE_MS = 15_000;

/**
 * The longest a person who is looking at the app waits between two connection
 * attempts while the device believes it is online (#4895).
 *
 * 5 s because: it is socket.io's default ceiling and centrifuge-js' own connect
 * timeout (`timeout`, 5 s), so a retry never waits longer than an attempt may
 * take; with full jitter the mean wait at the ceiling is ~2.7 s instead of ~10 s;
 * and at least two attempts fit inside the 10 s the display holds back its outage
 * sentence (`DISPLAY_GRACE_MS`). Load is the cost: while the API or Centrifugo is
 * down, every foreground phone retries about four times as often as before, each
 * retry being a token request (and a handshake once the token route answers).
 * Estimated from the formula, not measured: ~36 attempts per second per hundred
 * foreground phones at the ceiling instead of ~10. The web client keeps 20 s
 * (`clients/web/src/lib/realtime.ts`); this is the one constant to turn if a
 * restart ever shows up as a load spike.
 */
export const FOREGROUND_MAX_RECONNECT_DELAY_MS = 5_000;

/**
 * The ceiling everywhere else — background, and a radio NetInfo reports offline.
 * centrifuge-js' own default and this client's value before #4895: kept on
 * purpose, "background and offline keep the current policy".
 */
export const IDLE_MAX_RECONNECT_DELAY_MS = 20_000;

/**
 * Two online-recovery reconnects are never closer than this. NetInfo reports one
 * recovery as several events (`isConnected` first, `isInternetReachable` when its
 * probe answers) and a flapping radio reports many; each reconnect throws away
 * the attempt in progress, so a burst would keep restarting the handshake.
 */
export const ONLINE_RECONNECT_MIN_INTERVAL_MS = 2_000;

/** centrifuge-js' `disconnected` code for OUR OWN `disconnect()` (`disconnectCalled`). */
export const DISCONNECT_CALLED = 0;

/**
 * `disconnected` codes a NEW token can fix — nothing else is retried:
 *   1     client `unauthorized`: the token source gave nothing usable
 *   101   protocol error `unauthorized` in a connect reply
 *   3500  server disconnect `invalid token`
 * (109 `token expired` never lands here: centrifuge-js refreshes it itself and
 * stays `connecting`. The server numbers are centrifuge's `disconnect.go` /
 * `errors.go`.) Every OTHER non-zero code arrived as `disconnected` because the
 * server or the protocol said not to reconnect (3501-3509: bad request, stale,
 * force disconnect, connection/channel limit, inappropriate protocol, permission
 * denied, not available, too many errors; 1009 message size; bad protocol), and
 * trying again would only repeat it.
 */
export const TOKEN_ENDING_CODES: readonly number[] = [1, 101, 3500];

/**
 * Delays before the first and second retry of a token ending. Two, then the
 * ending is held and shown: a fresh token that is refused again is not a token
 * problem, and an unbounded loop would hammer the token route for as long as the
 * app is open. Any explicit recovery signal (a return from the background, online
 * recovery, a kind change, a tap on 「지금 다시 연결」) or a `connected` starts the
 * count over. A lock-only return (`inactive` -> `active`) reopens through
 * `resume()` without touching the count: it has just fetched a new token, so a
 * token ending right after it is not helped by retrying.
 */
export const TOKEN_RETRY_DELAYS_MS: readonly number[] = [1_000, 5_000];

export type AppVisibility = 'active' | 'inactive' | 'background';

export interface RealtimePolicyState {
  /** Is the person looking at the app? `inactive` still counts as yes. */
  foreground: boolean;
  /** Do we want a live socket right now? */
  wantConnected: boolean;
  /** Is a grace-expiry drop armed? */
  gracePending: boolean;
  /** Last observed network transport ("wifi", "cellular", …), null if unknown. */
  networkType: string | null;
  /**
   * Last observed reachability (`isConnected` and `isInternetReachable`, the same
   * rule as `isOnlineFromNetInfo`). Optimistic `true` until NetInfo says
   * otherwise, like `useOnline`: starting at `false` would turn the first report
   * into a fake recovery.
   */
  online: boolean;
  /** When the last network-driven reconnect was asked for (`signal.at`), null if none. */
  lastNetworkReconnectAt: number | null;
  /** Token endings retried in the current episode (see `TOKEN_RETRY_DELAYS_MS`). */
  terminalRetries: number;
}

export type RealtimeSignal =
  | {kind: 'visibility'; status: AppVisibility}
  | {kind: 'grace-elapsed'}
  /**
   * `at` is the caller's clock (ms): this file reads no clock, by contract.
   * `socketUp` is whether the socket is `connected` right now, as the transport
   * sees it: a recovery with a healthy socket has no wait to cut short.
   */
  | {
      kind: 'network';
      networkType: string | null;
      online: boolean;
      at: number;
      socketUp: boolean;
    }
  /** centrifuge-js reported `disconnected`. `code` as given (see `TOKEN_ENDING_CODES`). */
  | {kind: 'ended'; code: number}
  /** The socket reached `connected`: whatever ended before is over. */
  | {kind: 'connected'}
  /** The person asked for a reconnect (「지금 다시 연결」, pull to refresh). */
  | {kind: 'manual'};

export type RealtimeAction =
  /** Open the socket (no-op if the transport already has one). */
  | {kind: 'connect'}
  /** The person is looking at the app again: make sure a socket is coming NOW.
   *  Unlike `connect`, this must also cut short a reconnect backoff that is
   *  already under way — centrifuge-js ignores `connect()` while it is
   *  `connecting`, so a return during a 20-second backoff would otherwise wait
   *  out the rest of it (#2751). #4783 also checks seemingly connected sockets
   *  on return: iOS can leave one half-open across a lock. */
  | {kind: 'resume'}
  /** Close it. Only ever reached by a grace timer that ran to completion. */
  | {kind: 'disconnect'}
  /** Arm the grace timer. */
  | {kind: 'arm-grace'; delayMs: number}
  /** Disarm it — the person came back in time. */
  | {kind: 'cancel-grace'}
  /** Tear down and rebuild, because the old socket may be attached to a dead
   *  route even though it still looks open. */
  | {kind: 'force-reconnect'}
  /** Reachability came back on the SAME kind of connection (#4895): cut the retry
   *  wait and reopen now. Same path as `resume`. */
  | {kind: 'online-reconnect'}
  /** The person asked for it. Same path as `resume`. */
  | {kind: 'manual-reconnect'}
  /** The socket ENDED for a reason a new token can fix: reopen after `delayMs`. */
  | {kind: 'terminal-retry'; code: number; delayMs: number}
  /** The socket ENDED and nothing here reopens it: show it, do not try. */
  | {kind: 'terminal-hold'; code: number};

export function initialPolicyState(
  foreground: boolean = true,
): RealtimePolicyState {
  return {
    foreground,
    wantConnected: false,
    gracePending: false,
    networkType: null,
    online: true,
    lastNetworkReconnectAt: null,
    terminalRetries: 0,
  };
}

export interface PolicyStep {
  state: RealtimePolicyState;
  actions: RealtimeAction[];
}

/**
 * Is there a socket right now that a subscription could ride?
 *
 * True while a session wants one AND the app is either in front or still inside
 * its grace period — exactly the window between the `connect` action and the
 * `disconnect` the grace timer eventually issues. Derived rather than stored: it
 * is a reading of the three flags above, and a fourth flag would be a second
 * copy of the policy that could disagree with the actions.
 *
 * The agent progress rail asks this before subscribing (goal RN-T2). It is up
 * to 32 subscriptions at the cap against the timeline's one, so leaving them
 * attached to a client the policy has parked means every reconnect pays a
 * subscribe storm — and one recovery batch per pair that `createReplayGate`
 * then throws away. A radio is a cost on a phone.
 *
 * The message rail deliberately does NOT ask: coming back to a conversation
 * with a hole in it is a visible loss, and a 작업 중 badge that takes a moment
 * to reappear after a return is not — the frames it missed were about a turn
 * that has since moved on anyway.
 */
export function socketWanted(state: RealtimePolicyState): boolean {
  return state.wantConnected && (state.foreground || state.gracePending);
}

/**
 * How long the retry backoff may grow right now (#4895). Derived like
 * `socketWanted`, from the same flags: in front AND not known to be offline the
 * person is waiting, so the ceiling is short; anywhere else the old one stands.
 * `inactive` counts as in front, as everywhere in this file.
 */
export function reconnectCeilingMs(state: RealtimePolicyState): number {
  return state.foreground && state.online
    ? FOREGROUND_MAX_RECONNECT_DELAY_MS
    : IDLE_MAX_RECONNECT_DELAY_MS;
}

/**
 * Sign in / sign out are not signals but explicit starts and stops: the socket
 * exists because there is a session, and no amount of app-state churn should
 * create one when there is not.
 */
export function policyStart(state: RealtimePolicyState): PolicyStep {
  if (state.wantConnected) {
    return {state, actions: []};
  }
  return {state: {...state, wantConnected: true}, actions: [{kind: 'connect'}]};
}

export function policyStop(state: RealtimePolicyState): PolicyStep {
  const actions: RealtimeAction[] = [];
  if (state.gracePending) {
    actions.push({kind: 'cancel-grace'});
  }
  if (state.wantConnected) {
    actions.push({kind: 'disconnect'});
  }
  return {
    state: {...state, wantConnected: false, gracePending: false, terminalRetries: 0},
    actions,
  };
}

/** A clock that moved backwards must not mute recoveries until it catches up. */
function intervalElapsed(since: number | null, at: number): boolean {
  if (since === null) {
    return true;
  }
  const elapsed = at - since;
  return elapsed < 0 || elapsed >= ONLINE_RECONNECT_MIN_INTERVAL_MS;
}

export function policyStep(
  state: RealtimePolicyState,
  signal: RealtimeSignal,
): PolicyStep {
  switch (signal.kind) {
    case 'visibility': {
      const foreground = signal.status !== 'background';
      if (foreground === state.foreground) {
        return {state, actions: []};
      }
      const next = {...state, foreground};

      if (!state.wantConnected) {
        // No session, so nothing to preserve or drop.
        return {state: next, actions: []};
      }

      if (foreground) {
        const actions: RealtimeAction[] = [];
        if (state.gracePending) {
          // Prevent the old background deadline from closing the returning
          // connection. The transport resumes on the same client.
          actions.push({kind: 'cancel-grace'});
        }
        // Either the grace elapsed while away and the socket was dropped, or it
        // was kept but may have died with the radio while the app was away and
        // is now sitting in a backoff. `resume` rebuilds the first and cuts the
        // second short, including a half-open connected socket (#4783).
        actions.push({kind: 'resume'});
        // A return is an explicit recovery: a held ending gets a fresh budget.
        return {state: {...next, gracePending: false, terminalRetries: 0}, actions};
      }

      if (state.gracePending) {
        return {state: next, actions: []};
      }
      return {
        state: {...next, gracePending: true},
        actions: [{kind: 'arm-grace', delayMs: BACKGROUND_GRACE_MS}],
      };
    }

    case 'grace-elapsed': {
      if (!state.gracePending) {
        return {state, actions: []};
      }
      if (state.foreground) {
        // Cancellation lost a race with the timer firing. The person is looking
        // at the app; keep the socket.
        return {state: {...state, gracePending: false}, actions: []};
      }
      return {
        state: {...state, gracePending: false},
        actions: [{kind: 'disconnect'}],
      };
    }

    case 'network': {
      // The first observation is not a transition — there was no previous route
      // to have been stranded on.
      const kindChanged =
        signal.networkType !== null &&
        state.networkType !== null &&
        signal.networkType !== state.networkType;
      const cameBack = !state.online && signal.online;
      const next = {
        ...state,
        networkType: signal.networkType,
        online: signal.online,
      };
      if (!state.wantConnected || !signal.online) {
        return {state: next, actions: []};
      }
      if (kindChanged) {
        // Not gated on `foreground`: unchanged since the rule was written.
        return {
          state: {
            ...next,
            terminalRetries: 0,
            lastNetworkReconnectAt: signal.at,
          },
          actions: [{kind: 'force-reconnect'}],
        };
      }
      // The same kind of connection, but the road was down and is up again
      // (#4895). It cuts a WAIT, so it needs one: a socket that is connected is
      // left alone (NetInfo's reachability probe flaps on a healthy connection too,
      // and each reconnect would flash 「연결 중…」 for nothing; a socket that really
      // died in a dead zone is closed by the server or by the ping timeout). Only
      // for a person who is looking — a socket parked in the background is parked
      // on purpose and is rebuilt on return — and never twice inside the interval
      // limit.
      if (
        cameBack &&
        !signal.socketUp &&
        state.foreground &&
        intervalElapsed(state.lastNetworkReconnectAt, signal.at)
      ) {
        return {
          state: {
            ...next,
            terminalRetries: 0,
            lastNetworkReconnectAt: signal.at,
          },
          actions: [{kind: 'online-reconnect'}],
        };
      }
      return {state: next, actions: []};
    }

    case 'connected': {
      if (state.terminalRetries === 0) {
        return {state, actions: []};
      }
      return {state: {...state, terminalRetries: 0}, actions: []};
    }

    case 'manual': {
      if (!state.wantConnected) {
        return {state, actions: []};
      }
      return {
        state: {...state, terminalRetries: 0},
        actions: [{kind: 'manual-reconnect'}],
      };
    }

    case 'ended': {
      // Our own `disconnect()` — the grace dropping a parked socket, `resume`
      // closing before it reopens, `stop`, `dispose`. Never an ending to answer:
      // answering it would flash 「연결이 끊겼습니다」 on every return.
      if (signal.code === DISCONNECT_CALLED) {
        return {state, actions: []};
      }
      // No session, or nobody looking: a return rebuilds the socket with a new
      // token anyway (`resume`), so there is nothing to do and nothing to show.
      if (!state.wantConnected || !state.foreground) {
        return {state, actions: []};
      }
      if (
        TOKEN_ENDING_CODES.includes(signal.code) &&
        state.terminalRetries < TOKEN_RETRY_DELAYS_MS.length
      ) {
        return {
          state: {...state, terminalRetries: state.terminalRetries + 1},
          actions: [
            {
              kind: 'terminal-retry',
              code: signal.code,
              delayMs: TOKEN_RETRY_DELAYS_MS[state.terminalRetries],
            },
          ],
        };
      }
      return {state, actions: [{kind: 'terminal-hold', code: signal.code}]};
    }

    default: {
      return {state, actions: []};
    }
  }
}

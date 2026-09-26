import type {RealtimeStatus} from '@momo/core/lib/realtimeEvents';

// =============================================================================
// What the person is TOLD about the socket, as opposed to what the socket is
// doing (#2751).
//
// centrifuge-js reports every reconnect the moment it starts. On a phone that
// happens constantly and mostly harmlessly: a Wi-Fi/cellular handover, a
// `force-reconnect`, a server ping that came late — each one is a sub-second
// to two-second gap that heals itself. The first version of this client turned
// every one of those into 「연결이 끊겼습니다」, because once a socket had been
// connected, "not connected" was reported as "disconnected" instantly. The
// owner's capture (IMG_4159, 03:15:54Z) was exactly that: a 1.7-second
// reconnect photographed mid-flight while REST, auth and the timeline were all
// fine.
//
// The rule now:
//
//   before the first `connected`   report the raw status. The opening
//                                  handshake is honestly 「연결 중」, and a
//                                  session the server refuses outright is
//                                  honestly disconnected.
//   after it                       keep reporting `connected` through a gap for
//                                  up to `DISPLAY_GRACE_MS`. Only a gap that
//                                  outlives it becomes `disconnected`, and it
//                                  becomes that ONCE — a long outage's retry
//                                  loop does not blink the label back to
//                                  「연결 중」 on every attempt.
//   a return to the foreground     with no live socket reads `connecting` and
//                                  gets a fresh grace. The app was away; the
//                                  reconnect it starts now is an opening, not a
//                                  fault, and a timer that expired while iOS had
//                                  the app suspended must not fire the moment it
//                                  wakes up and claim an outage that has had no
//                                  chance to heal.
//
// The shape of `RealtimeStatus` is unchanged — three values — so every reader
// (the conversation header, the activity rail, the ADE panel) keeps its own
// wording and simply stops seeing the blips.
//
// Pure reducer + a thin timer driver, the same split as `backgroundPolicy.ts`,
// so the grace is asserted rather than watched.
// =============================================================================

/**
 * How long a reconnect may run before it is shown as a disconnection.
 *
 * The issue's band is 3–5 s. The measured reconnects in the RCA trace were 0.3 s
 * (a client-initiated reconnect), 1.6–1.7 s (one backoff step) and, after a
 * token expiry, ~2.6 s including the token round-trip. 4 s clears all three
 * with room for a slow cellular TLS handshake, and is still short enough that a
 * real outage is admitted within a breath.
 */
export const DISPLAY_GRACE_MS = 4_000;

export interface DisplayState {
  /** What readers see. */
  shown: RealtimeStatus;
  /** Has this transport ever reached `connected`? */
  everConnected: boolean;
  /** Is a grace timer running? */
  graceArmed: boolean;
}

export type DisplayEvent =
  /** A raw status from centrifuge-js. */
  | {kind: 'raw'; status: RealtimeStatus}
  /** The grace timer ran out. */
  | {kind: 'grace-expired'}
  /** The app came back to the foreground and there is no live socket. */
  | {kind: 'resume'};

export type DisplayAction = {kind: 'arm'} | {kind: 'cancel'};

export interface DisplayStep {
  state: DisplayState;
  actions: DisplayAction[];
}

export function initialDisplayState(): DisplayState {
  return {shown: 'connecting', everConnected: false, graceArmed: false};
}

export function displayStep(
  state: DisplayState,
  event: DisplayEvent,
): DisplayStep {
  switch (event.kind) {
    case 'raw': {
      if (event.status === 'connected') {
        return {
          state: {shown: 'connected', everConnected: true, graceArmed: false},
          actions: state.graceArmed ? [{kind: 'cancel'}] : [],
        };
      }
      if (!state.everConnected) {
        // Opening handshake (or an outright refusal): say what is happening.
        return {state: {...state, shown: event.status}, actions: []};
      }
      if (state.shown === 'disconnected') {
        // Already admitted. Retry attempts inside a long outage must not flip
        // the label back and forth.
        return {state, actions: []};
      }
      if (state.graceArmed) {
        return {state, actions: []};
      }
      // A gap has opened. Keep showing what was shown and start the clock.
      return {state: {...state, graceArmed: true}, actions: [{kind: 'arm'}]};
    }

    case 'grace-expired': {
      if (!state.graceArmed) {
        return {state, actions: []};
      }
      return {
        state: {...state, shown: 'disconnected', graceArmed: false},
        actions: [],
      };
    }

    case 'resume': {
      // Always a FRESH grace: the old timer may have been due for minutes while
      // iOS held the app suspended, and letting it fire on wake would report an
      // outage the reconnect has not yet had a chance to heal.
      const actions: DisplayAction[] = state.graceArmed
        ? [{kind: 'cancel'}, {kind: 'arm'}]
        : [{kind: 'arm'}];
      const shown: RealtimeStatus =
        state.shown === 'disconnected' ? 'connecting' : state.shown;
      return {state: {...state, shown, graceArmed: true}, actions};
    }

    default:
      return {state, actions: []};
  }
}

export interface ConnectionDisplay {
  push(event: DisplayEvent): void;
  current(): RealtimeStatus;
  dispose(): void;
}

/**
 * Drive `displayStep` with one real timer and report every change of `shown`
 * (and only changes — a reader re-rendering on an unchanged label is waste).
 */
export function createConnectionDisplay(
  onChange: (status: RealtimeStatus) => void,
  graceMs: number = DISPLAY_GRACE_MS,
): ConnectionDisplay {
  let state = initialDisplayState();
  let timer: ReturnType<typeof setTimeout> | null = null;

  function clear(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function push(event: DisplayEvent): void {
    const before = state.shown;
    const step = displayStep(state, event);
    state = step.state;
    for (const action of step.actions) {
      if (action.kind === 'cancel') {
        clear();
      } else {
        clear();
        timer = setTimeout(() => {
          timer = null;
          push({kind: 'grace-expired'});
        }, graceMs);
      }
    }
    if (state.shown !== before) onChange(state.shown);
  }

  return {
    push,
    current: () => state.shown,
    dispose: clear,
  };
}

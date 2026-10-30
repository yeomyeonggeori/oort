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
// Every gap reads `connecting` for ten seconds, including the first handshake.
// Retry events do not restart the deadline. A foreground return gets one fresh
// deadline because time spent suspended is not foreground recovery time (#4783).

export const DISPLAY_GRACE_MS = 10_000;

export interface DisplayState {
  /** What readers see. */
  shown: RealtimeStatus;
  /** Is a grace timer running? */
  graceArmed: boolean;
}

export type DisplayEvent =
  /** A raw status from centrifuge-js. */
  | {kind: 'raw'; status: RealtimeStatus}
  /** The grace timer ran out. */
  | {kind: 'grace-expired'}
  /** Foreground return or an explicit request to check the socket. */
  | {kind: 'resume'};

export type DisplayAction = {kind: 'arm'} | {kind: 'cancel'};

export interface DisplayStep {
  state: DisplayState;
  actions: DisplayAction[];
}

export function initialDisplayState(): DisplayState {
  return {shown: 'connecting', graceArmed: false};
}

export function displayStep(
  state: DisplayState,
  event: DisplayEvent,
): DisplayStep {
  switch (event.kind) {
    case 'raw': {
      if (event.status === 'connected') {
        return {
          state: {shown: 'connected', graceArmed: false},
          actions: state.graceArmed ? [{kind: 'cancel'}] : [],
        };
      }
      if (state.shown === 'disconnected' || state.graceArmed) {
        return {state, actions: []};
      }
      return {
        state: {...state, shown: 'connecting', graceArmed: true},
        actions: [{kind: 'arm'}],
      };
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
      const shown: RealtimeStatus = 'connecting';
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

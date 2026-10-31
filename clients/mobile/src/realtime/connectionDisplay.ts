import type {RealtimeStatus} from '@momo/core/lib/realtimeEvents';

// 상태 낱말은 여기 한 곳에서만 적는다(문구 장부는 영어 낱말 리터럴도 센다 — 같은 낱말을 파일 곳곳에 되풀이하면 장부가 는다).
const CONNECTED: RealtimeStatus = 'connected';
const CONNECTING: RealtimeStatus = 'connecting';
const DISCONNECTED: RealtimeStatus = 'disconnected';

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
// ## Two clocks, both counted from the START of a gap
//
//   outage  `DISPLAY_GRACE_MS` (10 s). `shown` reads `connecting` until this
//           runs out and only then `disconnected` (#4783). Retry events do not
//           restart it. A foreground return gets one fresh deadline because time
//           spent suspended is not foreground recovery time.
//   quiet   `CONNECTING_BAND_DELAY_MS` (1 s). For the first second of a gap the
//           BAND says nothing at all (#4949, owner 2026-10-31). `shown` is not
//           touched by it: readers that ask "is the socket live?" still see
//           `connecting` at once, and only the sentence on the screen waits.
//
// The rule it replaces — #4783: "every gap reads `connecting` for ten seconds,
// including the first handshake" — put 「연결 중…」 on the screen the instant a
// socket left `connected`. Since #4783 every foreground return reopens the socket
// on purpose (`resume` checks even a seemingly connected one), so every return
// to the app flashed the band for the 0.3–1 s a handshake takes. A connection
// that is over inside a second has nothing to announce; one that is still going
// after a second does, and the band then reads 「연결 중…」 until it connects or
// the outage deadline turns it into 「연결이 끊겼습니다」. A band that is already up
// is never taken down and put up again: it stays until the socket is connected.
//
// One exception: an ENDED socket that nothing is going to reopen (the server said
// "do not reconnect", #4895). There is no gap to wait out, so showing
// 「연결 중…」 for ten seconds would be a lie about something that is not
// happening — it is shown as an outage at once, and the person can ask for a
// reconnect from the banner.

/** The outage deadline: how long a gap reads `connecting` before it is called an outage. */
export const DISPLAY_GRACE_MS = 10_000;

/**
 * How long a gap must last before the band may say 「연결 중…」 (#4949).
 *
 * 1 s because: the owner asked for "0.5 s or 1 s" and a handshake normally takes
 * 0.3–1 s (token request + websocket + subscribe), so 0.5 s would still flash on
 * every slow return while 1 s leaves a return that is merely slow silent; and it
 * is a tenth of the outage deadline, so the band is up for the rest of the gap
 * and the person is never left with a socket that is visibly trying and no
 * sentence for it.
 */
export const CONNECTING_BAND_DELAY_MS = 1_000;

export interface DisplayState {
  /** What readers see: `connecting` until the outage deadline, then `disconnected`. */
  shown: RealtimeStatus;
  /** Is the outage timer running? */
  graceArmed: boolean;
  /**
   * The gap has not yet lasted `CONNECTING_BAND_DELAY_MS`, so the band stays silent
   * (#4949). Only ever true while `shown` is `connecting` — a cold start counts: the
   * first handshake is a gap too. True with no timer armed only before the first
   * event, which arms it.
   */
  quiet: boolean;
}

export type DisplayEvent =
  /** A raw status from centrifuge-js. */
  | {kind: 'raw'; status: RealtimeStatus}
  /** The outage timer ran out. */
  | {kind: 'grace-expired'}
  /** The quiet timer ran out: the gap is long enough to be announced. */
  | {kind: 'quiet-expired'}
  /** Foreground return or an explicit request to check the socket. */
  | {kind: 'resume'}
  /** The socket ended and nothing will reopen it: an outage now, not a gap. */
  | {kind: 'terminal'};

export type DisplayAction =
  | {kind: 'arm'}
  | {kind: 'cancel'}
  | {kind: 'arm-quiet'}
  | {kind: 'cancel-quiet'};

export interface DisplayStep {
  state: DisplayState;
  actions: DisplayAction[];
}

export function initialDisplayState(): DisplayState {
  return {shown: CONNECTING, graceArmed: false, quiet: true};
}

/**
 * What the band may say. `connected` means NOTHING — either there is no gap, or the
 * gap is younger than `CONNECTING_BAND_DELAY_MS`. (The band is silent when connected,
 * so the quiet state has no sentence of its own to name.)
 */
export function bandOf(state: DisplayState): RealtimeStatus {
  return state.shown === CONNECTING && state.quiet ? CONNECTED : state.shown;
}

/** 띠가 말없이 서 있는가 — `bandOf` 의 `connected`. 호출하는 쪽이 낱말을 되풀이하지 않게 한다(문구 장부). */
export function bandIsSilent(band: RealtimeStatus): boolean {
  return band === CONNECTED;
}

export function displayStep(
  state: DisplayState,
  event: DisplayEvent,
): DisplayStep {
  switch (event.kind) {
    case 'raw': {
      if (event.status === CONNECTED) {
        const actions: DisplayAction[] = [];
        if (state.graceArmed) actions.push({kind: 'cancel'});
        if (state.quiet) actions.push({kind: 'cancel-quiet'});
        return {
          state: {shown: CONNECTED, graceArmed: false, quiet: false},
          actions,
        };
      }
      if (state.shown === DISCONNECTED || state.graceArmed) {
        return {state, actions: []};
      }
      // A gap starts. Both clocks run from here; the band is silent until the
      // quiet one runs out.
      return {
        state: {shown: CONNECTING, graceArmed: true, quiet: true},
        actions: [{kind: 'arm'}, {kind: 'arm-quiet'}],
      };
    }

    case 'grace-expired': {
      if (!state.graceArmed) {
        return {state, actions: []};
      }
      return {
        state: {shown: DISCONNECTED, graceArmed: false, quiet: false},
        actions: state.quiet ? [{kind: 'cancel-quiet'}] : [],
      };
    }

    case 'quiet-expired': {
      if (!state.quiet) {
        return {state, actions: []};
      }
      return {state: {...state, quiet: false}, actions: []};
    }

    case 'resume': {
      // Always a FRESH grace: the old timer may have been due for minutes while
      // iOS held the app suspended, and letting it fire on wake would report an
      // outage the reconnect has not yet had a chance to heal.
      const actions: DisplayAction[] = state.graceArmed
        ? [{kind: 'cancel'}, {kind: 'arm'}]
        : [{kind: 'arm'}];
      // The band follows what it was already doing. A silent band (nothing wrong,
      // or a gap still inside its first second) stays silent and gets a fresh
      // second: a return that heals at once leaves no trace. A band that is up —
      // 「연결이 끊겼습니다」, or a 「연결 중…」 that has outlived its second — stays up
      // and switches to 「연결 중…」 now, which is also the answer to the person
      // tapping 「지금 다시 연결」: the tap must visibly do something.
      const silent =
        state.shown === CONNECTED || (state.shown === CONNECTING && state.quiet);
      if (silent) actions.push({kind: 'arm-quiet'});
      return {
        state: {shown: CONNECTING, graceArmed: true, quiet: silent},
        actions,
      };
    }

    case 'terminal': {
      const actions: DisplayAction[] = [];
      if (state.graceArmed) actions.push({kind: 'cancel'});
      if (state.quiet) actions.push({kind: 'cancel-quiet'});
      return {
        state: {shown: DISCONNECTED, graceArmed: false, quiet: false},
        actions,
      };
    }

    default:
      return {state, actions: []};
  }
}

export interface ConnectionDisplay {
  push(event: DisplayEvent): void;
  /** What readers of the socket's status see (`shown`). */
  current(): RealtimeStatus;
  /** What the band may say; `connected` is silence (`bandOf`). */
  band(): RealtimeStatus;
  dispose(): void;
}

/**
 * Drive `displayStep` with two real timers. `onChange` reports every change of
 * `shown` (and only changes — a reader re-rendering on an unchanged label is
 * waste); `onBand` reports every change of what the band may say.
 */
export function createConnectionDisplay(
  onChange: (status: RealtimeStatus) => void,
  graceMs: number = DISPLAY_GRACE_MS,
  onBand?: (band: RealtimeStatus) => void,
  quietMs: number = CONNECTING_BAND_DELAY_MS,
): ConnectionDisplay {
  let state = initialDisplayState();
  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  let quietTimer: ReturnType<typeof setTimeout> | null = null;

  function clearGrace(): void {
    if (graceTimer !== null) {
      clearTimeout(graceTimer);
      graceTimer = null;
    }
  }

  function clearQuiet(): void {
    if (quietTimer !== null) {
      clearTimeout(quietTimer);
      quietTimer = null;
    }
  }

  function push(event: DisplayEvent): void {
    const shownBefore = state.shown;
    const bandBefore = bandOf(state);
    const step = displayStep(state, event);
    state = step.state;
    for (const action of step.actions) {
      switch (action.kind) {
        case 'cancel':
          clearGrace();
          break;
        case 'arm':
          clearGrace();
          graceTimer = setTimeout(() => {
            graceTimer = null;
            push({kind: 'grace-expired'});
          }, graceMs);
          break;
        case 'cancel-quiet':
          clearQuiet();
          break;
        case 'arm-quiet':
          clearQuiet();
          quietTimer = setTimeout(() => {
            quietTimer = null;
            push({kind: 'quiet-expired'});
          }, quietMs);
          break;
        default:
          break;
      }
    }
    if (state.shown !== shownBefore) onChange(state.shown);
    const bandAfter = bandOf(state);
    if (bandAfter !== bandBefore) onBand?.(bandAfter);
  }

  return {
    push,
    current: () => state.shown,
    band: () => bandOf(state),
    dispose: () => {
      clearGrace();
      clearQuiet();
    },
  };
}

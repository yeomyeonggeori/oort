import type {RealtimeStatus} from '@momo/core/lib/realtimeEvents';
import {DISPLAY_GRACE_MS} from '@momo/core/features/connection/thresholds';

// 상태 낱말은 여기 한 곳에서만 적는다(문구 장부는 영어 낱말 리터럴도 센다 — 같은 낱말을 파일 곳곳에 되풀이하면 장부가 는다).
const CONNECTED: RealtimeStatus = 'connected';
const CONNECTING: RealtimeStatus = 'connecting';
const DISCONNECTED: RealtimeStatus = 'disconnected';

// =============================================================================
// 소켓을 **읽는 쪽**이 보는 상태(`shown`) — 띠가 아니다 (#2751, #4783).
//
// centrifuge-js 는 재연결이 시작되는 순간마다 보고한다. 폰에서는 그것이 늘 있는 일이고 대개 해롭지 않다: Wi-Fi/셀룰러
// 전환, `force-reconnect`, 늦게 온 서버 핑 — 하나같이 1~2초 안에 스스로 낫는 틈이다. 이 클라이언트의 첫 판은 그 모두를
// 「연결이 끊겼습니다」로 바꿨다(한 번 붙은 소켓이 `connected` 가 아니면 곧바로 끊김으로 보고했다).
//
// ## 시계 하나: `DISPLAY_GRACE_MS`(10초)
//
// 틈이 시작된 때부터 센다. `shown` 은 이 시간이 다할 때까지 `connecting`, 그 뒤에야 `disconnected` 다. 재시도 이벤트는
// 시계를 다시 시작하지 않는다. 앞으로 돌아온 앱은 새 마감을 하나 받는다(멈춰 있던 시간은 포그라운드에서 복구한 시간이
// 아니다). 끝난 소켓(서버가 「다시 연결하지 마라」 했다, #4895)은 기다릴 틈이 없으니 곧바로 끊김이다.
//
// ## 말하는 것은 이 파일이 아니다 (#5222, #5201 S-D)
//
// 사람에게 문장을 말하는 일 — 첫 1초 침묵(#4949), 「연결 중」, 「끊김」의 원인, 기기 오프라인·서버에 닿지 못함,
// 「다시 연결됐어요」, 셸 띠 — 은 코어 연결 상태 모델(`@momo/core/features/connection`)이 하고, 폰의
// `ConnectionProvider`(`features/connection/`)가 이 소켓의 사건을 그 모델에 먹인다. 이 파일은 그 일을 하지 않는다:
// **「소켓이 살아 있는가」를 묻는 쪽**(레일·프레즌스·타임라인의 「신선도」 판단)이 읽는 `shown` 하나만 만든다. 두 시계가
// 같은 숫자(코어 `thresholds.ts`)를 읽지만 하나는 신선도, 하나는 문장이라 따로 둔다.
//
//   DISPLAY_GRACE_MS   한 틈이 `connecting` 으로 읽히다가 끊김으로 불리는 때(10초)
export {DISPLAY_GRACE_MS};

export interface DisplayState {
  /** What readers see: `connecting` until the outage deadline, then `disconnected`. */
  shown: RealtimeStatus;
  /** Is the outage timer running? */
  graceArmed: boolean;
}

export type DisplayEvent =
  /** A raw status from centrifuge-js. */
  | {kind: 'raw'; status: RealtimeStatus}
  /** The outage timer ran out. */
  | {kind: 'grace-expired'}
  /** Foreground return or an explicit request to check the socket. */
  | {kind: 'resume'}
  /** The socket ended and nothing will reopen it: an outage now, not a gap. */
  | {kind: 'terminal'};

export type DisplayAction = {kind: 'arm'} | {kind: 'cancel'};

export interface DisplayStep {
  state: DisplayState;
  actions: DisplayAction[];
}

export function initialDisplayState(): DisplayState {
  return {shown: CONNECTING, graceArmed: false};
}

export function displayStep(
  state: DisplayState,
  event: DisplayEvent,
): DisplayStep {
  switch (event.kind) {
    case 'raw': {
      if (event.status === CONNECTED) {
        return {
          state: {shown: CONNECTED, graceArmed: false},
          actions: state.graceArmed ? [{kind: 'cancel'}] : [],
        };
      }
      if (state.shown === DISCONNECTED || state.graceArmed) {
        return {state, actions: []};
      }
      // A gap starts. The outage clock runs from here.
      return {
        state: {shown: CONNECTING, graceArmed: true},
        actions: [{kind: 'arm'}],
      };
    }

    case 'grace-expired': {
      if (!state.graceArmed) {
        return {state, actions: []};
      }
      return {
        state: {shown: DISCONNECTED, graceArmed: false},
        actions: [],
      };
    }

    case 'resume': {
      // Always a FRESH grace: the old timer may have been due for minutes while
      // iOS held the app suspended, and letting it fire on wake would report an
      // outage the reconnect has not yet had a chance to heal.
      return {
        state: {shown: CONNECTING, graceArmed: true},
        actions: state.graceArmed
          ? [{kind: 'cancel'}, {kind: 'arm'}]
          : [{kind: 'arm'}],
      };
    }

    case 'terminal': {
      return {
        state: {shown: DISCONNECTED, graceArmed: false},
        actions: state.graceArmed ? [{kind: 'cancel'}] : [],
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
  dispose(): void;
}

/**
 * Drive `displayStep` with one real timer. `onChange` reports every change of
 * `shown` (and only changes — a reader re-rendering on an unchanged label is
 * waste).
 */
export function createConnectionDisplay(
  onChange: (status: RealtimeStatus) => void,
  graceMs: number = DISPLAY_GRACE_MS,
): ConnectionDisplay {
  let state = initialDisplayState();
  let graceTimer: ReturnType<typeof setTimeout> | null = null;

  function clearGrace(): void {
    if (graceTimer !== null) {
      clearTimeout(graceTimer);
      graceTimer = null;
    }
  }

  function push(event: DisplayEvent): void {
    const shownBefore = state.shown;
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
        default:
          break;
      }
    }
    if (state.shown !== shownBefore) onChange(state.shown);
  }

  return {
    push,
    current: () => state.shown,
    dispose: clearGrace,
  };
}

import type { RestOutcome } from "../../lib/http";
import type { RealtimeStatus } from "../../lib/realtimeEvents";
import {
  deriveConnectionState,
  foldConnectionEvent,
  initialConnectionInput,
  type ConnectionEvent,
  type ConnectionInput,
  type ConnectionView,
} from "./model";
import { INITIAL_REST_SIGNAL } from "./restSignal";
import { openingSocketGap } from "./socketGap";
import { CONNECTING_BAND_DELAY_MS, RECOVERED_FLASH_MS } from "./thresholds";

// =============================================================================
// 화면이 연결 상태 모델을 돌리는 데 필요한 순수한 나머지 (#5220, #5201 S-B).
//
// 코어 모델(`model.ts`)은 입력 → 모습을 순수하게 계산한다. 이 파일은 그 위에 화면(웹·폰 공통)이 더 필요로
// 하는 것만 얹는다. 전부 순수하고 시계는 사건에 찍힌 시각(`at`)뿐이다(타이머·구독·저장 없음).
//
//   1. 사건을 접고 **그 시각에** 다시 판정한다. `Date.now()`를 렌더에서 읽지 않으므로 낡은 `now`로 타이머를
//      거는 일이 없다(S-A 인계 스니펫의 `useState(Date.now)` 방식은 사건이 일어난 시각과 마지막 타이머가
//      돈 시각이 벌어지면 다음 판정을 그만큼 늦게 깨운다).
//   2. 「다시 연결됐어요」: **「끊김」이 화면에 섰던 경우에만** 정상으로 돌아올 때 2초(감사 문서 §4 원칙 7).
//      「연결 중」만 보였거나 침묵이던 틈은 말없이 사라진다.
//   3. 카드와 띠 중 어느 쪽이 말하나(`showsConnectionCard`·`showsConnectionBanner`).
//   4. **사람이 보지 못한 끊김은 끊김이 아니다**(#5403). 앱이 뒤에 가 있는 동안(`visibility`)은 화면을 보는 사람이 없다. 그
//      시간의 판정은 「끊김이 보였다」 기억도 복구 표시도 만들지 않고, **시계가 뒤로 간 시각에서 멈춘다**(`hiddenAt`: 늦게 깨어난 시계가 오래된
//      틈을 「끊김」으로 읽어도, 앱이 앞에 온 순간 앱 상태 알림이 오기까지 낡은 띠가 그려지지 않는다 - 시뮬레이터 실측). 돌아온 순간 소켓이 붙어
//      있지 않으면 틈을 **새 침묵**으로 다시 시작한다(뒤에서 보낸 시간은 복구에 쓴 시간이 아니다). 복구 표시는 읽는 쪽이 시각을 건네면 깨움
//      없이도 거둔다(`isRecovered(state, now)`): 깨움이 늦거나 사라져도 보내기 같은 다음 사건을 기다리지 않는다.
//
// 화면이 읽는 것은 `view`와 `isRecovered`뿐이다. 보이는 것이 달라지지 않은 사건(대부분의 REST 응답)은 이전 상태
// 객체를 그대로 돌려줘서, 이 값을 읽는 소비자가 응답 한 건마다 다시 그려지지 않는다.
// =============================================================================

export interface ConnectionState {
  readonly input: ConnectionInput;
  readonly view: ConnectionView;
  /** 「끊김」이 화면에 선 적이 있고 아직 정상으로 돌아오지 않았다. */
  readonly sawDown: boolean;
  /** 「다시 연결됐어요」가 이 시각(epoch ms)까지 선다. 서 있지 않으면 null. */
  readonly recoveredUntil: number | null;
  /**
   * 앱이 뒤로 간 시각(epoch ms). 앞에 있으면 null이고, 알리지 않는 호출자(웹)는 늘 null이다(#5403). 뒤에 있는 동안은 화면을 보는 사람이 없어서 판정의
   * 시계가 이 시각에서 멈춘다: 늦게 깨어난 시계가 「틈이 오래됐다」로 읽어도 모습은 뒤로 가던 순간 그대로다(앱이 앞에 오는 순간 화면은 이미 보이는데 앱
   * 상태 알림은 한 박자 늦게 온다 - 그 사이에 낡은 「끊김」이 그려지지 않게).
   */
  readonly hiddenAt: number | null;
}

export type ConnectionAction =
  | { readonly kind: "event"; readonly at: number; readonly event: ConnectionEvent }
  /** 시간이 흘러 판정이 달라질 때(`quiet`→`connecting`→`down`, 복구 표시 끝)의 재판정. */
  | { readonly kind: "tick"; readonly at: number }
  /** 앱이 뒤로 갔다(`visible: false`)/앞으로 돌아왔다(`visible: true`). 화면을 보는 사람이 없던 시간은 끊김을 본 시간이 아니다(#5403). */
  | { readonly kind: "visibility"; readonly at: number; readonly visible: boolean };

// 사건·행동의 생성자. 화면 코드가 `kind` 문자열을 손으로 적지 않게 한다(오타가 컴파일에서 막히고, 웹의 직접
// 문구 장부에 기술 낱말이 쌓이지 않는다).
export const socketEvent = (at: number, status: RealtimeStatus): ConnectionEvent => ({ kind: "socket", at, status });
/** 소켓이 끝났고 아무도 다시 열지 않는다(폰: 서버가 「다시 연결하지 마라」 했다, #4895). 기다릴 틈이 없이 곧바로 끊김이다. */
export const endedSocketEvent = (at: number): ConnectionEvent => ({ kind: "socket", at, status: "disconnected", ended: true });
export const resumeEvent = (at: number): ConnectionEvent => ({ kind: "resume", at });
export const deviceEvent = (at: number, online: boolean | null): ConnectionEvent => ({ kind: "device", at, online });
export const restEvent = (outcome: RestOutcome): ConnectionEvent => ({ kind: "rest", outcome });
export const sessionEvent = (expired: boolean): ConnectionEvent => ({ kind: "session", expired });
export const eventAction = (at: number, event: ConnectionEvent): ConnectionAction => ({ kind: "event", at, event });
export const tickAction = (at: number): ConnectionAction => ({ kind: "tick", at });
export const visibilityAction = (at: number, visible: boolean): ConnectionAction => ({ kind: "visibility", at, visible });

function evaluate(
  input: ConnectionInput,
  at: number,
  sawDown: boolean,
  recoveredUntil: number | null,
  hiddenAt: number | null
): ConnectionState {
  // 뒤에 있는 동안은 시계가 멈춘다: 뒤로 간 시각 이후로 흐른 시간은 아무도 보지 않았다.
  const view = deriveConnectionState(input, hiddenAt === null ? at : Math.min(at, hiddenAt));
  // 아무도 보지 않는 동안의 판정은 「끊김이 보였다」가 아니다. 기억도 복구 표시도 만들지 않는다.
  if (hiddenAt !== null) return { input, view, sawDown: false, recoveredUntil: null, hiddenAt };
  let nextSawDown = sawDown;
  let until = recoveredUntil !== null && at < recoveredUntil ? recoveredUntil : null;
  switch (view.phase) {
    case "down":
      nextSawDown = true;
      until = null;
      break;
    case "ok":
      if (nextSawDown) {
        nextSawDown = false;
        until = at + RECOVERED_FLASH_MS;
      }
      break;
    case "connecting":
      // 새 틈이 말을 시작했다. 방금의 복구 표시는 낡았고, 「끊김이 보였다」는 기억은 정상이 될 때까지 간다.
      until = null;
      break;
    case "expired":
      nextSawDown = false;
      until = null;
      break;
    case "quiet":
      break;
  }
  return { input, view, sawDown: nextSawDown, recoveredUntil: until, hiddenAt };
}

export function initialConnectionState(at: number, deviceOnline: boolean | null): ConnectionState {
  return evaluate(initialConnectionInput(at, deviceOnline), at, false, null, null);
}

/** 화면에 보이는 것이 같은가. 시각(`nextChangeAt`)도 보이는 것의 일부다: 같으면 타이머를 다시 걸 일이 없다. */
function sameView(a: ConnectionView, b: ConnectionView): boolean {
  return (
    a.phase === b.phase &&
    a.cause === b.cause &&
    a.canSend === b.canSend &&
    a.canUpload === b.canUpload &&
    a.canDecide === b.canDecide &&
    a.nextChangeAt === b.nextChangeAt &&
    a.copy?.title === b.copy?.title &&
    a.copy?.detail === b.copy?.detail &&
    a.composerNote === b.composerNote &&
    a.approvalNote === b.approvalNote &&
    a.action?.kind === b.action?.kind
  );
}

/** 같은 상태인가: 바뀌지 않았으면 이전 객체를 그대로 돌려줘 소비자가 다시 그려지지 않게 한다. */
function keepIfSame(state: ConnectionState, next: ConnectionState): ConnectionState {
  return next.input === state.input &&
    next.sawDown === state.sawDown &&
    next.recoveredUntil === state.recoveredUntil &&
    next.hiddenAt === state.hiddenAt &&
    sameView(next.view, state.view)
    ? state
    : next;
}

/**
 * 앞으로 돌아온 사람에게 소켓 틈은 **지금 시작한** 틈이다. 붙어 있지 않은 틈(끝난 소켓은 빼고: 아무도 다시 열지 않으니
 * 기다릴 틈이 없다)은 새 침묵 1초로 다시 시작한다. 이미 붙어 있으면 건드릴 것이 없다.
 */
function restartedForReturn(input: ConnectionInput, at: number): ConnectionInput {
  const socket = input.socket;
  if (socket.status === "connected" || socket.open === null || socket.ended) return input;
  return { ...input, socket: { ...socket, open: openingSocketGap(at).open } };
}

export function reduceConnection(state: ConnectionState, action: ConnectionAction): ConnectionState {
  if (action.kind === "visibility") {
    if (!action.visible) {
      // 사람이 앱을 떠났다. 이 시각부터의 판정은 아무도 보지 않고 시계는 여기서 멈춘다(이미 뒤에 있었다면 처음 떠난 시각이 이어진다).
      return keepIfSame(state, evaluate(state.input, action.at, false, null, state.hiddenAt ?? action.at));
    }
    if (state.hiddenAt === null) {
      // 뒤로 간 적이 없다(알림 센터를 당긴 정도): 아무것도 다시 시작하지 않고 시각만 따라간다.
      return keepIfSame(state, evaluate(state.input, action.at, state.sawDown, state.recoveredUntil, null));
    }
    // 돌아왔다: 새 시작이다. 뒤에서 본 적 없는 끊김 기억·복구 표시는 이미 비어 있고, 틈은 새 침묵으로 시작한다.
    return keepIfSame(state, evaluate(restartedForReturn(state.input, action.at), action.at, false, null, null));
  }
  const input = action.kind === "event" ? foldConnectionEvent(state.input, action.event) : state.input;
  return keepIfSame(state, evaluate(input, action.at, state.sawDown, state.recoveredUntil, state.hiddenAt));
}

/**
 * 「다시 연결됐어요」를 지금 그려야 하나. 새 틈이 말을 시작했거나 끊겼으면 그 모습이 이긴다.
 *
 * `now` 를 건네면(epoch ms) 깨움이 늦었거나 사라져도 표시가 끝난 시각 이후에는 거둔다. 상태 객체는 깨움이 와야 바뀌므로, 시각을
 * 모르는 읽기는 낡은 상태를 영원히 참으로 읽을 수 있다(보내기 같은 다음 사건이 와야 지는 옛 모양, #5403). 건네지 않으면 예전과
 * 같다(웹이 그대로 쓰는 호출).
 */
export function isRecovered(state: ConnectionState, now?: number): boolean {
  if (state.recoveredUntil === null) return false;
  if (now !== undefined && now >= state.recoveredUntil) return false;
  return state.view.phase === "ok" || state.view.phase === "quiet";
}

/** 다음에 판정을 다시 해야 하는 시각(epoch ms). 시간으로 바뀔 일이 없으면 null. */
export function nextWakeAt(state: ConnectionState): number | null {
  const wakes = [state.view.nextChangeAt, state.recoveredUntil].filter(
    (value): value is number => value !== null
  );
  return wakes.length === 0 ? null : Math.min(...wakes);
}

/**
 * 모델을 돌리는 공급자가 없는 곳(시험, 셸 밖)이 읽는 모습: 소켓 상태 하나와 기기 온라인만으로 같은 모델을 한 번
 * 돌린다. REST 입력이 없을 뿐 규칙은 같다. 소켓이 붙어 있지 않으면 **이미 오래전에 시작한 틈**으로 읽어, 기다림
 * 없이 곧바로 「실시간만 끊김」(보내기는 열려 있다)이 된다. 기기 오프라인이면 막힌다.
 */
export function viewWithoutRest(status: RealtimeStatus, deviceOnline: boolean, now: number): ConnectionView {
  return deriveConnectionState(
    {
      deviceOnline,
      socket: foldedSocket(status),
      rest: INITIAL_REST_SIGNAL,
      sessionExpired: false,
    },
    now
  );
}

function foldedSocket(status: RealtimeStatus): ConnectionInput["socket"] {
  const open = { since: 0, quietUntil: CONNECTING_BAND_DELAY_MS, connectedAt: null };
  return { status, open: isConnected(status) ? null : open, ended: false };
}

function isConnected(status: RealtimeStatus): boolean {
  return status === "connected";
}

// ---- 카드냐 띠냐 -------------------------------------------------------------
// 연결 카드(사이드바 아래)와 띠(위쪽)는 **한 자리에서만** 말한다(감사 문서 §4 원칙 3). 목록 열이 보이면 카드,
// 폰 폭의 서랍이거나 목록 열이 접혔으면 띠다. 둘이 겹치거나 둘 다 비는 폭이 없도록 한 레이아웃 입력에서
// 두 답이 서로의 여집합으로 나온다.

export interface ConnectionLayout {
  /** 사이드바가 서랍으로 서는 폭(폰 폭). */
  readonly asDrawer: boolean;
  /** 목록 열이 접혀 있다(⌘B·좁은 창의 자동 접힘). */
  readonly listCollapsed: boolean;
}

export function showsConnectionCard(layout: ConnectionLayout): boolean {
  return !layout.asDrawer && !layout.listCollapsed;
}

export function showsConnectionBanner(layout: ConnectionLayout): boolean {
  return !showsConnectionCard(layout);
}

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
}

export type ConnectionAction =
  | { readonly kind: "event"; readonly at: number; readonly event: ConnectionEvent }
  /** 시간이 흘러 판정이 달라질 때(`quiet`→`connecting`→`down`, 복구 표시 끝)의 재판정. */
  | { readonly kind: "tick"; readonly at: number };

// 사건·행동의 생성자. 화면 코드가 `kind` 문자열을 손으로 적지 않게 한다(오타가 컴파일에서 막히고, 웹의 직접
// 문구 장부에 기술 낱말이 쌓이지 않는다).
export const socketEvent = (at: number, status: RealtimeStatus): ConnectionEvent => ({ kind: "socket", at, status });
export const resumeEvent = (at: number): ConnectionEvent => ({ kind: "resume", at });
export const deviceEvent = (at: number, online: boolean | null): ConnectionEvent => ({ kind: "device", at, online });
export const restEvent = (outcome: RestOutcome): ConnectionEvent => ({ kind: "rest", outcome });
export const sessionEvent = (expired: boolean): ConnectionEvent => ({ kind: "session", expired });
export const eventAction = (at: number, event: ConnectionEvent): ConnectionAction => ({ kind: "event", at, event });
export const tickAction = (at: number): ConnectionAction => ({ kind: "tick", at });

function evaluate(
  input: ConnectionInput,
  at: number,
  sawDown: boolean,
  recoveredUntil: number | null
): ConnectionState {
  const view = deriveConnectionState(input, at);
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
  return { input, view, sawDown: nextSawDown, recoveredUntil: until };
}

export function initialConnectionState(at: number, deviceOnline: boolean | null): ConnectionState {
  return evaluate(initialConnectionInput(at, deviceOnline), at, false, null);
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

export function reduceConnection(state: ConnectionState, action: ConnectionAction): ConnectionState {
  const input = action.kind === "event" ? foldConnectionEvent(state.input, action.event) : state.input;
  const next = evaluate(input, action.at, state.sawDown, state.recoveredUntil);
  return next.input === state.input &&
    next.sawDown === state.sawDown &&
    next.recoveredUntil === state.recoveredUntil &&
    sameView(next.view, state.view)
    ? state
    : next;
}

/** 「다시 연결됐어요」를 지금 그려야 하나. 새 틈이 말을 시작했거나 끊겼으면 그 모습이 이긴다. */
export function isRecovered(state: ConnectionState): boolean {
  return state.recoveredUntil !== null && (state.view.phase === "ok" || state.view.phase === "quiet");
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

import {
  type ConnectionPresentation,
  presentConnection,
} from '@momo/core/features/connection/presentation';
import {
  deviceEvent,
  eventAction,
  initialConnectionState,
  isRecovered,
  reduceConnection,
  restEvent,
  socketEvent,
  tickAction,
  type ConnectionState,
} from '@momo/core/features/connection/screenState';
import {
  CONNECTING_BAND_DELAY_MS,
  DISPLAY_GRACE_MS,
  HEALED_MS,
} from '@momo/core/features/connection/thresholds';
import type {RestOutcome} from '@momo/core/lib/http';

// =============================================================================
// 연결 띠의 장면을 **실제 코어 모델**로 짓는다 (#5222, #5201 S-D).
//
// 머리·셸 띠 시험이 문장을 손으로 적지 않고, 같은 입력(소켓 사건·기기·REST 결과)을 코어 리듀서에 먹여 나온 모습을 그린다.
// 문장이 사전에서 바뀌어도, 모델이 원인을 가르는 규칙이 바뀌어도 이 장면이 따라간다(손으로 지은 장면은 둘 다 놓친다).
// =============================================================================

const T0 = 1_700_000_000_000;
/**
 * 소켓이 붙은 지 `HEALED_MS` 를 넘겨 **틈이 완전히 풀린** 때. 이 앞에서 다시 끊기면 코어 모델은 옛 틈을 이어 센다(깜빡이는 소켓이 문턱을
 * 넘게 하는 규칙) — 그 장면은 `connectionProvider.test.tsx` 가 따로 잰다. 이 장면들은 「오래 건강하다가 끊긴」 소켓을 말한다.
 */
const HEALTHY_AT = T0 + 100 + HEALED_MS + 1_000;

/** 서로 다른 요청 셋이 응답 없이 끝난 REST 결과들 — 「서버에 닿지 못함」 선언의 입력. */
export function unreachableOutcomes(at: number): RestOutcome[] {
  return ['/channels', '/roster', '/read-state'].map(
    path =>
      ({
        kind: 'network',
        at,
        method: 'GET',
        target: `https://api.example.com/v1${path}`,
        failure: 'unreachable',
      }) as RestOutcome,
  );
}

function step(
  state: ConnectionState,
  at: number,
  events: ReturnType<typeof socketEvent>[] = [],
): ConnectionState {
  let next = state;
  for (const event of events) next = reduceConnection(next, eventAction(at, event));
  return reduceConnection(next, tickAction(at));
}

export interface BandScene {
  state: ConnectionState;
  band: ConnectionPresentation | null;
}

function scene(state: ConnectionState): BandScene {
  return {state, band: presentConnection(state.view, isRecovered(state))};
}

/** 소켓이 붙어 오래 건강하다: 아무 말도 하지 않는다. */
export function connectedScene(): BandScene {
  const start = initialConnectionState(T0, true);
  return scene(step(start, T0 + 100, [socketEvent(T0 + 100, 'connected')]));
}

/** `HEALED_MS` 를 넘겨 건강한 소켓. 이후 장면들이 여기서 출발한다. */
function healthy(): ConnectionState {
  return step(connectedScene().state, HEALTHY_AT);
}

/** 붙었던 소켓이 끊기고 1초가 안 됐다: 침묵. */
export function quietScene(): BandScene {
  const dropped = step(healthy(), HEALTHY_AT, [socketEvent(HEALTHY_AT, 'connecting')]);
  return scene(step(dropped, HEALTHY_AT + CONNECTING_BAND_DELAY_MS - 1));
}

/** 끊긴 지 1초가 넘고 10초가 안 됐다: 「연결 중…」, 단추 없음. */
export function connectingScene(): BandScene {
  const dropped = step(healthy(), HEALTHY_AT, [socketEvent(HEALTHY_AT, 'connecting')]);
  return scene(step(dropped, HEALTHY_AT + CONNECTING_BAND_DELAY_MS + 500));
}

/** 소켓이 10초 넘게 끊겼고 REST는 정상: 실시간만 끊김, 「지금 다시 연결」. */
export function realtimeDownScene(): BandScene {
  const dropped = step(healthy(), HEALTHY_AT, [socketEvent(HEALTHY_AT, 'connecting')]);
  return scene(step(dropped, HEALTHY_AT + DISPLAY_GRACE_MS + 500));
}

/** OS가 기기 오프라인을 알렸다: 즉시, 마크 정지, 단추 없음. */
export function offlineScene(): BandScene {
  return scene(
    reduceConnection(healthy(), eventAction(HEALTHY_AT + 100, deviceEvent(HEALTHY_AT + 100, false))),
  );
}

/** 서로 다른 요청 셋이 연달아 응답 없이 끝났다: 서버에 닿지 못함, 「지금 다시 연결」. */
export function serverUnreachableScene(): BandScene {
  let state = healthy();
  for (const outcome of unreachableOutcomes(HEALTHY_AT + 100)) {
    state = reduceConnection(state, eventAction(HEALTHY_AT + 100, restEvent(outcome)));
  }
  return scene(state);
}

/** 「끊김」이 섰다가 소켓이 돌아온 직후: 확인 표시 「다시 연결됐어요」. */
export function recoveredScene(): BandScene {
  const down = realtimeDownScene().state;
  const back = HEALTHY_AT + DISPLAY_GRACE_MS + 1_500;
  return scene(step(down, back, [socketEvent(back, 'connected')]));
}

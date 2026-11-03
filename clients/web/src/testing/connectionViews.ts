import {
  deviceEvent,
  eventAction,
  initialConnectionState,
  reduceConnection,
  restEvent,
  sessionEvent,
  socketEvent,
  tickAction,
  type ConnectionAction,
  type ConnectionState,
} from "@momo/core/features/connection/screenState";
import type { RestOutcome } from "@momo/core/lib/http";
import type { ConnectionContextValue } from "@/features/common/connectionContext";

// 시험용: 연결 원인별 모습 (#5239). 손으로 지은 `ConnectionView`가 아니라 **코어 모델을 사건으로 돌려** 만든다.
// 그래서 「서버에 닿지 못함」은 서로 다른 요청 3건이 연달아 실패해야 서고, 「알 수 없음」은 소켓이 10초 넘게
// 끊긴 채 응답 없는 요청이 1~2건 남아야 선다. 모델의 규칙이 바뀌면 이 모습도 따라 바뀐다.
// `ConnectionContext.Provider`에 넣으면 `useConnection()`·`useOffline()`이 이 모습을 읽는다.

export type ConnectionScene =
  | "ok"
  | "deviceOffline"
  | "serverUnreachable"
  | "unknown"
  | "realtimeDown"
  | "expired";

const T0 = 1_700_000_000_000;

function step(state: ConnectionState, ...actions: ConnectionAction[]): ConnectionState {
  return actions.reduce(reduceConnection, state);
}

function unreachable(path: string, at: number): ConnectionAction {
  const outcome: RestOutcome = {
    kind: "network",
    failure: "unreachable",
    at,
    method: "GET",
    target: `http://server.test${path}`,
  };
  return eventAction(at, restEvent(outcome));
}

/** 오래 붙어 있던 소켓(틈이 풀렸다): 평범한 첫 끊김을 다루려고 여기서 출발한다. */
function healthy(): ConnectionState {
  const start = initialConnectionState(T0, true);
  return step(start, eventAction(T0 + 100, socketEvent(T0 + 100, "connected")), tickAction(T0 + 20_000));
}

function stateFor(scene: ConnectionScene): ConnectionState {
  const base = healthy();
  const at = T0 + 21_000;
  switch (scene) {
    case "ok":
      return base;
    case "deviceOffline":
      return step(base, eventAction(at, deviceEvent(at, false)));
    case "serverUnreachable":
      return step(base, unreachable("/channels", at), unreachable("/roster", at + 100), unreachable("/read-state", at + 200));
    case "unknown":
      // 소켓이 10초 넘게 끊겼고, 응답 없는 요청이 한 건 남아 있다(선언에는 모자란다).
      return step(
        base,
        eventAction(at, socketEvent(at, "disconnected")),
        unreachable("/channels", at + 100),
        tickAction(at + 10_000)
      );
    case "realtimeDown":
      return step(base, eventAction(at, socketEvent(at, "disconnected")), tickAction(at + 10_000));
    case "expired":
      return step(base, eventAction(at, sessionEvent(true)));
  }
}

export function connectionScene(scene: ConnectionScene): ConnectionContextValue {
  return { view: stateFor(scene).view, recovered: false, reconnectNow: () => undefined };
}

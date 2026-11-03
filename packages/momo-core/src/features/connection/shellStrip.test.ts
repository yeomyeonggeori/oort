import { describe, expect, it } from "vitest";
import type { RestOutcome } from "../../lib/http";
import { CONNECTION_KEYS as K } from "./copyKeys";
import { CONNECTION_MARK, CONNECTION_TONE } from "./presentation";
import {
  deviceEvent,
  endedSocketEvent,
  eventAction,
  initialConnectionState,
  isRecovered,
  reduceConnection,
  restEvent,
  socketEvent,
  tickAction,
  type ConnectionAction,
  type ConnectionState,
} from "./screenState";
import { nextShellStood, presentShellStrip, shellSpeaksFor } from "./shellStrip";

// 폰 셸 띠(홈·받은함·에이전트 목록 위): 기기 오프라인과 서버에 닿지 못함만 말한다. 실시간(소켓)만 끊긴 것은 대화 화면 띠의 몫이다
// (#5222, #5201 결정 ②). 숫자는 상수가 아니라 글자 그대로(1_000, 10_000, 2_000) 단정한다.

const T0 = 1_700_000_000_000;

function step(state: ConnectionState, ...actions: ConnectionAction[]): ConnectionState {
  return actions.reduce(reduceConnection, state);
}

const socket = (at: number, status: "connected" | "connecting" | "disconnected") =>
  eventAction(at, socketEvent(at, status));
const device = (at: number, online: boolean) => eventAction(at, deviceEvent(at, online));

function failure(path: string, at: number): ConnectionAction {
  const outcome: RestOutcome = {
    kind: "network",
    failure: "unreachable",
    at,
    method: "GET",
    target: `http://server.test${path}`,
  };
  return eventAction(at, restEvent(outcome));
}

/** 오래 붙어 있던 소켓(틈이 풀려 있다): 평범한 첫 끊김을 다루려고 여기서 출발한다. */
function healthy(): ConnectionState {
  const start = initialConnectionState(T0, true);
  return step(start, socket(T0 + 100, "connected"), tickAction(T0 + 20_000));
}

const speaks = (state: ConnectionState) => shellSpeaksFor(state.view);
const strip = (state: ConnectionState, stood: boolean) =>
  presentShellStrip(state.view, isRecovered(state), stood);

describe("셸 띠가 말하는 원인", () => {
  it("기기 오프라인은 곧바로 말한다: 오프라인이에요, 마크는 멈춰 있고 단추가 없다", () => {
    const state = step(healthy(), device(T0 + 21_000, false));
    expect(speaks(state)).toBe(true);
    const shown = strip(state, false);
    expect(shown).toMatchObject({
      tone: CONNECTION_TONE.offline,
      title: K.offlineTitle,
      detail: K.offlineDetail,
      mark: CONNECTION_MARK.still,
      canReconnect: false,
    });
  });

  it("서버에 닿지 못함: 서로 다른 요청 셋이 연달아 실패하면 말한다. 단추가 있고 마크가 돈다", () => {
    const state = step(
      healthy(),
      failure("/channels", T0 + 21_000),
      failure("/roster", T0 + 21_100),
      failure("/read-state", T0 + 21_200)
    );
    expect(speaks(state)).toBe(true);
    expect(strip(state, false)).toMatchObject({
      tone: CONNECTION_TONE.unreachable,
      title: K.serverUnreachableTitle,
      detail: K.serverUnreachableDetail,
      mark: CONNECTION_MARK.moving,
      canReconnect: true,
    });
  });

  it("실시간만 끊김은 말하지 않는다: 소켓이 10초 넘게 끊겨도 REST가 정상이면 셸 띠는 없다", () => {
    const dropped = step(healthy(), socket(T0 + 21_000, "connecting"));
    for (const at of [T0 + 21_500, T0 + 23_000, T0 + 30_999, T0 + 31_001, T0 + 60_000]) {
      const state = step(dropped, tickAction(at));
      expect(speaks(state)).toBe(false);
      expect(strip(state, false)).toBeNull();
    }
    // 같은 시각에 대화 화면 띠는 분명히 말한다: 이 부품이 침묵하는 것은 규칙이지 모델이 말할 것이 없어서가 아니다.
    const long = step(dropped, tickAction(T0 + 31_001));
    expect(long.view.phase).toBe("down");
    expect(long.view.cause).toBe("realtimeDown");
  });

  it("끝난 소켓(서버가 다시 연결하지 말라 했다)도 실시간 문제다: 셸은 말하지 않는다", () => {
    const state = step(healthy(), eventAction(T0 + 21_000, endedSocketEvent(T0 + 21_000)));
    expect(state.view.cause).toBe("realtimeDown");
    expect(speaks(state)).toBe(false);
    expect(strip(state, false)).toBeNull();
  });

  it("알 수 없음(소켓이 끊기고 응답 없는 요청이 1~2건)도 셸이 말하지 않는다 - 증거가 모자란 것을 셸에 올리지 않는다", () => {
    const state = step(
      healthy(),
      socket(T0 + 21_000, "connecting"),
      failure("/channels", T0 + 22_000),
      tickAction(T0 + 32_000)
    );
    expect(state.view.cause).toBe("unknown");
    expect(speaks(state)).toBe(false);
  });

  it("침묵·연결 중·정상에서는 말할 것이 없다", () => {
    expect(strip(healthy(), false)).toBeNull();
    const quiet = step(healthy(), socket(T0 + 21_000, "connecting"));
    expect(strip(quiet, false)).toBeNull();
    const connecting = step(quiet, tickAction(T0 + 22_500));
    expect(connecting.view.phase).toBe("connecting");
    expect(strip(connecting, false)).toBeNull();
  });
});

describe("셸 띠의 복구 표시는 띠가 섰던 경우에만", () => {
  it("섰던 띠가 걷히면 2초 「다시 연결됐어요」 확인 표시가 남는다", () => {
    let stood = false;
    let state = healthy();
    // 기기 오프라인 → 띠가 선다.
    state = step(state, device(T0 + 21_000, false));
    stood = nextShellStood(state.view, isRecovered(state), stood);
    expect(stood).toBe(true);
    // 기기가 돌아온다: 소켓은 아직 붙기 전이라 띠는 잠시 비고(침묵), 기억은 이어진다.
    state = step(state, device(T0 + 25_000, true));
    stood = nextShellStood(state.view, isRecovered(state), stood);
    expect(strip(state, stood)).toBeNull();
    expect(stood).toBe(true);
    // 소켓이 붙는다: 복구 표시가 선다.
    state = step(state, socket(T0 + 26_000, "connected"));
    stood = nextShellStood(state.view, isRecovered(state), stood);
    expect(state.view.phase).toBe("ok");
    expect(isRecovered(state)).toBe(true);
    expect(strip(state, stood)).toMatchObject({
      tone: CONNECTION_TONE.recovered,
      title: K.recovered,
      mark: CONNECTION_MARK.check,
      canReconnect: false,
    });
    // 2초 뒤 걷히고 기억도 잊는다.
    state = step(state, tickAction(T0 + 28_001));
    stood = nextShellStood(state.view, isRecovered(state), stood);
    expect(strip(state, stood)).toBeNull();
    expect(stood).toBe(false);
  });

  it("실시간만 끊겼다 돌아온 것은 셸이 알리지 않는다: 끊김을 말한 적이 없는데 돌아왔다고만 말하는 꼴이 된다", () => {
    let stood = false;
    let state = step(healthy(), socket(T0 + 21_000, "connecting"), tickAction(T0 + 32_000));
    stood = nextShellStood(state.view, isRecovered(state), stood);
    expect(state.view.cause).toBe("realtimeDown");
    expect(stood).toBe(false);
    state = step(state, socket(T0 + 33_000, "connected"));
    stood = nextShellStood(state.view, isRecovered(state), stood);
    // 대화 화면 띠는 2초 확인 표시를 보이지만(모델이 「끊김」을 봤다), 셸은 섰던 적이 없다.
    expect(isRecovered(state)).toBe(true);
    expect(strip(state, stood)).toBeNull();
  });

  it("기억은 틈이 가라앉기 전(침묵·연결 중·복구 표시 2초)에는 지워지지 않는다", () => {
    const offline = step(healthy(), device(T0 + 21_000, false));
    expect(nextShellStood(offline.view, false, false)).toBe(true);
    const quiet = step(offline, device(T0 + 22_000, true), socket(T0 + 22_000, "connecting"));
    expect(quiet.view.phase).toBe("quiet");
    expect(nextShellStood(quiet.view, false, true)).toBe(true);
    const connecting = step(quiet, tickAction(T0 + 23_500));
    expect(connecting.view.phase).toBe("connecting");
    expect(nextShellStood(connecting.view, false, true)).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import type { RestOutcome } from "../../lib/http";
import { CONNECTION_KEYS as K } from "./copyKeys";
import { CONNECTION_MARK, CONNECTION_TONE, presentConnection } from "./presentation";
import {
  deviceEvent,
  eventAction,
  initialConnectionState,
  isRecovered,
  nextWakeAt,
  reduceConnection,
  restEvent,
  resumeEvent,
  sessionEvent,
  showsConnectionBanner,
  showsConnectionCard,
  socketEvent,
  tickAction,
  viewWithoutRest,
  type ConnectionAction,
  type ConnectionState,
} from "./screenState";

// 숫자는 상수가 아니라 글자 그대로(1_000, 10_000, 2_000) 단정한다. 상수를 바꿔 문턱을 깨뜨렸을 때 단정이 같이
// 움직여 초록으로 남는 일이 없게 하려는 것이다.

const T0 = 1_700_000_000_000;

function step(state: ConnectionState, ...actions: ConnectionAction[]): ConnectionState {
  return actions.reduce(reduceConnection, state);
}

const socket = (at: number, status: "connected" | "connecting" | "disconnected") =>
  eventAction(at, socketEvent(at, status));
const device = (at: number, online: boolean) => eventAction(at, deviceEvent(at, online));
const resume = (at: number) => eventAction(at, resumeEvent(at));
const tick = (at: number) => tickAction(at);

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

function success(path: string, at: number): ConnectionAction {
  const outcome: RestOutcome = { kind: "response", status: 200, at, method: "GET", target: `http://server.test${path}` };
  return eventAction(at, restEvent(outcome));
}

/**
 * 소켓이 **오래 붙어 있던** 건강한 상태(틈이 풀려 있다). 막 붙은 소켓은 5초를 붙어 있어야 틈이 풀린다
 * (`HEALED_MS`): 그 안에 또 끊기면 처음 시작한 틈의 시계가 이어진다. 이 시험들은 그 깜빡임 규칙이 아니라
 * 평범한 첫 끊김을 다루므로, 한 번 붙은 지 오래된 소켓에서 시작한다.
 */
function healthy(at = T0): ConnectionState {
  const start = at - 60_000;
  return step(initialConnectionState(start, true), socket(start, "connected"));
}

describe("「끊김」이 보였던 경우에만 2초 「다시 연결됐어요」 (감사 문서 §4 원칙 7)", () => {
  it("실시간만 끊겼다가(10초 넘게) 다시 붙으면 정상이 되는 순간부터 정확히 2초 선다", () => {
    let state = step(healthy(), socket(T0 + 1_000, "disconnected"), tick(T0 + 11_000));
    expect(state.view.phase).toBe("down");
    expect(isRecovered(state)).toBe(false);

    state = step(state, socket(T0 + 20_000, "connected"));
    expect(state.view.phase).toBe("ok");
    expect(isRecovered(state)).toBe(true);
    expect(state.recoveredUntil).toBe(T0 + 22_000);

    state = step(state, tick(T0 + 21_999));
    expect(isRecovered(state)).toBe(true);
    state = step(state, tick(T0 + 22_000));
    expect(isRecovered(state)).toBe(false);
    expect(state.recoveredUntil).toBeNull();
  });

  it("「연결 중」까지만 보였다가(10초 안) 붙으면 말없이 사라진다", () => {
    let state = step(healthy(), socket(T0 + 1_000, "disconnected"), tick(T0 + 2_500));
    expect(state.view.phase).toBe("connecting");
    state = step(state, socket(T0 + 8_000, "connected"));
    expect(state.view.phase).toBe("ok");
    expect(isRecovered(state)).toBe(false);
    expect(state.recoveredUntil).toBeNull();
  });

  it("1초 안의 흔들림은 아무것도 남기지 않는다", () => {
    const state = step(healthy(), socket(T0 + 1_000, "disconnected"), socket(T0 + 1_600, "connected"));
    expect(state.view.phase).toBe("ok");
    expect(isRecovered(state)).toBe(false);
  });

  it("기기 오프라인도 「끊김」이다: 돌아와 소켓이 붙으면 2초 선다", () => {
    let state = step(healthy(), device(T0 + 1_000, false));
    expect(state.view.cause).toBe("deviceOffline");
    state = step(state, device(T0 + 5_000, true), socket(T0 + 5_500, "connected"));
    expect(state.view.phase).toBe("ok");
    expect(isRecovered(state)).toBe(true);
  });

  it("서버에 닿지 못함이 서 있다가 응답 한 건으로 풀려도 2초 선다", () => {
    let state = step(
      healthy(),
      failure("/v1/a", T0 + 1_000),
      failure("/v1/b", T0 + 1_100),
      failure("/v1/c", T0 + 1_200)
    );
    expect(state.view.cause).toBe("serverUnreachable");
    state = step(state, success("/v1/d", T0 + 4_000));
    expect(state.view.phase).toBe("ok");
    expect(isRecovered(state)).toBe(true);
  });

  it("「끊김」 뒤 「지금 다시 연결」을 누르면 「연결 중」이 이어지고, 붙으면 그때 2초 선다(중간의 연결 중이 기억을 지우지 않는다)", () => {
    let state = step(healthy(), socket(T0 + 1_000, "disconnected"), tick(T0 + 11_000));
    expect(state.view.phase).toBe("down");
    state = step(state, resume(T0 + 12_000));
    expect(state.view.phase).toBe("connecting");
    expect(isRecovered(state)).toBe(false);
    state = step(state, socket(T0 + 13_000, "connected"));
    expect(isRecovered(state)).toBe(true);
    expect(state.recoveredUntil).toBe(T0 + 15_000);
  });

  it("복구 표시 중에 다시 끊기면(5초를 못 붙어 있던 깜빡임) 처음 틈의 시계가 이어져 곧바로 「끊김」이 이기고 표시는 거둔다", () => {
    let state = step(healthy(), socket(T0 + 1_000, "disconnected"), tick(T0 + 11_000), socket(T0 + 12_000, "connected"));
    expect(isRecovered(state)).toBe(true);
    state = step(state, socket(T0 + 12_500, "disconnected"));
    expect(state.view.phase).toBe("down");
    expect(isRecovered(state)).toBe(false);
    expect(state.recoveredUntil).toBeNull();
  });
});

describe("판정은 사건이 일어난 시각에 한다 (낡은 now 없음)", () => {
  it("한 시간 조용했다가 소켓이 끊겨도 침묵은 그 사건에서 1초, 다음 깨움도 그 사건에서 1초다", () => {
    const quiet = healthy(T0);
    // 한 시간 뒤의 첫 사건. 이전 판정 시각(T0)이 아무리 낡아도 틈은 이 사건에서 시작한다.
    const state = step(quiet, socket(T0 + 3_600_000, "disconnected"));
    expect(state.view.phase).toBe("quiet");
    expect(state.view.nextChangeAt).toBe(T0 + 3_601_000);
    expect(nextWakeAt(state)).toBe(T0 + 3_601_000);
  });

  it("다음 깨움은 판정을 바꾸는 가장 이른 시각이다(소켓 틈, 복구 표시 끝 중)", () => {
    const state = step(healthy(), socket(T0 + 1_000, "disconnected"), tick(T0 + 11_000), socket(T0 + 12_000, "connected"));
    expect(nextWakeAt(state)).toBe(T0 + 14_000);
    expect(nextWakeAt(healthy())).toBeNull();
  });
});

describe("보이는 것이 같으면 이전 상태 객체를 그대로 돌려준다(소비자가 응답마다 다시 그려지지 않게)", () => {
  it("정상에서 성공 응답이 와도 상태는 같은 객체다", () => {
    const state = healthy();
    expect(step(state, success("/v1/a", T0 + 500))).toBe(state);
    expect(step(state, tick(T0 + 900))).toBe(state);
  });

  it("보이는 것이 달라지면 새 객체다", () => {
    const state = healthy();
    expect(step(state, device(T0 + 500, false))).not.toBe(state);
  });
});

describe("카드냐 띠냐: 한 자리에서만 말한다", () => {
  it("네 가지 배치 모두에서 둘은 서로의 여집합이다(둘 다 서지도, 둘 다 비지도 않는다)", () => {
    for (const asDrawer of [false, true]) {
      for (const listCollapsed of [false, true]) {
        const layout = { asDrawer, listCollapsed };
        expect(showsConnectionCard(layout)).toBe(!showsConnectionBanner(layout));
      }
    }
  });

  it("목록 열이 보이는 넓은 창에서만 카드이고, 서랍이거나 접히면 띠다", () => {
    expect(showsConnectionCard({ asDrawer: false, listCollapsed: false })).toBe(true);
    expect(showsConnectionBanner({ asDrawer: false, listCollapsed: true })).toBe(true);
    expect(showsConnectionBanner({ asDrawer: true, listCollapsed: false })).toBe(true);
    expect(showsConnectionBanner({ asDrawer: true, listCollapsed: true })).toBe(true);
  });
});

describe("공급자 없이 읽는 모습(소켓 상태 + 기기 온라인만)", () => {
  it("붙어 있으면 침묵이고 쓰기가 열려 있다", () => {
    const view = viewWithoutRest("connected", true, T0);
    expect(view.phase).toBe("ok");
    expect(view.canSend).toBe(true);
  });

  it("소켓이 끊겨 있어도(실시간만) 쓰기는 열려 있다: 결정 ③", () => {
    for (const status of ["connecting", "disconnected"] as const) {
      const view = viewWithoutRest(status, true, T0);
      expect(view.canSend && view.canUpload && view.canDecide).toBe(true);
      expect(view.cause).toBe("realtimeDown");
    }
  });

  it("기기가 오프라인이면 막힌다", () => {
    const view = viewWithoutRest("connected", false, T0);
    expect(view.canSend || view.canUpload || view.canDecide).toBe(false);
    expect(view.cause).toBe("deviceOffline");
  });
});

describe("로그인 만료는 정상으로 치지 않는다", () => {
  it("만료가 서면 복구 표시도 기억도 없다", () => {
    let state = step(healthy(), socket(T0 + 1_000, "disconnected"), tick(T0 + 11_000));
    state = step(state, eventAction(T0 + 12_000, sessionEvent(true)));
    expect(state.view.phase).toBe("expired");
    expect(state.sawDown).toBe(false);
    expect(isRecovered(state)).toBe(false);
  });
});

describe("무엇을 그리나 (카드와 띠가 같이 읽는다)", () => {
  const present = (state: ConnectionState) => presentConnection(state.view, isRecovered(state));

  it("침묵(정상·1초 안의 틈)에는 아무것도 그리지 않는다", () => {
    expect(present(healthy())).toBeNull();
    expect(present(step(healthy(), socket(T0 + 1_000, "disconnected")))).toBeNull();
  });

  it("연결 중: 로더가 돌고 단추가 없다", () => {
    const shown = present(step(healthy(), socket(T0 + 1_000, "disconnected"), tick(T0 + 2_100)));
    expect(shown).toEqual({
      tone: CONNECTION_TONE.connecting,
      title: K.connecting,
      detail: null,
      mark: CONNECTION_MARK.moving,
      canReconnect: false,
    });
  });

  it("실시간만 끊김: 로더가 돌고 「지금 다시 연결」이 있다", () => {
    const shown = present(step(healthy(), socket(T0 + 1_000, "disconnected"), tick(T0 + 11_000)));
    expect(shown).toMatchObject({
      tone: CONNECTION_TONE.down,
      title: K.realtimeDownTitle,
      detail: K.realtimeDownDetail,
      mark: CONNECTION_MARK.moving,
      canReconnect: true,
    });
  });

  it("오프라인: 마크가 서 있고(진행 중인 것이 없다) 단추가 없다", () => {
    const shown = present(step(healthy(), device(T0 + 1_000, false)));
    expect(shown).toMatchObject({
      tone: CONNECTION_TONE.offline,
      title: K.offlineTitle,
      detail: K.offlineDetail,
      mark: CONNECTION_MARK.still,
      canReconnect: false,
    });
  });

  it("서버에 닿지 못함: 로더가 돌고(자동으로 다시 시도한다) 「지금 다시 연결」이 있다", () => {
    const shown = present(
      step(healthy(), failure("/v1/a", T0 + 1_000), failure("/v1/b", T0 + 1_100), failure("/v1/c", T0 + 1_200))
    );
    expect(shown).toMatchObject({
      tone: CONNECTION_TONE.unreachable,
      title: K.serverUnreachableTitle,
      mark: CONNECTION_MARK.moving,
      canReconnect: true,
    });
  });

  it("복구: 확인 표시이고 단추가 없다", () => {
    const state = step(healthy(), socket(T0 + 1_000, "disconnected"), tick(T0 + 11_000), socket(T0 + 12_000, "connected"));
    expect(present(state)).toEqual({
      tone: CONNECTION_TONE.recovered,
      title: K.recovered,
      detail: null,
      mark: CONNECTION_MARK.check,
      canReconnect: false,
    });
  });

  it("로그인 만료는 카드·띠가 말하지 않는다(로그인 화면이 말한다)", () => {
    const state = step(healthy(), eventAction(T0 + 1_000, sessionEvent(true)));
    expect(present(state)).toBeNull();
  });
});

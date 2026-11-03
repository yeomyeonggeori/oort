import { describe, expect, it } from "vitest";
import type { ConnectionEvent, ConnectionInput } from "./model";
import { deriveConnectionState, foldConnectionEvent, initialConnectionInput } from "./model";
import { INITIAL_REST_SIGNAL } from "./restSignal";

// 소켓 틈의 시계가 시작하고 풀리고 다시 시작하는 규칙. 숫자는 글자 그대로 단정한다(상수를 깨뜨리면 빨개지게).

const T0 = 1_700_000_000_000;

function run(events: ConnectionEvent[], from: ConnectionInput): ConnectionInput {
  return events.reduce(foldConnectionEvent, from);
}

const status = (at: number, value: "connecting" | "connected" | "disconnected"): ConnectionEvent => ({
  kind: "socket",
  at,
  status: value,
});

const phaseAt = (input: ConnectionInput, ms: number) => deriveConnectionState(input, T0 + ms).phase;

/** 기기 온라인, 소켓 연결됨(틈 없음). */
const connected: ConnectionInput = {
  deviceOnline: true,
  socket: { status: "connected", open: null, ended: false },
  rest: INITIAL_REST_SIGNAL,
  sessionExpired: false,
};

describe("소켓 틈의 시계", () => {
  it("다시 붙어도 5초 붙어 있기 전에 또 끊기면 처음 시작한 때가 이어지고, 5초를 채우면 새 틈이다", () => {
    // 깜빡이는 소켓(붙었다 끊김을 되풀이)이 매번 시계를 0으로 돌리면 문턱을 영영 못 넘는다.
    const start = initialConnectionInput(T0, true);
    expect(phaseAt(run([status(T0 + 2_000, "connected")], start), 3_000)).toBe("ok");
    const flapping = run([status(T0 + 2_000, "connected"), status(T0 + 6_000, "disconnected")], start);
    expect(phaseAt(flapping, 9_999)).toBe("connecting");
    expect(phaseAt(flapping, 10_000)).toBe("down");

    // 붙은 지 정확히 5초(7초 시점)에 끊기면 풀린 것으로 보고, 끊긴 때(T0+7초)부터 새로 센다.
    const healed = run([status(T0 + 2_000, "connected"), status(T0 + 7_000, "disconnected")], start);
    expect(phaseAt(healed, 7_999)).toBe("quiet");
    expect(phaseAt(healed, 8_000)).toBe("connecting");
    expect(phaseAt(healed, 16_999)).toBe("connecting");
    expect(phaseAt(healed, 17_000)).toBe("down");
  });

  it("다시 연결(resume)은 시계를 새로 시작한다: 침묵이던 틈은 침묵 1초부터, 말하던 띠는 곧바로 「연결 중」부터 10초", () => {
    const quietGap = run([status(T0, "disconnected"), { kind: "resume", at: T0 + 500 }], connected);
    expect(phaseAt(quietGap, 1_499)).toBe("quiet");
    expect(phaseAt(quietGap, 1_500)).toBe("connecting");

    const speaking = run([status(T0, "disconnected"), { kind: "resume", at: T0 + 30_000 }], connected);
    expect(phaseAt(speaking, 30_000)).toBe("connecting");
    expect(phaseAt(speaking, 39_999)).toBe("connecting");
    expect(phaseAt(speaking, 40_000)).toBe("down");
  });
});

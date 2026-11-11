import { describe, expect, it } from "vitest";
import { LATE_WAKE_MS } from "../../lib/http";
import { verdictOnLateWake, verdictOnReturn } from "./resume";
import { RESUME_AFTER_HIDDEN_MS, SOCKET_HEARD_RECENTLY_MS } from "./thresholds";

// #5660: 돌아온 순간·깨어난 순간에 소켓을 다시 열지. 끊긴(기다리는) 소켓은 기다리지 않고, 살아 있는 소켓은 흔들지 않는다.

describe("앞으로 돌아온 순간", () => {
  it("다시 붙기를 기다리는 중이면 자리를 비운 시간과 무관하게 지금 다시 연다", () => {
    for (const awayMs of [0, 5_000, RESUME_AFTER_HIDDEN_MS - 1, RESUME_AFTER_HIDDEN_MS, 30 * 60_000]) {
      expect(verdictOnReturn({ awayMs, socketConnected: false, heardAgoMs: 1_000 }), String(awayMs)).toBe("reconnect");
    }
  });

  it("30초 안의 자리 비움은 붙어 있는 소켓을 건드리지 않는다(들은 지 오래여도)", () => {
    expect(verdictOnReturn({ awayMs: RESUME_AFTER_HIDDEN_MS - 1, socketConnected: true, heardAgoMs: null })).toBe("keep");
    expect(verdictOnReturn({ awayMs: 20_000, socketConnected: true, heardAgoMs: 10 * 60_000 })).toBe("keep");
  });

  it("오래 비웠어도 그동안 서버의 말을 들은 소켓은 살아 있다: 다시 열지 않는다", () => {
    expect(verdictOnReturn({ awayMs: 30 * 60_000, socketConnected: true, heardAgoMs: 3_000 })).toBe("keep");
    expect(
      verdictOnReturn({ awayMs: 5 * 60_000, socketConnected: true, heardAgoMs: SOCKET_HEARD_RECENTLY_MS - 1 })
    ).toBe("keep");
  });

  it("오래 비웠고 그동안 아무것도 듣지 못한 소켓은 「연결됨」이어도 다시 연다(잠든 사이 죽은 소켓)", () => {
    expect(
      verdictOnReturn({ awayMs: RESUME_AFTER_HIDDEN_MS, socketConnected: true, heardAgoMs: SOCKET_HEARD_RECENTLY_MS })
    ).toBe("reconnect");
    expect(verdictOnReturn({ awayMs: 5 * 60_000, socketConnected: true, heardAgoMs: 5 * 60_000 })).toBe("reconnect");
    expect(verdictOnReturn({ awayMs: 31_000, socketConnected: true, heardAgoMs: null })).toBe("reconnect");
  });
});

describe("시계가 늦게 깬 순간", () => {
  it("10초보다 덜 늦었으면 아무것도 하지 않는다(숨은 창의 1~2초 맞춤 잡음)", () => {
    expect(verdictOnLateWake({ lateMs: LATE_WAKE_MS - 1, socketConnected: false, heardAgoMs: null })).toBe("keep");
    expect(verdictOnLateWake({ lateMs: Number.NaN, socketConnected: false, heardAgoMs: null })).toBe("keep");
  });

  it("멈춘 동안 아무것도 듣지 못했으면(잠자기) 핑 마감을 기다리지 않고 지금 다시 연다", () => {
    expect(verdictOnLateWake({ lateMs: 20_000, socketConnected: true, heardAgoMs: 27_000 })).toBe("reconnect");
    expect(verdictOnLateWake({ lateMs: LATE_WAKE_MS, socketConnected: true, heardAgoMs: LATE_WAKE_MS })).toBe("reconnect");
    expect(verdictOnLateWake({ lateMs: 4 * 60_000, socketConnected: true, heardAgoMs: null })).toBe("reconnect");
  });

  it("멈춘 뒤에도 서버의 말을 들었으면(타이머만 묶인 숨은 탭) 살아 있는 소켓이다", () => {
    expect(verdictOnLateWake({ lateMs: 60_000, socketConnected: true, heardAgoMs: 12_000 })).toBe("keep");
    expect(verdictOnLateWake({ lateMs: 20_000, socketConnected: true, heardAgoMs: 19_999 })).toBe("keep");
  });

  it("다시 붙기를 기다리는 중이었다면 깬 순간 지금 다시 연다", () => {
    expect(verdictOnLateWake({ lateMs: 15_000, socketConnected: false, heardAgoMs: 1_000 })).toBe("reconnect");
  });
});

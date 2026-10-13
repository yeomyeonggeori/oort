import { describe, expect, it } from "vitest";
import {
  agentLivenessFromWire,
  ApiError,
  type AgentLivenessState,
} from "../../lib/api";
import { WireShapeError } from "../../lib/wire";
import * as liveness from "./liveness";
import {
  canOfferWake,
  livenessAccessibleName,
  livenessView,
  toolErrorText,
  wakeCooldownLabel,
  wakeFailureText,
} from "./liveness";

const NOW = 1_800_000_000_000;
const MIN = 60_000;

const view = (state: AgentLivenessState, minutesAgo?: number) =>
  livenessView(
    {
      state,
      ...(minutesAgo === undefined ? {} : { lastSignalAtMs: NOW - minutesAgo * MIN }),
    },
    NOW
  );

describe("생존 라벨 (ADR-0200 D4): 「연결됨」이 아니라 「지금 살아 있는가」", () => {
  it("다섯 라벨", () => {
    expect(view("responsive", 3).text).toBe("응답함 3분 전");
    expect(view("alive_idle", 2).text).toBe("살아 있음 · 대기 중");
    expect(view("work_waiting").text).toBe("일이 기다리는 중");
    expect(view("woken_not_collected").text).toBe("깨웠지만 아직 안 가져감");
    expect(view("unresponsive", 95).text).toBe("응답 없음 1시간");
    expect(view("unresponsive", 12).text).toBe("응답 없음 12분");
  });

  it("나머지 상태도 낱말이 있다", () => {
    expect(view("quiet", 40).text).toBe("조용함 · 마지막 응답 40분 전");
    expect(view("error").text).toBe("호출이 거절됨");
    expect(view("inactive").text).toBe("연결이 꺼져 있어요");
  });

  it("n분은 서버가 알린 마지막 신호에서 온다: 신호가 없으면 숫자를 지어내지 않는다", () => {
    expect(view("unresponsive").text).toBe("응답 없음");
    expect(view("quiet").text).toBe("조용함");
    // 1분 미만은 「0분 전」이 아니라 「방금」이다.
    expect(livenessView({ state: "responsive", lastSignalAtMs: NOW - 20_000 }, NOW).text).toBe(
      "방금 응답함"
    );
  });

  it("「응답함」은 서버가 알린 응답 상태에만 쓴다", () => {
    for (const state of [
      "alive_idle",
      "work_waiting",
      "woken_not_collected",
      "unresponsive",
      "quiet",
      "error",
      "inactive",
    ] as const) {
      expect(view(state, 1).text).not.toContain("응답함");
    }
  });

  it("색은 사람이 할 일이 있는 상태만 경고다", () => {
    const tone = (s: AgentLivenessState) => view(s, 5).tone;
    expect(tone("responsive")).toBe("ok");
    expect(tone("alive_idle")).toBe("neutral");
    expect(tone("quiet")).toBe("neutral");
    expect(tone("inactive")).toBe("neutral");
    for (const s of ["work_waiting", "woken_not_collected", "unresponsive", "error"] as const) {
      expect(tone(s)).toBe("warn");
    }
  });

  it("좁은 자리용 낱말이 있고 접근성 이름은 뜻을 덧붙인다", () => {
    expect(view("responsive", 3).short).toBe("응답함");
    expect(view("woken_not_collected").short).toBe("안 가져감");
    expect(livenessAccessibleName(view("alive_idle"))).toContain("일은 가져가지 않고 있어요");
  });

  it("관리자 상세의 닫힌 거절 코드만 문장이 된다", () => {
    expect(toolErrorText("unavailable")).toContain("일시적으로");
    expect(toolErrorText("not_authorized")).toContain("권한이 없다고");
    expect(toolErrorText("brand_new")).toBeUndefined();
    expect(toolErrorText(undefined)).toBeUndefined();
  });
});

describe("다시 깨우기", () => {
  it("이미 응답하는 에이전트와 꺼진 연결에는 권하지 않는다", () => {
    expect(canOfferWake("responsive")).toBe(false);
    expect(canOfferWake("inactive")).toBe(false);
    for (const s of ["alive_idle", "work_waiting", "woken_not_collected", "quiet", "unresponsive", "error"] as const) {
      expect(canOfferWake(s)).toBe(true);
    }
  });

  it("쿨다운은 서버가 준 때까지 남은 시간이다", () => {
    expect(wakeCooldownLabel(NOW + 42_000, NOW)).toBe("42초 뒤에 다시 깨울 수 있어요");
    expect(wakeCooldownLabel(NOW + 60_000, NOW)).toBe("60초 뒤에 다시 깨울 수 있어요");
    expect(wakeCooldownLabel(NOW + 61_000, NOW)).toBe("2분 뒤에 다시 깨울 수 있어요");
    expect(wakeCooldownLabel(NOW, NOW)).toBeUndefined();
    expect(wakeCooldownLabel(NOW - 1, NOW)).toBeUndefined();
  });

  it("거절은 상태별 문장이다", () => {
    expect(wakeFailureText(new ApiError(404, "x"))).toContain("권한이 없어요");
    expect(wakeFailureText(new ApiError(409, "x"))).toContain("도어벨");
    expect(wakeFailureText(new Error("network"))).toContain("잠시 뒤에");
  });

  it("문장 상수는 해요체다", () => {
    for (const [name, value] of Object.entries(liveness)) {
      if (typeof value !== "string") continue;
      expect({ name, value }).not.toMatchObject({ value: expect.stringMatching(/(습니다|합니다)[.]?$/) });
    }
  });
});

describe("응답 파서", () => {
  it("id는 소문자로 접고 모르는 상태는 통과시키지 않는다", () => {
    const parsed = agentLivenessFromWire({
      agentMemberId: "ABC",
      state: "alive_idle",
      lastSignalAtMs: NOW,
    });
    expect(parsed).toEqual({ agentMemberId: "abc", state: "alive_idle", lastSignalAtMs: NOW });
    expect(() => agentLivenessFromWire({ agentMemberId: "a", state: "online" })).toThrow(WireShapeError);
    expect(() => agentLivenessFromWire({ state: "quiet" })).toThrow(WireShapeError);
  });
});

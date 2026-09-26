import { describe, expect, it } from "vitest";
import {
  GUIDE_STATE_TABLE,
  GUIDE_STATES,
  KOMETTO_EXPRESSIONS,
  assertGuideLine,
  expressionForState,
  isKomettoExpression,
  onboardingDotScreens,
  onboardingDots,
} from "./guide";

describe("상태 → 표정 표 (ADR-0193 D11)", () => {
  it("has the six rows of the decision table, in order", () => {
    expect(GUIDE_STATE_TABLE.map((r) => [r.state, r.expression])).toEqual([
      ["awaiting", "idle"],
      ["checking", "thinking"],
      ["success", "happy"],
      ["trouble", "flustered"],
      ["preparing", "working"],
      ["skipped", "sleepy"],
    ]);
  });

  it("is one-to-one: every expression appears exactly once, every state exactly once", () => {
    const expressions = GUIDE_STATE_TABLE.map((r) => r.expression);
    expect(new Set(expressions).size).toBe(6);
    expect([...expressions].sort()).toEqual([...KOMETTO_EXPRESSIONS].sort());
    expect(GUIDE_STATE_TABLE.map((r) => r.state)).toEqual([...GUIDE_STATES]);
  });

  it("keeps the #2806 expression ids", () => {
    expect([...KOMETTO_EXPRESSIONS]).toEqual([
      "idle",
      "thinking",
      "happy",
      "flustered",
      "working",
      "sleepy",
    ]);
    expect(isKomettoExpression("happy")).toBe(true);
    expect(isKomettoExpression("joy")).toBe(false);
  });

  it("resolves a state to its expression", () => {
    expect(expressionForState("checking")).toBe("thinking");
    expect(expressionForState("trouble")).toBe("flustered");
  });
});

describe("말풍선 문장 (표정만 있고 문장이 빈 사용 거부)", () => {
  it("rejects an empty line", () => {
    expect(() => assertGuideLine("")).toThrow(/needs a line/);
  });

  it("rejects a whitespace-only line", () => {
    expect(() => assertGuideLine("   \n ")).toThrow(/needs a line/);
  });

  it("passes a real sentence through, trimmed", () => {
    expect(assertGuideLine(" 어디로 갈까요? ")).toBe("어디로 갈까요?");
  });
});

describe("진행 점 흐름 모델 (ADR-0193 D10)", () => {
  it("counts dots per route: login 1~2, invite 2, claim 4", () => {
    expect(onboardingDotScreens("login")).toHaveLength(1);
    expect(onboardingDotScreens("login", { aiConnect: true })).toHaveLength(2);
    expect(onboardingDotScreens("invite")).toHaveLength(2);
    expect(onboardingDotScreens("claim")).toHaveLength(4);
  });

  it("shares one line from before sign-in through AI 연결 on the claim route", () => {
    expect(onboardingDotScreens("claim")).toEqual([
      "claim",
      "workspace-profile",
      "invite",
      "ai-connect",
    ]);
    expect(onboardingDotScreens("invite").at(-1)).toBe("ai-connect");
  });

  it("draws nothing on the first screen (D0) and the first conversation (D5)", () => {
    for (const route of ["login", "invite", "claim"] as const) {
      expect(onboardingDots(route, "welcome")).toBeNull();
      expect(onboardingDots(route, "first-conversation")).toBeNull();
    }
  });

  it("draws nothing for a screen that is not on the route", () => {
    expect(onboardingDots("login", "workspace-profile")).toBeNull();
    expect(onboardingDots("login", "ai-connect")).toBeNull();
  });

  it("marks done / current / todo and names the step for a screen reader", () => {
    expect(onboardingDots("claim", "workspace-profile")).toEqual({
      total: 4,
      current: 2,
      dots: ["done", "current", "todo", "todo"],
      label: "4단계 중 2단계",
    });
    expect(onboardingDots("invite", "join")).toEqual({
      total: 2,
      current: 1,
      dots: ["current", "todo"],
      label: "2단계 중 1단계",
    });
    expect(onboardingDots("login", "sign-in", { aiConnect: true })?.label).toBe(
      "2단계 중 1단계"
    );
    expect(onboardingDots("claim", "ai-connect")?.dots).toEqual([
      "done",
      "done",
      "done",
      "current",
    ]);
  });
});

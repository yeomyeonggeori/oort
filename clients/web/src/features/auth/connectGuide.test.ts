import { describe, expect, it } from "vitest";
import { expressionForState } from "@momo/core/features/onboarding/guide";
import { connectGuide, connectGuideState } from "./connectGuide";
import { claimHandoff } from "./claimHandoff";
import { afterJoinSurface } from "./joinFollowUp";
import type { OnboardingStep } from "./onboardingFlow";

const STEPS: OnboardingStep[] = ["welcome", "sign-in", "join"];
const CONDITIONS = [
  { offline: false, failed: false, busy: false },
  { offline: false, failed: false, busy: true },
  { offline: false, failed: true, busy: false },
  { offline: true, failed: false, busy: false },
  { offline: true, failed: true, busy: true },
];

describe("코메토 말과 상태 (M5, ADR-0193 D11)", () => {
  it("draws the expression from the core table and always says a sentence", () => {
    for (const step of STEPS) {
      for (const condition of CONDITIONS) {
        const guide = connectGuide(step, condition);
        expect(guide.expression).toBe(expressionForState(guide.state));
        expect(guide.line.trim()).not.toBe("");
        expect(guide.line).toMatch(/요[.?]$/);
      }
    }
  });

  it("maps error and offline to 당황, busy to 생각, D1′ rest to 기쁨", () => {
    expect(connectGuideState("sign-in", { offline: true, failed: false, busy: true })).toBe("trouble");
    expect(connectGuideState("sign-in", { offline: false, failed: true, busy: true })).toBe("trouble");
    expect(connectGuideState("sign-in", { offline: false, failed: false, busy: true })).toBe("checking");
    expect(connectGuideState("sign-in", { offline: false, failed: false, busy: false })).toBe("awaiting");
    expect(connectGuideState("join", { offline: false, failed: false, busy: false })).toBe("success");
  });

  it("changes the sentence with the expression, never the face alone", () => {
    for (const step of STEPS) {
      const rest = connectGuide(step, CONDITIONS[0]);
      const trouble = connectGuide(step, CONDITIONS[2]);
      expect(trouble.expression).not.toBe(rest.expression);
      expect(trouble.line).not.toBe(rest.line);
    }
  });

  it("names the team when the workspace name is known", () => {
    expect(
      connectGuide("join", CONDITIONS[0], { workspaceName: "여명거리" }).line
    ).toBe("여명거리팀이 초대했어요.");
    expect(connectGuide("join", CONDITIONS[0]).line).toBe("초대를 받았어요.");
  });
});

describe("claim handoff (#2808 → #2811)", () => {
  const token = "A".repeat(43);
  it("stays on this page for a same-origin link and clears a foreign server choice", () => {
    expect(
      claimHandoff({ origin: "https://team.example.com", token, pageOrigin: "https://team.example.com", isTauri: false })
    ).toEqual({ serverBase: null, href: `/claim/${token}` });
  });
  it("opens the other server's own page for a foreign link", () => {
    expect(
      claimHandoff({ origin: "https://other.example.com", token, pageOrigin: "https://team.example.com", isTauri: false })
    ).toEqual({ serverBase: undefined, href: `https://other.example.com/claim/${token}` });
  });
  it("stores the link's server in the desktop app and opens the bundled claim route", () => {
    expect(
      claimHandoff({ origin: "http://localhost:28080", token, pageOrigin: "tauri://localhost", isTauri: true })
    ).toEqual({ serverBase: "http://localhost:28080", href: `/claim/${token}` });
  });
});

describe("after join (#2810)", () => {
  it("skips AI 연결 only when an active agent is known to exist", () => {
    expect(afterJoinSurface(1)).toBe("first-conversation");
    expect(afterJoinSurface(0)).toBe("ai-connect");
    expect(afterJoinSurface(null)).toBe("ai-connect");
  });
});

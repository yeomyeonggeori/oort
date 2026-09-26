import { describe, expect, it } from "vitest";
import {
  aiConnectReentryHash,
  aiConnectReturnHash,
  readAiConnectReentry,
} from "./aiConnectReentry";

describe("AI 연결 재진입 주소 (#2870)", () => {
  it("출발지를 싣고 되읽는다", () => {
    expect(aiConnectReentryHash("settings")).toBe("#/ai-connect?from=settings");
    expect(readAiConnectReentry(aiConnectReentryHash("settings"))).toEqual({ from: "settings" });
    expect(readAiConnectReentry(aiConnectReentryHash("agents"))).toEqual({ from: "agents" });
  });

  it("모르는 출발지는 에이전트 화면으로 읽는다", () => {
    expect(readAiConnectReentry("#/ai-connect?from=https://evil.test")).toEqual({ from: "agents" });
    expect(readAiConnectReentry("#/ai-connect")).toEqual({ from: "agents" });
  });

  it("다른 주소는 재진입이 아니다", () => {
    expect(readAiConnectReentry("#/agents")).toBeNull();
    expect(readAiConnectReentry("#/ai-connect-x")).toBeNull();
    expect(readAiConnectReentry("")).toBeNull();
    expect(readAiConnectReentry("#/settings?section=ai")).toBeNull();
  });

  it("돌아갈 곳은 두 자리뿐이다", () => {
    expect(aiConnectReturnHash("agents")).toBe("#/agents");
    expect(aiConnectReturnHash("settings")).toBe("#/settings?section=ai");
  });
});

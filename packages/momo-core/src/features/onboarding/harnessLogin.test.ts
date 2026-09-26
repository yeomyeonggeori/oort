import { describe, expect, it } from "vitest";
import type { LocalHarnessProbe } from "../hostedAgents/detect";
import {
  HARNESS_LOGIN_METHODS,
  HARNESS_LOGIN_TIMEOUT_MS,
  LOGIN_ACTION_LABEL,
  LOGIN_CODE_HINT,
  harnessLoginVerdict,
  loginAcceptsCode,
  loginActionLabel,
  loginFailedDetail,
  loginFailedLine,
  loginWaitingDetail,
  loginWaitingLine,
} from "./harnessLogin";

describe("로그인 버튼 이름 (ADR-0193 D2 개정)", () => {
  it("is exactly the two names the ADR allows", () => {
    expect(LOGIN_ACTION_LABEL).toEqual({
      claude: "Claude Code로 로그인",
      codex: "Codex로 로그인",
    });
    expect(loginActionLabel("claude")).toBe("Claude Code로 로그인");
  });
});

describe("방법 목록은 셸 LOGIN_COMMANDS(ADR-0190 D3-f A1·A3·A4)와 같다", () => {
  it("claude: browser only; codex: browser + device", () => {
    expect(HARNESS_LOGIN_METHODS).toEqual({ claude: ["browser"], codex: ["browser", "device"] });
  });

  it("the code field is offered only where the CLI can ask for one", () => {
    expect(loginAcceptsCode("claude", "browser")).toBe(true);
    expect(loginAcceptsCode("codex", "browser")).toBe(false);
    expect(loginAcceptsCode("codex", "device")).toBe(false);
  });
});

describe("판정은 상태 명령만 (ADR-0190 D3-f)", () => {
  const logged: LocalHarnessProbe = { id: "claude", installed: true, auth: "logged_in" };
  const needs: LocalHarnessProbe = { id: "claude", installed: true, auth: "needs_login" };

  it("logged in → connected; anything else → not logged in", () => {
    expect(harnessLoginVerdict("claude", [logged])).toEqual({ phase: "connected" });
    expect(harnessLoginVerdict("claude", [needs])).toEqual({
      phase: "failed",
      reason: "not-logged-in",
    });
    expect(harnessLoginVerdict("claude", [{ ...logged, auth: "unknown" }])).toEqual({
      phase: "failed",
      reason: "not-logged-in",
    });
    expect(harnessLoginVerdict("claude", null)).toEqual({
      phase: "failed",
      reason: "not-logged-in",
    });
  });

  it("reads the row of the harness being signed in, not another", () => {
    expect(
      harnessLoginVerdict("codex", [logged, { id: "codex", installed: true, auth: "needs_login" }])
    ).toEqual({ phase: "failed", reason: "not-logged-in" });
  });
});

describe("문장", () => {
  it("the waiting line states who signs in and that oort does not see it", () => {
    expect(loginWaitingLine("browser")).toBe("브라우저에서 로그인하고 있어요.");
    expect(loginWaitingDetail("claude")).toBe(
      "로그인은 Claude Code가 연 브라우저 창에서 끝나요. oort는 로그인 정보를 보지 않아요."
    );
    expect(loginWaitingDetail("codex")).toContain("Codex가");
    expect(LOGIN_CODE_HINT).toContain("저장하지 않습니다");
  });

  it("each failure says what happened in 해요체", () => {
    for (const reason of ["timeout", "not-logged-in", "spawn"] as const) {
      expect(loginFailedLine(reason)).toMatch(/요\.$/);
      expect(loginFailedDetail("claude", reason)).toMatch(/요\.$/);
    }
    expect(loginFailedDetail("claude", "timeout")).toContain(
      `${HARNESS_LOGIN_TIMEOUT_MS / 60_000}분`
    );
  });
});

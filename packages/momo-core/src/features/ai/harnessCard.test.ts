import { describe, expect, it } from "vitest";
import {
  disconnectVerdict,
  harnessLoginView,
  myHostView,
  normalizePersonalAlias,
  personalAgentErrorLine,
  personalAliasValid,
  type DisconnectProgress,
} from "./harnessCard";

const idle: DisconnectProgress = { phase: "idle" };
const exit0 = { code: 0, signal: null };
const probe = (auth: "logged_in" | "needs_login" | "unknown", installed = true) => [
  { id: "claude" as const, installed, auth },
];

describe("harnessLoginView", () => {
  it("알약과 진행에서 로그인 상태를 정한다", () => {
    const v = (pill: Parameters<typeof harnessLoginView>[0]["pill"]) =>
      harnessLoginView({ pill, login: null, disconnect: idle });
    expect(v("ready")).toBe("connected");
    expect(v("login")).toBe("reauth");
    expect(v("recheck")).toBe("unknown");
    expect(v("checking")).toBe("checking");
    expect(v("install")).toBe("not-installed");
  });

  it("로그인 진행 중이면 알약보다 앞서 「로그인 중」이다", () => {
    expect(harnessLoginView({ pill: "login", login: "waiting", disconnect: idle })).toBe("logging-in");
    expect(harnessLoginView({ pill: "login", login: "checking", disconnect: idle })).toBe("logging-in");
  });

  it("끊는 중에는 아직 연결됨 알약이어도 「끊는 중」이고 「연결 안 됨」이 아니다", () => {
    for (const phase of ["signing-out", "verifying"] as const) {
      expect(harnessLoginView({ pill: "ready", login: null, disconnect: { phase } })).toBe("disconnecting");
    }
    // 로그아웃 확인 전에는 로그인이 풀려 보여도 「연결 안 됨」을 말하지 않는다.
    expect(harnessLoginView({ pill: "login", login: null, disconnect: { phase: "verifying" } })).not.toBe("disconnected");
  });

  it("「연결 안 됨」은 확인이 끝난(done) 뒤 로그인 아님일 때만이다", () => {
    expect(harnessLoginView({ pill: "login", login: null, disconnect: { phase: "done" } })).toBe("disconnected");
    expect(harnessLoginView({ pill: "login", login: null, disconnect: { phase: "failed", reason: "unknown" } })).toBe("reauth");
    expect(harnessLoginView({ pill: "ready", login: null, disconnect: { phase: "done" } })).toBe("connected");
  });
});

describe("disconnectVerdict", () => {
  it("종료 0이고 상태 명령이 로그인 아님일 때만 done", () => {
    expect(disconnectVerdict("claude", exit0, probe("needs_login"))).toEqual({ phase: "done" });
  });
  it("종료 0이어도 아직 로그인이면 still-logged-in", () => {
    expect(disconnectVerdict("claude", exit0, probe("logged_in"))).toEqual({ phase: "failed", reason: "still-logged-in" });
  });
  it("상태 명령이 답하지 않으면 끊겼다고 하지 않는다", () => {
    expect(disconnectVerdict("claude", exit0, probe("unknown"))).toEqual({ phase: "failed", reason: "unknown" });
    expect(disconnectVerdict("claude", exit0, null)).toEqual({ phase: "failed", reason: "unknown" });
    expect(disconnectVerdict("claude", exit0, probe("needs_login", false))).toEqual({ phase: "failed", reason: "unknown" });
  });
  it("로그아웃이 0이 아니게 끝나면 상태가 로그인 아님이어도 done이 아니다", () => {
    expect(disconnectVerdict("claude", { code: 1, signal: null }, probe("needs_login"))).toEqual({ phase: "failed", reason: "logout-failed" });
    expect(disconnectVerdict("claude", { code: null, signal: "SIGTERM" }, probe("needs_login"))).toEqual({ phase: "failed", reason: "logout-failed" });
    expect(disconnectVerdict("claude", null, probe("needs_login"))).toEqual({ phase: "failed", reason: "logout-failed" });
  });
});

describe("myHostView", () => {
  const mine = { scope: "member", ownerMemberId: "AA", online: true };
  it("읽기 상태", () => {
    expect(myHostView({ state: "loading" }, "aa")).toBe("checking");
    expect(myHostView({ state: "error" }, "aa")).toBe("unknown");
  });
  it("내 호스트가 없으면 미등록: 남의 개인 맥과 워크스페이스 공용은 세지 않는다", () => {
    expect(
      myHostView(
        {
          state: "ok",
          hosts: [
            { scope: "member", ownerMemberId: "bb", online: true },
            { scope: "workspace", ownerMemberId: "aa", online: true },
            { ...mine, revokedAtMs: 5 },
          ],
        },
        "aa"
      )
    ).toBe("unregistered");
  });
  it("서버 online 그대로: 켜짐/꺼짐", () => {
    expect(myHostView({ state: "ok", hosts: [mine] }, "aa")).toBe("on");
    expect(myHostView({ state: "ok", hosts: [{ ...mine, online: false }] }, "aa")).toBe("off");
  });
});

describe("개인 에이전트 별칭", () => {
  it("소문자로 접고 @를 뗀다", () => {
    expect(normalizePersonalAlias(" @Kwak-Claude ")).toBe("kwak-claude");
  });
  it("2~32자 a-z0-9_-", () => {
    expect(personalAliasValid("kwak-claude")).toBe(true);
    expect(personalAliasValid("a")).toBe(false);
    expect(personalAliasValid("a".repeat(33))).toBe(false);
    expect(personalAliasValid("한글")).toBe(false);
    expect(personalAliasValid("Ab")).toBe(false);
  });
  it("중복 409는 구체 문구", () => {
    expect(personalAgentErrorLine("personal_agent_alias_taken")).toContain("이미 쓰는 별칭");
    expect(personalAgentErrorLine(null)).not.toContain("이미 쓰는 별칭");
  });
});

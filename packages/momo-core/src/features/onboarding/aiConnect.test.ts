import { describe, expect, it } from "vitest";
import { toHostedConnection } from "../hostedAgents/model";
import * as harnessLogin from "./harnessLogin";
import {
  AI_CONNECT_BOUNDARY_NOTE,
  AI_CONNECT_ROW_COPY,
  HARNESS_LOGIN_COMMAND,
  HARNESS_PILL_LABEL,
  LOGIN_POLL_INTERVAL_MS,
  LOGIN_POLL_WINDOW_MS,
  SUBSCRIPTION_HARNESS_WIRE,
  aiConnectFoundLine,
  aiConnectRows,
  classifyJoinConflict,
  harnessPill,
  joinJoinedLine,
  loginPollNext,
  primaryActionLabel,
  subscriptionAgentIdentity,
  subscriptionConnectPlan,
  subscriptionRowSelectable,
  subscriptionSurface,
} from "./aiConnect";
import * as aiConnect from "./aiConnect";

describe("구독 줄 노출은 세 게이트 AND (ADR-0193 D6, #2814)", () => {
  it("opens only for desktop + build flag + server true", () => {
    expect(
      subscriptionSurface({ isDesktop: true, buildFlag: true, serverEnabled: true })
    ).toBe("rows");
  });

  it("hides silently when the build flag is off (team builds before #2815)", () => {
    for (const isDesktop of [true, false]) {
      for (const serverEnabled of [true, false, null]) {
        expect(subscriptionSurface({ isDesktop, buildFlag: false, serverEnabled })).toBe(
          "hidden"
        );
      }
    }
  });

  it("says 'desktop only' on the web", () => {
    expect(
      subscriptionSurface({ isDesktop: false, buildFlag: true, serverEnabled: true })
    ).toBe("desktop-only");
  });

  it("treats a server that does not report the switch as off", () => {
    expect(
      subscriptionSurface({ isDesktop: true, buildFlag: true, serverEnabled: null })
    ).toBe("server-off");
    expect(
      subscriptionSurface({ isDesktop: true, buildFlag: true, serverEnabled: false })
    ).toBe("server-off");
  });

  it("puts the API key row first whenever the subscription rows are not shown", () => {
    expect(aiConnectRows("rows")).toEqual(["claude", "codex", "api-key", "grok"]);
    for (const surface of ["desktop-only", "server-off", "hidden"] as const) {
      expect(aiConnectRows(surface)[0]).toBe("api-key");
      expect(aiConnectRows(surface)).not.toContain("claude");
      expect(aiConnectRows(surface)).not.toContain("codex");
    }
  });
});

describe("알약 다섯 (이슈 계약 문구)", () => {
  it("keeps the five labels", () => {
    expect(HARNESS_PILL_LABEL).toEqual({
      install: "설치 필요",
      login: "로그인 필요",
      checking: "확인 중…",
      ready: "준비됨",
      recheck: "다시 확인",
    });
  });

  it("maps probe + watch to one pill", () => {
    expect(harnessPill(null)).toBe("checking");
    expect(harnessPill({ id: "claude", installed: false, auth: "unknown" })).toBe("install");
    expect(harnessPill({ id: "claude", installed: true, auth: "logged_in" })).toBe("ready");
    expect(harnessPill({ id: "codex", installed: true, auth: "needs_login" })).toBe("login");
    expect(
      harnessPill(
        { id: "codex", installed: true, auth: "needs_login" },
        { polling: true, expired: false }
      )
    ).toBe("checking");
    expect(
      harnessPill(
        { id: "codex", installed: true, auth: "needs_login" },
        { polling: false, expired: true }
      )
    ).toBe("recheck");
    expect(harnessPill({ id: "codex", installed: true, auth: "unknown" })).toBe("recheck");
  });

  it("a logged-in CLI stays ready even while a login poll is running", () => {
    expect(
      harnessPill(
        { id: "claude", installed: true, auth: "logged_in" },
        { polling: true, expired: false }
      )
    ).toBe("ready");
  });

  it("only a ready row can be chosen", () => {
    expect(subscriptionRowSelectable("ready")).toBe(true);
    for (const pill of ["install", "login", "checking", "recheck"] as const) {
      expect(subscriptionRowSelectable(pill)).toBe(false);
    }
  });
});

describe("로그인 재확인: 2초마다, 120초까지", () => {
  it("waits 2s after each finished check and stops at 120s", () => {
    expect(LOGIN_POLL_INTERVAL_MS).toBe(2_000);
    expect(LOGIN_POLL_WINDOW_MS).toBe(120_000);
    expect(loginPollNext(0)).toBe(2_000);
    expect(loginPollNext(119_999)).toBe(2_000);
    expect(loginPollNext(120_000)).toBe("stop");
    expect(loginPollNext(10 * 60_000)).toBe("stop");
  });
});

describe("「Claude로 로그인」 버튼을 만들 문장이 없다 (ADR-0193 D2, 2026-09-27 개정)", () => {
  it("no exported string names a provider login button", () => {
    const strings: string[] = [];
    const walk = (value: unknown) => {
      if (typeof value === "string") strings.push(value);
      else if (typeof value === "function") {
        for (const id of ["claude", "codex", "api-key", "grok", null] as const) {
          try {
            const out = (value as (arg: unknown) => unknown)(id);
            if (typeof out === "string") strings.push(out);
          } catch {
            /* not a one-arg copy function */
          }
        }
      } else if (value && typeof value === "object") {
        for (const inner of Object.values(value)) walk(inner);
      }
    };
    walk(aiConnect);
    walk(harnessLogin);
    expect(strings.length).toBeGreaterThan(40);
    // 개정 D2: 로그인하는 주체가 공식 CLI인 「Claude Code로」「Codex로」만 된다.
    // 제공자·서비스 이름(Claude·ChatGPT·OpenAI·Anthropic) 바로 뒤의 「로 로그인」은 없다.
    const offenders = strings.filter((text) =>
      /(Claude|ChatGPT|OpenAI|Anthropic|claude\.ai)\s*(로|으로)\s*로그인/.test(text)
    );
    expect(offenders).toEqual([]);
    // 제휴·보증으로 읽히는 말이 없다(ADR-0193 증보 약관 판단 2).
    expect(strings.filter((text) => /공식 연동|파트너|제휴|인증된|Sign in with/i.test(text))).toEqual(
      []
    );
  });

  it("the Phase 1 fallback copies the same official sign-in entry the dialog runs", () => {
    expect(HARNESS_LOGIN_COMMAND).toEqual({ claude: "claude auth login", codex: "codex login" });
  });

  it("the boundary note says oort does not read the login", () => {
    expect(AI_CONNECT_BOUNDARY_NOTE).toContain("로그인 정보를 읽거나 옮기지 않아요");
  });
});

describe("연결 명령", () => {
  const endpoint = "https://team.example.com/v1/mcp/agent-port";
  const token = "momo_pair_v1.abcDEF-123_x";

  it("builds the Claude Code user-scope MCP command with the pairing bearer", () => {
    expect(subscriptionConnectPlan("claude", endpoint, token)).toEqual({
      kind: "command",
      command: `claude mcp add --scope user --transport http oort ${endpoint} --header "Authorization: Bearer ${token}"`,
    });
  });

  it("gives Codex two fields: codex mcp add has no header flag", () => {
    expect(subscriptionConnectPlan("codex", endpoint, token)).toEqual({
      kind: "fields",
      endpoint,
      credential: token,
    });
  });

  it("refuses to build a command around shell metacharacters", () => {
    for (const bad of ['a"; rm -rf ~', "a$(id)", "a`id`", "a b", "a;b", "a|b"]) {
      expect(subscriptionConnectPlan("claude", endpoint, bad).kind).toBe("fields");
    }
    expect(subscriptionConnectPlan("claude", `${endpoint}?x=$(id)`, token).kind).toBe(
      "fields"
    );
  });
});

describe("구독 에이전트 정체성", () => {
  it("names the agent after its owner and picks a free handle", () => {
    expect(
      subscriptionAgentIdentity("claude", { displayName: "성재", handle: "seongjae" }, new Set())
    ).toEqual({ displayName: "성재의 Claude", handle: "seongjae-claude" });
    expect(
      subscriptionAgentIdentity(
        "codex",
        { displayName: "성재", handle: "seongjae" },
        new Set(["seongjae-codex", "seongjae-codex-2"])
      )
    ).toEqual({ displayName: "성재의 Codex", handle: "seongjae-codex-3" });
  });

  it("keeps the handle within the server rule", () => {
    const { handle } = subscriptionAgentIdentity(
      "claude",
      { displayName: "x", handle: "a".repeat(40) },
      new Set()
    );
    expect(handle.length).toBeLessThanOrEqual(32);
    expect(handle).toMatch(/^[a-z0-9_-]{2,32}$/);
  });

  it("joined line reads naturally", () => {
    expect(joinJoinedLine("성재의 Claude")).toBe("성재의 Claude가 들어왔어요.");
    expect(aiConnectFoundLine("claude")).toBe("이 맥에서 Claude Code를 찾았어요.");
  });
});

describe("409 분류 (서버 문장은 그리지 않고 분류만)", () => {
  it("tells the kill switch from a taken handle", () => {
    expect(classifyJoinConflict("subscription agents are disabled on this server")).toBe(
      "subscription-off"
    );
    expect(classifyJoinConflict("agent handle already exists")).toBe("handle-taken");
    expect(classifyJoinConflict("HTTP 409")).toBe("other");
  });
});

describe("서버 필드 계약 (openapi HostedAgentConnection, #2815)", () => {
  const base = {
    id: "c1",
    agentMemberId: "m1",
    status: "pairing_pending",
    authMode: "static_bearer",
    audience: "/v1/mcp/agent-port",
    approvedChannelIds: [],
    approvedScopes: [],
    createdAtMs: 1,
    updatedAtMs: 1,
  };

  it("maps the harness row ids to the server enum", () => {
    expect(SUBSCRIPTION_HARNESS_WIRE).toEqual({ claude: "claude_code", codex: "codex" });
  });

  it("reads invocationScope and subscriptionHarness", () => {
    expect(
      toHostedConnection({
        ...base,
        invocationScope: "owner_only",
        subscriptionHarness: "claude_code",
      })
    ).toMatchObject({ invocationScope: "owner_only", subscriptionHarness: "claude_code" });
  });

  it("drops unknown values instead of inventing a scope", () => {
    const row = toHostedConnection({
      ...base,
      invocationScope: "everyone",
      subscriptionHarness: "claude-code",
    });
    expect(row).not.toBeNull();
    expect(row).not.toHaveProperty("invocationScope");
    expect(row).not.toHaveProperty("subscriptionHarness");
  });
});

describe("줄 문구", () => {
  it("matches the mockup rows and primary labels", () => {
    expect(AI_CONNECT_ROW_COPY.claude.title).toBe("Claude Code · 내 구독");
    expect(AI_CONNECT_ROW_COPY["api-key"].title).toBe("API 키 · 팀 에이전트");
    expect(primaryActionLabel("claude")).toBe("Claude Code를 내 에이전트로");
    expect(primaryActionLabel(null)).toBe("계속");
  });
});

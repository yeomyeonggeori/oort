import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@momo/core/lib/api";
import { createRegisterController, type RegisterDeps } from "./registerController";

// 확인 단계가 건너뛰어지지 않고, 연결 값이 argv 자리(셸 요청)와 로그 말고는 어디에도
// 나가지 않으며, 차분한 거절이 오류 단계로 읽히지 않는지를 가짜 서버·가짜 셸로 잰다.

const AGENT_ID = "0A1B2C3D-4E5F-4A6B-8C7D-9E0F1A2B3C4D";
const VALUE = "pairing-FAKE3389VALUE.zzzzzzzzzzzz";
const ENDPOINT = "https://oort.example.test/v1/mcp/agent-port";

function wire(overrides: Record<string, unknown> = {}) {
  return {
    agent: { id: AGENT_ID, handle: "kim-claude", displayName: "김-claude" },
    connection: {
      id: "c1",
      agentMemberId: AGENT_ID,
      status: "pairing_pending",
      authMode: "static_bearer",
      audience: "/v1/mcp/agent-port",
      approvedChannelIds: [],
      approvedScopes: [],
      createdAtMs: 1,
      updatedAtMs: 1,
      invocationScope: "owner_only",
      subscriptionHarness: "claude_code",
    },
    reused: false,
    pairingCredential: VALUE,
    pairingExpiresAtMs: 9_999_999_999_999,
    ...overrides,
  };
}

function deps(over: Partial<RegisterDeps> = {}) {
  const calls = { register: vi.fn(), device: vi.fn(), connect: vi.fn() };
  const d: RegisterDeps = {
    register: async (body) => {
      calls.register(body);
      return wire();
    },
    device: async () => {
      calls.device();
      return { deviceId: "oort-abcdef0123456789", deviceLabel: "mbp" };
    },
    connect: async (request) => {
      calls.connect(request);
      return { outcome: "connected" as const };
    },
    endpoint: () => ENDPOINT,
    ...over,
  };
  return { d, calls };
}

afterEach(() => vi.restoreAllMocks());

describe("확인 단계는 건너뛸 수 없다", () => {
  it("만들거나 이름을 만져도 submit 전에는 서버도 셸도 부르지 않는다", () => {
    const { d, calls } = deps();
    const c = createRegisterController("claude", "kim-claude", d);
    c.setHandle("kim-bot");
    c.setHandle("kim-claude");
    expect(c.getState().step).toEqual({ step: "confirm" });
    expect(calls.register).not.toHaveBeenCalled();
    expect(calls.device).not.toHaveBeenCalled();
    expect(calls.connect).not.toHaveBeenCalled();
  });

  it("이름 문제가 있으면 submit도 서버를 부르지 않고 확인 단계에 남는다", async () => {
    const { d, calls } = deps();
    const c = createRegisterController("claude", "kim-claude", d);
    c.setHandle("성재 봇");
    await c.submit();
    expect(c.getState().step.step).toBe("confirm");
    expect((c.getState().step as { problem?: string }).problem).toBeTruthy();
    expect(calls.register).not.toHaveBeenCalled();
  });
});

describe("Claude: 등록 → 앱이 CLI 연결 → 끝", () => {
  it("기본 이름이면 handle 없이 등록하고, 연결 값은 셸에만 건넨다", async () => {
    const { d, calls } = deps();
    const c = createRegisterController("claude", "kim-claude", d);
    await c.submit();
    expect(calls.register).toHaveBeenCalledWith({
      harness: "claude_code",
      deviceId: "oort-abcdef0123456789",
      deviceLabel: "mbp",
    });
    expect(calls.connect).toHaveBeenCalledWith({
      harness: "claude",
      endpoint: ENDPOINT,
      agentId: AGENT_ID.toLowerCase(),
      credential: VALUE,
    });
    expect(c.getState().step).toEqual({
      step: "done",
      handle: "kim-claude",
      displayName: "김-claude",
    });
    // 끝난 뒤 상태 어디에도 값이 없다.
    expect(JSON.stringify(c.getState())).not.toContain("FAKE3389");
    expect(c.getState().plan).toBeNull();
  });

  it("이름을 고쳤으면 그 handle을 보낸다", async () => {
    const { d, calls } = deps();
    const c = createRegisterController("claude", "kim-claude", d);
    c.setHandle("@SJ-Bot");
    await c.submit();
    expect(calls.register.mock.calls[0]![0].handle).toBe("sj-bot");
  });

  it("셸이 연결하지 못하면 수동 단계로 가고, 값을 다른 길로 보내지 않는다", async () => {
    const { d, calls } = deps({
      connect: async (request) => {
        calls.connect(request);
        return { outcome: "manual" as const, reason: "cli_failed" as const };
      },
    });
    const c = createRegisterController("claude", "kim-claude", d);
    await c.submit();
    expect(calls.connect).toHaveBeenCalledTimes(1);
    const state = c.getState();
    expect(state.step).toEqual({ step: "manual", handle: "kim-claude", why: "cli-failed" });
    // 수동 명령은 사람이 붙여 넣는 것이다(앱 실행이 아니다).
    expect(state.plan?.kind).toBe("command");
    c.dispose();
    expect(c.getState().plan).toBeNull();
  });

  it("CLI가 없으면 그 까닭으로 수동 단계", async () => {
    const { d } = deps({ connect: async () => ({ outcome: "manual", reason: "cli_missing" }) });
    const c = createRegisterController("claude", "kim-claude", d);
    await c.submit();
    expect(c.getState().step).toMatchObject({ step: "manual", why: "cli-missing" });
  });

  it("값 없이 재사용된 에이전트는 이미 있음이고 셸을 부르지 않는다", async () => {
    const { d, calls } = deps({
      register: async () => {
        const w = wire({ reused: true });
        delete (w as Record<string, unknown>).pairingCredential;
        delete (w as Record<string, unknown>).pairingExpiresAtMs;
        return w;
      },
    });
    const c = createRegisterController("claude", "kim-claude", d);
    await c.submit();
    expect(c.getState().step).toEqual({ step: "existing", handle: "kim-claude" });
    expect(calls.connect).not.toHaveBeenCalled();
  });
});

describe("Codex: 등록하되 연결은 두 칸 수동", () => {
  it("셸을 부르지 않고 주소·연결 값 두 칸을 같은 단계에서 준다", async () => {
    const { d, calls } = deps({
      register: async () =>
        wire({
          connection: {
            ...wire().connection,
            subscriptionHarness: "codex",
          },
        }),
    });
    const c = createRegisterController("codex", "kim-codex", d);
    await c.submit();
    expect(calls.connect).not.toHaveBeenCalled();
    const state = c.getState();
    expect(state.step).toEqual({ step: "manual", handle: "kim-claude", why: "codex" });
    expect(state.plan).toEqual({ kind: "fields", endpoint: ENDPOINT, credential: VALUE });
  });
});

describe("차분한 거절", () => {
  it.each([
    ["claude_subscription_agent_paused", "paused"],
    ["subscription_agents_disabled", "disabled"],
  ] as const)("%s 는 오류 단계가 아니라 calm이다", async (code, refusal) => {
    const { d, calls } = deps({
      register: async () => {
        throw new ApiError(409, "english sentence", code);
      },
    });
    const c = createRegisterController("claude", "kim-claude", d);
    await c.submit();
    expect(c.getState().step).toEqual({ step: "calm", refusal });
    expect(c.getState().reason).toBeNull();
    expect(calls.connect).not.toHaveBeenCalled();
  });

  it("권한 없음(403)도 calm", async () => {
    const { d } = deps({
      register: async () => {
        throw new ApiError(403, "forbidden");
      },
    });
    const c = createRegisterController("claude", "kim-claude", d);
    await c.submit();
    expect(c.getState().step).toEqual({ step: "calm", refusal: "forbidden" });
  });

  it("직접 정한 이름이 겹치면(코드 없는 409) 이름 칸으로 돌아간다", async () => {
    const { d } = deps({
      register: async () => {
        throw new ApiError(409, "agent handle already exists");
      },
    });
    const c = createRegisterController("claude", "kim-claude", d);
    c.setHandle("taken");
    await c.submit();
    expect(c.getState().step.step).toBe("confirm");
    expect(c.getState().handle).toBe("taken");
  });

  it("그 밖의 서버 오류만 실패 단계이고, 다시 시도할 수 있다", async () => {
    let n = 0;
    const { d, calls } = deps({
      register: async () => {
        n += 1;
        if (n === 1) throw new ApiError(500, "boom");
        return wire();
      },
    });
    const c = createRegisterController("claude", "kim-claude", d);
    await c.submit();
    expect(c.getState().step.step).toBe("failed");
    await c.submit();
    expect(c.getState().step.step).toBe("done");
    expect(calls.connect).toHaveBeenCalledTimes(1);
  });
});

describe("값은 어디에도 기록되지 않는다", () => {
  it("콘솔에 아무것도 쓰지 않는다(성공·수동·실패 모두)", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((k) =>
      vi.spyOn(console, k).mockImplementation(() => undefined)
    );
    for (const connect of [
      async () => ({ outcome: "connected" as const }),
      async () => ({ outcome: "manual" as const, reason: "cli_failed" as const }),
    ]) {
      const { d } = deps({ connect });
      const c = createRegisterController("claude", "kim-claude", d);
      await c.submit();
      c.dispose();
    }
    const { d } = deps({
      register: async () => {
        throw new ApiError(500, `leaky ${VALUE}`);
      },
    });
    const c = createRegisterController("claude", "kim-claude", d);
    await c.submit();
    // 서버 문장은 화면 까닭에 올라가지 않는다.
    expect(JSON.stringify(c.getState())).not.toContain("leaky");
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it("소스에 저장소·로그 호출이 없다", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(new URL("./registerController.ts", import.meta.url), "utf8");
    for (const needle of [
      "console.",
      "localStorage",
      "sessionStorage",
      "indexedDB",
      "postMessage",
    ]) {
      expect(src.includes(needle), needle).toBe(false);
    }
  });
});

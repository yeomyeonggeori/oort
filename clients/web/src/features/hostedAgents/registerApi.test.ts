import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@momo/core/lib/api";
import { registerSubscriptionAgent } from "@momo/core/features/hostedAgents/api";
import { parseRegisteredSubscriptionAgent } from "@momo/core/features/hostedAgents/model";
import { classifyRegisterFailure } from "@momo/core/features/onboarding/subscriptionRegister";

vi.mock("@momo/core/runtime/host", () => ({
  apiBase: () => "https://oort.example.test",
  coreSession: () => ({ getAccessToken: () => "access-token" }),
}));

afterEach(() => vi.unstubAllGlobals());

function stubFetch(status: number, body: unknown) {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      })
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("registerSubscriptionAgent", () => {
  it("엔드포인트·본문·no-store, 서버의 error.code가 ApiError까지 온다", async () => {
    const fetchMock = stubFetch(409, {
      error: {
        code: "claude_subscription_agent_paused",
        message: "claude subscription agents are paused on this server",
      },
    });
    const error = await registerSubscriptionAgent("ws-1", {
      harness: "claude_code",
      deviceId: "oort-abcdef0123456789",
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("claude_subscription_agent_paused");
    expect(classifyRegisterFailure(error)).toBe("paused");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://oort.example.test/v1/workspaces/ws-1/subscription-agents/register");
    expect(init.method).toBe("POST");
    expect(init.cache).toBe("no-store");
    expect(JSON.parse(init.body as string)).toEqual({
      harness: "claude_code",
      deviceId: "oort-abcdef0123456789",
    });
  });
});

describe("parseRegisteredSubscriptionAgent", () => {
  const connection = {
    id: "c1",
    agentMemberId: "A1",
    status: "pairing_pending",
    authMode: "static_bearer",
    audience: "/v1/mcp/agent-port",
    approvedChannelIds: [],
    approvedScopes: [],
    createdAtMs: 1,
    updatedAtMs: 1,
  };
  it("값이 있으면 읽고, 없으면 값 없이 읽는다", () => {
    const row = {
      agent: { id: "a1", handle: "kim-claude", displayName: "kim-claude" },
      connection,
      reused: false,
      pairingCredential: "v".repeat(20),
      pairingExpiresAtMs: 5,
    };
    expect(parseRegisteredSubscriptionAgent(row).pairingCredential).toBe("v".repeat(20));
    const { pairingCredential: _a, pairingExpiresAtMs: _b, ...bare } = row;
    expect(parseRegisteredSubscriptionAgent({ ...bare, reused: true }).pairingCredential).toBeUndefined();
  });
  it("다른 에이전트의 연결이거나 모양이 틀리면 던진다", () => {
    const base = {
      agent: { id: "zzz", handle: "h", displayName: "d" },
      connection,
      reused: false,
    };
    expect(() => parseRegisteredSubscriptionAgent(base)).toThrow();
    expect(() => parseRegisteredSubscriptionAgent({ ...base, agent: { id: "a1" } })).toThrow();
    expect(() => parseRegisteredSubscriptionAgent(null)).toThrow();
  });
});

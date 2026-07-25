import { beforeEach, describe, expect, it, vi } from "vitest";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

const loginBody = {
  accessToken: "access-old",
  refreshToken: "refresh-old",
  realtimeWebSocketUrl: "wss://rt.example.com/connection/websocket",
  member: {
    id: "00000000-0000-0000-0000-000000000001",
    workspaceId: "00000000-0000-0000-0000-000000000002",
    kind: "human" as const,
    displayName: "곽성재",
    handle: "sj",
  },
};

describe("authorized request token rotation", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal("localStorage", memoryStorage());
    localStorage.setItem("momo.web.server-url.v1", "https://momo.example.com");
  });

  it("retries one 401 after rotating the refresh token", async () => {
    const calls: Array<{ url: string; authorization: string | null }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const authorization = new Headers(init?.headers).get("Authorization");
      calls.push({ url, authorization });
      if (url.endsWith("/v1/auth/login")) {
        return Response.json(loginBody);
      }
      if (url.endsWith("/v1/auth/refresh")) {
        return Response.json({
          accessToken: "access-new",
          refreshToken: "refresh-new",
        });
      }
      if (calls.filter((call) => call.url.includes("/channels")).length === 1) {
        return new Response(null, { status: 401 });
      }
      return Response.json({ channels: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = await import("./client");
    await client.login("sj@example.com", "password");
    await client.listChannels(loginBody.member.workspaceId);

    const channelCalls = calls.filter((call) => call.url.includes("/channels"));
    expect(channelCalls).toHaveLength(2);
    expect(channelCalls.map((call) => call.authorization)).toEqual([
      "Bearer access-old",
      "Bearer access-new",
    ]);
    expect(calls.filter((call) => call.url.endsWith("/v1/auth/refresh"))).toHaveLength(1);
  });

  it("does not retry a second 401", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/v1/auth/login")) return Response.json(loginBody);
      if (url.endsWith("/v1/auth/refresh")) {
        return Response.json({ accessToken: "access-new", refreshToken: "refresh-new" });
      }
      return new Response(null, { status: 401 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = await import("./client");
    await client.login("sj@example.com", "password");
    await expect(client.listChannels(loginBody.member.workspaceId)).rejects.toMatchObject({
      status: 401,
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});

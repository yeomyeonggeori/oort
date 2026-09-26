import { afterEach, describe, expect, it, vi } from "vitest";
import { installCoreHost, resetCoreHost, type SessionPort } from "../../runtime/host";
import { fetchWorkspace, renameWorkspace, type WorkspaceIdentity } from "./api";

function installHost(): void {
  const session: SessionPort = {
    getAccessToken: () => "access-token",
    getRefreshToken: () => null,
    getPersistedSession: () => null,
    applyLogin: () => {},
    applyRotation: () => {},
    markAuthExpired: () => {},
    clearSession: () => {},
  };
  installCoreHost({
    apiBase: () => "https://oort.test",
    absoluteApiBase: () => "https://oort.test",
    buildMode: () => "test",
    session,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetCoreHost();
});

const WS = "00000000-0000-7000-8000-000000000001";
const WORKSPACE: WorkspaceIdentity = {
  id: WS,
  slug: "demo",
  name: "내 팀",
  updatedAtMs: 1_700_000_000_123,
  roleLabels: {},
  welcomeAgentMemberId: null,
  welcomePrompt: "",
  subscriptionAgentsEnabled: false,
};

describe("renameWorkspace", () => {
  it("PATCHes with name and updatedAtMs and returns the GET envelope", async () => {
    installHost();
    const renamed = { ...WORKSPACE, name: "새 이름", updatedAtMs: 1_700_000_000_999 };
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ workspace: renamed }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(renameWorkspace(WS, "새 이름", WORKSPACE.updatedAtMs)).resolves.toEqual(
      renamed
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      `https://oort.test/v1/workspaces/${WS}`,
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ name: "새 이름", updatedAtMs: WORKSPACE.updatedAtMs }),
      })
    );
  });

  it("surfaces stale 409", async () => {
    installHost();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: { message: "workspace has been updated; refetch and retry" },
            }),
            { status: 409, headers: { "content-type": "application/json" } }
          )
      )
    );

    await expect(renameWorkspace(WS, "새 이름", 1)).rejects.toMatchObject({
      name: "ApiError",
      status: 409,
      message: "workspace has been updated; refetch and retry",
    });
  });
});

describe("fetchWorkspace", () => {
  it("GETs the identity envelope the rename token lives on", async () => {
    installHost();
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ workspace: WORKSPACE }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchWorkspace(WS)).resolves.toEqual(WORKSPACE);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `https://oort.test/v1/workspaces/${WS}`
    );
  });
});

describe("fetchWorkspace · subscriptionAgentsEnabled (ADR-0193 D6, #2814)", () => {
  async function fetchWith(extra: Record<string, unknown>) {
    installHost();
    const { subscriptionAgentsEnabled: _omit, ...rest } = WORKSPACE;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ workspace: { ...rest, ...extra } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
      )
    );
    return fetchWorkspace(WS);
  }

  it("is true only when the server says true", async () => {
    await expect(fetchWith({ subscriptionAgentsEnabled: true })).resolves.toMatchObject({
      subscriptionAgentsEnabled: true,
    });
  });

  it("reads an absent field (a server before #2815) as off", async () => {
    await expect(fetchWith({})).resolves.toMatchObject({ subscriptionAgentsEnabled: false });
  });

  it("reads a non-boolean as off", async () => {
    await expect(fetchWith({ subscriptionAgentsEnabled: "true" })).resolves.toMatchObject({
      subscriptionAgentsEnabled: false,
    });
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { installCoreHost, resetCoreHost, type SessionPort } from "../runtime/host";
import { changeMyDisplayName, memberFromWire } from "./api";
import { WireShapeError } from "./wire";

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
const MEMBER = {
  id: "00000000-0000-7000-8000-000000000101",
  workspaceId: WS,
  kind: "human" as const,
  displayName: "성재",
  handle: "seongjae",
};

describe("memberFromWire", () => {
  it("reads the login Member shape", () => {
    expect(memberFromWire(MEMBER)).toEqual(MEMBER);
  });

  it("refuses a body without member fields", () => {
    expect(() => memberFromWire({ displayName: "성재" })).toThrow(WireShapeError);
  });
});

describe("changeMyDisplayName", () => {
  it("PATCHes members/me once and returns the member envelope", async () => {
    installHost();
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ member: MEMBER }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(changeMyDisplayName(WS, "성재")).resolves.toEqual(MEMBER);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      `https://oort.test/v1/workspaces/${WS}/members/me`,
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ displayName: "성재" }),
      })
    );
  });

  it("surfaces the join 400 sentence", async () => {
    installHost();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: { message: "displayName is required" } }),
            { status: 400, headers: { "content-type": "application/json" } }
          )
      )
    );

    await expect(changeMyDisplayName(WS, "  ")).rejects.toMatchObject({
      name: "ApiError",
      status: 400,
      message: "displayName is required",
    });
  });
});

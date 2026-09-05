import { afterEach, describe, expect, it, vi } from "vitest";
import { installCoreHost, resetCoreHost, type SessionPort } from "../runtime/host";
import { joinWithInvite } from "./api";
import { WireShapeError } from "./wire";

function installHost(): SessionPort {
  const session: SessionPort = {
    getAccessToken: () => null,
    getRefreshToken: () => null,
    getPersistedSession: () => null,
    applyLogin: vi.fn(),
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
  return session;
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetCoreHost();
});

const MEMBER = {
  id: "00000000-0000-7000-8000-000000000101",
  workspaceId: "00000000-0000-7000-8000-000000000001",
  kind: "human" as const,
  displayName: "Seongjae",
  handle: "seongjae",
};

const LOGIN_WIRE = {
  accessToken: "access",
  refreshToken: "refresh",
  realtimeWebSocketUrl: "wss://oort.test/connection/websocket",
  member: MEMBER,
};

describe("joinWithInvite createdMember", () => {
  it("hands createdMember: true through to the caller", async () => {
    const host = installHost();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ...LOGIN_WIRE, createdMember: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
      )
    );

    const result = await joinWithInvite("Ab3-_x", "seongjae@dawn.example", "new-pass");
    expect(result.createdMember).toBe(true);
    expect(result.member).toEqual(MEMBER);
    expect(host.applyLogin).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: "access", member: MEMBER })
    );
  });

  it("hands createdMember: false through to the caller", async () => {
    installHost();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ...LOGIN_WIRE, createdMember: false }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
      )
    );

    const result = await joinWithInvite("Ab3-_x", "seongjae@dawn.example", "new-pass");
    expect(result.createdMember).toBe(false);
  });

  it("refuses a non-boolean createdMember as a wire-shape failure", async () => {
    installHost();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ...LOGIN_WIRE, createdMember: "yes" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
      )
    );

    await expect(
      joinWithInvite("Ab3-_x", "seongjae@dawn.example", "new-pass")
    ).rejects.toBeInstanceOf(WireShapeError);
  });
});

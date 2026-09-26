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

describe("joinWithInvite displayName (ADR-0193 D7 초대 1화면, #2819)", () => {
  function captureBody(): { bodies: Array<Record<string, unknown>> } {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ ...LOGIN_WIRE, createdMember: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      })
    );
    return { bodies };
  }

  it("sends the name the person typed, trimmed", async () => {
    installHost();
    const { bodies } = captureBody();
    await joinWithInvite("Ab3-_x", "seongjae@dawn.example", "new-pass", "  지민 ");
    expect(bodies[0]?.displayName).toBe("지민");
    // The handle still comes from the email: the name is not an identifier.
    expect(bodies[0]?.handle).toBe("seongjae");
  });

  it("falls back to the email derivation when the name is blank or absent", async () => {
    installHost();
    const { bodies } = captureBody();
    await joinWithInvite("Ab3-_x", "jimin.kim@dawn.example", "new-pass", "   ");
    await joinWithInvite("Ab3-_x", "jimin.kim@dawn.example", "new-pass");
    expect(bodies.map((b) => b.displayName)).toEqual(["Jimin Kim", "Jimin Kim"]);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { installCoreHost, resetCoreHost, type SessionPort } from "../runtime/host";
import {
  changeWorkspaceMemberRole,
  workspaceMemberRoleFromWire,
} from "./api";
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
const MEMBER = "00000000-0000-7000-8000-0000000005d2";

describe("workspaceMemberRoleFromWire", () => {
  it("folds the member id and keeps the applied db role", () => {
    expect(
      workspaceMemberRoleFromWire({
        memberId: MEMBER.toUpperCase(),
        scope: "workspace",
        role: "admin",
      })
    ).toEqual({
      memberId: MEMBER,
      scope: "workspace",
      role: "admin",
    });
  });

  it("refuses a channel-scope body and an unknown role", () => {
    expect(() =>
      workspaceMemberRoleFromWire({
        memberId: MEMBER,
        scope: "channel",
        role: "admin",
      })
    ).toThrow(WireShapeError);
    expect(() =>
      workspaceMemberRoleFromWire({
        memberId: MEMBER,
        scope: "workspace",
        role: "root",
      })
    ).toThrow(WireShapeError);
  });
});

describe("changeWorkspaceMemberRole", () => {
  it("PATCHes the workspace role path once with the requested body", async () => {
    installHost();
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          memberId: MEMBER,
          scope: "workspace",
          role: "admin",
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      changeWorkspaceMemberRole(WS, MEMBER, "admin")
    ).resolves.toEqual({
      memberId: MEMBER,
      scope: "workspace",
      role: "admin",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      `https://oort.test/v1/workspaces/${WS}/members/${MEMBER}/role`,
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ role: "admin" }),
      })
    );
  });
});

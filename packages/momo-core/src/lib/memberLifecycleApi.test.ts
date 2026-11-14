import { afterEach, describe, expect, it, vi } from "vitest";
import { installCoreHost, resetCoreHost, type SessionPort } from "../runtime/host";
import {
  reinstateWorkspaceMember,
  removeWorkspaceMember,
  suspendWorkspaceMember,
  workspaceMemberLifecycleFromWire,
} from "./api";
import { WireShapeError } from "./wire";

// #5781: 정지·정지 풀기·내보내기 호출이 서버 라우트(`routes/member_lifecycle.rs`)의 길·메서드·본문과 같다.

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

function answer(status: string) {
  return vi.fn(
    async () =>
      new Response(JSON.stringify({ memberId: MEMBER.toUpperCase(), status }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
  );
}

describe("workspaceMemberLifecycleFromWire", () => {
  it("folds the member id and keeps the server's new status", () => {
    expect(workspaceMemberLifecycleFromWire({ memberId: MEMBER.toUpperCase(), status: "suspended" })).toEqual({
      memberId: MEMBER,
      status: "suspended",
    });
  });

  it("refuses an unknown status or a missing id", () => {
    expect(() => workspaceMemberLifecycleFromWire({ memberId: MEMBER, status: "banned" })).toThrow(WireShapeError);
    expect(() => workspaceMemberLifecycleFromWire({ status: "active" })).toThrow(WireShapeError);
  });
});

describe("suspend · reinstate · remove", () => {
  it.each([
    ["suspend", () => suspendWorkspaceMember(WS, MEMBER), "suspended", `/members/${MEMBER}/suspend`, "POST", undefined],
    ["reinstate", () => reinstateWorkspaceMember(WS, MEMBER), "active", `/members/${MEMBER}/reinstate`, "POST", undefined],
    ["remove", () => removeWorkspaceMember(WS, MEMBER), "deleted", `/members/${MEMBER}`, "DELETE", JSON.stringify({ ban: false })],
  ] as const)("%s → %s %s", async (_name, call, status, path, method, body) => {
    installHost();
    const fetchMock = answer(status);
    vi.stubGlobal("fetch", fetchMock);
    await expect(call()).resolves.toEqual({ memberId: MEMBER, status });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      `https://oort.test/v1/workspaces/${WS}${path}`,
      expect.objectContaining(body === undefined ? { method } : { method, body })
    );
    if (body === undefined) {
      const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
      expect(init.body ?? undefined).toBeUndefined();
    }
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { installCoreHost, resetCoreHost, type SessionPort } from "../../runtime/host";
import { ApiError, killWorkSession } from "../../lib/api";
import {
  canStopSession,
  stopFailureLine,
  stopRequestedLine,
} from "./stopWork";

const WS = "00000000-0000-7000-8000-000000000001";
const SID = "00000000-0000-7000-8000-0000000000aa";
const ME = "00000000-0000-7000-8000-0000000000bb";

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

describe("killWorkSession", () => {
  it("POSTs the kill route with no body and no signature", async () => {
    installHost();
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            workControl: null,
            sessionStatus: "running",
            hostOnline: false,
            replayed: false,
          }),
          { status: 201, headers: { "content-type": "application/json" } }
        )
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(killWorkSession(WS, SID)).resolves.toEqual({
      sessionStatus: "running",
      hostOnline: false,
      replayed: false,
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`https://oort.test/v1/workspaces/${WS}/work-sessions/${SID}/kill`);
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).body).toBeUndefined();
  });

  it("surfaces the refusal code", async () => {
    installHost();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { code: "kill_owner_only", message: "x" } }), {
            status: 403,
            headers: { "content-type": "application/json" },
          })
      )
    );
    await expect(killWorkSession(WS, SID)).rejects.toMatchObject({
      status: 403,
      code: "kill_owner_only",
    });
  });
});

describe("canStopSession", () => {
  it("is true only for the owner of a running or idle session", () => {
    expect(canStopSession({ status: "running", memberId: ME }, ME.toUpperCase())).toBe(true);
    expect(canStopSession({ status: "idle", memberId: ME }, ME)).toBe(true);
    for (const status of ["ended", "orphaned", "unknown"]) {
      expect(canStopSession({ status, memberId: ME } as never, ME)).toBe(false);
    }
    expect(canStopSession({ status: "running", memberId: SID }, ME)).toBe(false);
  });
});

describe("copy", () => {
  it("tells an offline Mac apart from an online one", () => {
    expect(stopRequestedLine({ hostOnline: false })).toContain("맥이 켜지면 멈춰요");
    expect(stopRequestedLine({ hostOnline: true })).not.toContain("켜지면");
  });
  it("maps refusal codes to sentences", () => {
    expect(stopFailureLine(new ApiError(403, "m", "kill_owner_only"))).toContain("시작한 사람");
    expect(stopFailureLine(new Error("boom"))).toContain("다시 눌러");
  });
});

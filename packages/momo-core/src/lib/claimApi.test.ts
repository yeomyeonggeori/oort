import { afterEach, describe, expect, it, vi } from "vitest";
import { installCoreHost, resetCoreHost, type SessionPort } from "../runtime/host";
import { ApiError, ClaimApiError, claimOwnerPassword, parseClaimKind } from "./api";

// ADR-0215 D6 (#4603, #4601): `POST /v1/claim` says which kind of link it spent, on 200, 409 and 410 only.

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
  displayName: "Minsu",
  handle: "minsu",
};
const LOGIN_WIRE = {
  accessToken: "access",
  refreshToken: "refresh",
  realtimeWebSocketUrl: "wss://oort.test/connection/websocket",
  member: MEMBER,
};
const TOKEN = "A".repeat(43);

function answer(status: number, body: Record<string, unknown>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        })
    )
  );
}

describe("parseClaimKind", () => {
  it("knows the two kinds and nothing else", () => {
    expect(parseClaimKind("owner_bootstrap")).toBe("owner_bootstrap");
    expect(parseClaimKind("password_reset")).toBe("password_reset");
    for (const other of ["", "PASSWORD_RESET", "device_link", 7, null, undefined]) {
      expect(parseClaimKind(other)).toBeUndefined();
    }
  });
});

describe("claimOwnerPassword claimKind on 200", () => {
  it("hands the kind to the caller and keeps it out of the session store", async () => {
    const host = installHost();
    answer(200, { ...LOGIN_WIRE, claimKind: "password_reset" });
    const claimed = await claimOwnerPassword(TOKEN, "a-long-enough-password");
    expect(claimed.claimKind).toBe("password_reset");
    expect(host.applyLogin).toHaveBeenCalledTimes(1);
    const applied = (host.applyLogin as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Record<string, unknown>;
    expect(applied.accessToken).toBe("access");
    expect("claimKind" in applied).toBe(false);
  });

  it("leaves the kind absent for a server that does not say (older than E-4)", async () => {
    installHost();
    answer(200, LOGIN_WIRE);
    const claimed = await claimOwnerPassword(TOKEN, "a-long-enough-password");
    expect("claimKind" in claimed).toBe(false);
  });

  it("does not believe a kind it does not know", async () => {
    installHost();
    answer(200, { ...LOGIN_WIRE, claimKind: "device_link" });
    const claimed = await claimOwnerPassword(TOKEN, "a-long-enough-password");
    expect(claimed.claimKind).toBeUndefined();
  });
});

describe("claimOwnerPassword claimKind on a refusal", () => {
  for (const status of [409, 410]) {
    it(`reads the kind from a ${status}, beside the error envelope`, async () => {
      installHost();
      answer(status, { error: { message: "refused" }, claimKind: "password_reset" });
      const failure = await claimOwnerPassword(TOKEN, "pw").catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(ClaimApiError);
      expect(failure).toBeInstanceOf(ApiError);
      expect((failure as ClaimApiError).claimKind).toBe("password_reset");
      expect((failure as ClaimApiError).status).toBe(status);
    });

    it(`also reads the kind from inside the error envelope of a ${status}`, async () => {
      installHost();
      answer(status, { error: { message: "refused", claimKind: "owner_bootstrap" } });
      const failure = await claimOwnerPassword(TOKEN, "pw").catch((e: unknown) => e);
      expect((failure as ClaimApiError).claimKind).toBe("owner_bootstrap");
    });
  }

  it("keeps a plain ApiError when a 409 or 410 names no kind", async () => {
    installHost();
    answer(410, { error: { message: "expired" } });
    const failure = await claimOwnerPassword(TOKEN, "pw").catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).not.toBeInstanceOf(ClaimApiError);
  });

  it("does not believe a kind on 404, 400 or 429: those answer the same for every token", async () => {
    for (const status of [404, 400, 429]) {
      installHost();
      answer(status, { error: { message: "no" }, claimKind: "password_reset" });
      const failure = await claimOwnerPassword(TOKEN, "pw").catch((e: unknown) => e);
      expect(failure, String(status)).toBeInstanceOf(ApiError);
      expect(failure, String(status)).not.toBeInstanceOf(ClaimApiError);
      resetCoreHost();
    }
  });
});

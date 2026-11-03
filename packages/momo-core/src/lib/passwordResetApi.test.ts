import { afterEach, describe, expect, it, vi } from "vitest";
import { installCoreHost, resetCoreHost, type SessionPort } from "../runtime/host";
import {
  ApiError,
  issueMemberPasswordReset,
  passwordResetIssueFromWire,
} from "./api";
import { WireShapeError } from "./wire";

// ADR-0215 D6 (#4603): 관리자 재설정 링크 발급. 서버는 E-4(#4596) 전에는 `claimUrl`을 주지 않고,
// 뒤에는 준다. 두 모양을 모두 받는다.

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
    apiBase: () => "https://oort.test/momo",
    absoluteApiBase: () => "https://oort.test/momo",
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
const TOKEN = "T".repeat(43);
const EXPIRES = 1_800_000_000_000;

function created(body: Record<string, unknown>, status = 201): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("issueMemberPasswordReset request", () => {
  it("posts the administrator's own password as typed, to the member's route", async () => {
    installHost();
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return created({
          token: TOKEN,
          kind: "password_reset",
          expiresAtMs: EXPIRES,
          claimPath: `/claim/${TOKEN}`,
          claimUrl: `https://team.example.com/claim/${TOKEN}`,
          claimUrlSecure: true,
        });
      })
    );
    // Leading/trailing spaces are part of a password: it is sent byte for byte, never trimmed.
    await issueMemberPasswordReset(WS, MEMBER, "  내 비밀번호 Pass1  ");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`https://oort.test/momo/v1/workspaces/${WS}/members/${MEMBER}/password-reset`);
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ currentPassword: "  내 비밀번호 Pass1  " });
  });

  it("returns the server's claimUrl and never hands the raw token out on its own", async () => {
    installHost();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        created({
          token: TOKEN,
          kind: "password_reset",
          expiresAtMs: EXPIRES,
          claimPath: `/claim/${TOKEN}`,
          claimUrl: `https://team.example.com/claim/${TOKEN}`,
          claimUrlSecure: false,
        })
      )
    );
    const issue = await issueMemberPasswordReset(WS, MEMBER, "pw");
    expect(issue).toEqual({
      claimUrl: `https://team.example.com/claim/${TOKEN}`,
      claimUrlSecure: false,
      expiresAtMs: EXPIRES,
    });
    expect(Object.keys(issue).sort()).toEqual(["claimUrl", "claimUrlSecure", "expiresAtMs"]);
  });

  it("lets the error code through: the wrong password is a 403 with its own code", async () => {
    installHost();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        created({ error: { code: "current_password_incorrect", message: "current password is incorrect" } }, 403)
      )
    );
    const failure = await issueMemberPasswordReset(WS, MEMBER, "wrong").catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(403);
    expect((failure as ApiError).code).toBe("current_password_incorrect");
  });
});

describe("passwordResetIssueFromWire", () => {
  const base = "https://oort.test/momo";

  it("prefers the server's absolute claimUrl over anything this client could build", () => {
    const issue = passwordResetIssueFromWire(
      {
        expiresAtMs: EXPIRES,
        claimPath: `/claim/${TOKEN}`,
        claimUrl: `https://public.example.org/claim/${TOKEN}`,
      },
      base
    );
    expect(issue.claimUrl).toBe(`https://public.example.org/claim/${TOKEN}`);
    // The server did not say whether the address is shareable: that stays unknown, never "true".
    expect(issue.claimUrlSecure).toBeUndefined();
  });

  it("builds the link from claimPath on the server's origin for a server older than E-4", () => {
    const issue = passwordResetIssueFromWire({ expiresAtMs: EXPIRES, claimPath: `/claim/${TOKEN}` }, base);
    // The claim page is served at the origin root, not under an API path prefix.
    expect(issue.claimUrl).toBe(`https://oort.test/claim/${TOKEN}`);
  });

  it("does not trust a claimUrl that is not an absolute http(s) address", () => {
    for (const claimUrl of ["/claim/x", "javascript:alert(1)", "ftp://x.example/claim/a", "", 7]) {
      const issue = passwordResetIssueFromWire(
        { expiresAtMs: EXPIRES, claimPath: `/claim/${TOKEN}`, claimUrl },
        base
      );
      expect(issue.claimUrl).toBe(`https://oort.test/claim/${TOKEN}`);
    }
  });

  it("refuses a body without an expiry or a claim path, and a path that is not the claim route", () => {
    expect(() => passwordResetIssueFromWire({ claimPath: `/claim/${TOKEN}` }, base)).toThrow(WireShapeError);
    expect(() => passwordResetIssueFromWire({ expiresAtMs: EXPIRES }, base)).toThrow(WireShapeError);
    expect(() =>
      passwordResetIssueFromWire({ expiresAtMs: EXPIRES, claimPath: "//evil.example/claim/a" }, base)
    ).toThrow(WireShapeError);
    expect(() =>
      passwordResetIssueFromWire({ expiresAtMs: EXPIRES, claimPath: "/members/me" }, base)
    ).toThrow(WireShapeError);
  });
});

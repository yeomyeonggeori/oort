import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api";
import {
  buildInviteMailto,
  buildJoinLink,
  choiceLabel,
  errorMessage,
  formatDay,
  INVITE_ROLES,
  inviteCardText,
  inviteStatus,
  isOperatorDenied,
  isSlugConflict,
  maskedBearer,
  normalizeSlug,
  percentEncode,
  PROVIDER_MODES,
  providerSourceLabel,
  providerTestMessage,
  slugError,
  WORK_ENGINES,
  workspaceNameError,
} from "./model";

// The values asserted here were taken from live momowebqa round trips against
// the real routes (ProviderLinkRoutes / WorkHostEngineRoutes / WorkspaceRoutes /
// InviteRoutes), so a server-side rule change breaks a test rather than a user.

describe("momo://join deep link (docs/onboarding-deeplink.md)", () => {
  const CODE = "vBca_VjT8-uPMgUV52QOQmKBvGBIFRAc"; // base64url, as issued

  it("percent-encodes the server base URL and keeps the code verbatim", () => {
    expect(buildJoinLink("https://api.example.com", CODE)).toBe(
      `momo://join?server=https%3A%2F%2Fapi.example.com&code=${CODE}`
    );
  });

  it("encodes the port separator too", () => {
    expect(buildJoinLink("http://127.0.0.1:28000", "abc")).toBe(
      "momo://join?server=http%3A%2F%2F127.0.0.1%3A28000&code=abc"
    );
  });

  it("emits only the two contract parameters, server first", () => {
    const url = new URL(buildJoinLink("https://api.example.com", CODE));
    expect(url.protocol).toBe("momo:");
    expect([...url.searchParams.keys()]).toEqual(["server", "code"]);
    expect(url.searchParams.get("server")).toBe("https://api.example.com");
    expect(url.searchParams.get("code")).toBe(CODE);
  });

  it("encodes the RFC 3986 characters encodeURIComponent leaves alone", () => {
    expect(percentEncode("a!b'c(d)e*f")).toBe("a%21b%27c%28d%29e%2Af");
    expect(percentEncode("aA0-._~")).toBe("aA0-._~");
  });

  it("survives a base URL with a path and a trailing query-unsafe char", () => {
    const link = buildJoinLink("https://momo.example.com/api v1", "x-y_z");
    expect(new URL(link).searchParams.get("server")).toBe(
      "https://momo.example.com/api v1"
    );
  });
});

describe("invite card and mail draft", () => {
  const card = {
    workspaceName: "momo Demo Workspace",
    serverBaseUrl: "https://api.example.com",
    code: "vBca_VjT8-uPMgUV52QOQmKBvGBIFRAc",
    expiresAtMs: new Date(2026, 7, 1, 9, 0, 0).getTime(),
    maxUses: 1,
  };

  it("leads with the deep link and keeps the manual fallback", () => {
    const text = inviteCardText(card);
    expect(text).toContain(buildJoinLink(card.serverBaseUrl, card.code));
    expect(text).toContain("서버 주소: https://api.example.com");
    expect(text).toContain("초대 코드: " + card.code);
    expect(text).toContain("2026-08-01");
    expect(text).toContain("1명");
  });

  it("carries no em-dash into user-visible copy", () => {
    expect(inviteCardText(card)).not.toMatch(/[–—]/);
  });

  it("builds a mailto with no recipient and the card as the body", () => {
    const mailto = buildInviteMailto(card);
    expect(mailto.startsWith("mailto:?subject=")).toBe(true);
    const query = mailto.slice("mailto:?".length);
    const params = new URLSearchParams(query);
    expect(params.get("subject")).toBe("momo Demo Workspace 워크스페이스 초대");
    expect(params.get("body")).toBe(inviteCardText(card));
  });
});

describe("workspace input rules (WorkspaceRoutes.normalizedSlug/Name)", () => {
  it("accepts what the server accepts", () => {
    expect(slugError("momoqa-601")).toBeNull();
    expect(slugError("  Demo  ")).toBeNull();
    expect(slugError("a")).toBeNull();
    expect(normalizeSlug("  Demo  ")).toBe("demo");
  });

  it("rejects the shapes the server answered 400 for", () => {
    expect(slugError("-Bad Slug-")).not.toBeNull();
    expect(slugError("trailing-")).not.toBeNull();
    expect(slugError("-leading")).not.toBeNull();
    expect(slugError("엔진팀")).not.toBeNull();
    expect(slugError("")).not.toBeNull();
    expect(slugError("a".repeat(64))).not.toBeNull();
    expect(slugError("a".repeat(63))).toBeNull();
  });

  it("bounds the display name at 1 to 80 characters", () => {
    expect(workspaceNameError("설정 셸 QA")).toBeNull();
    expect(workspaceNameError("   ")).not.toBeNull();
    expect(workspaceNameError("가".repeat(80))).toBeNull();
    expect(workspaceNameError("가".repeat(81))).not.toBeNull();
    expect(workspaceNameError("줄\n바꿈")).not.toBeNull();
  });
});

describe("provider link presentation (ADR-0004 write-only bearer)", () => {
  it("shows only the stored tail, never a full key", () => {
    expect(maskedBearer("9f3a")).toBe("••••9f3a");
    expect(maskedBearer(undefined)).toBe("저장된 키 없음");
  });

  it("names where the effective config came from", () => {
    expect(providerSourceLabel("database")).toBe("이 서버에 저장됨");
    expect(providerSourceLabel("environment")).toBe("서버 환경값 사용 중");
  });

  it("turns each probe reason into a next step", () => {
    expect(
      providerTestMessage({ ok: true, endpointLabel: "https://api.example.com/v1" })
    ).toContain("응답을 확인했습니다");

    const unreachable = providerTestMessage({
      ok: false,
      reason: "provider_unreachable",
      endpointLabel: "https://api.example.com/v1",
    });
    expect(unreachable).toContain("https://api.example.com/v1");
    expect(unreachable).toContain("주소를 확인");

    expect(
      providerTestMessage({
        ok: false,
        reason: "not_external_provider",
        endpointLabel: "http://mock-hermes:8088/v1",
      })
    ).toContain("목 모드");

    expect(
      providerTestMessage({
        ok: false,
        reason: "provider_not_configured",
        endpointLabel: "x",
      })
    ).toContain("저장된 키가 없습니다");

    // An unknown reason is reported, not swallowed and not apologised for.
    expect(
      providerTestMessage({ ok: false, reason: "brand_new", endpointLabel: "x" })
    ).toContain("brand_new");
  });
});

describe("catalogs match the server enums", () => {
  it("offers exactly the three work engines migration 040 allows", () => {
    expect(WORK_ENGINES.map((e) => e.id)).toEqual([
      "opencode",
      "goose",
      "codex-local",
    ]);
  });

  it("offers exactly the three provider modes AgentProviderMode allows", () => {
    expect([...PROVIDER_MODES.map((m) => m.id)].sort()).toEqual([
      "external-hermes",
      "internal-host-mock",
      "local-mock",
    ]);
  });

  it("offers exactly the three invite roles InviteRoutes allows", () => {
    expect([...INVITE_ROLES.map((r) => r.id)].sort()).toEqual([
      "admin",
      "guest",
      "member",
    ]);
    expect(choiceLabel(INVITE_ROLES, "member")).toBe("멤버");
    expect(choiceLabel(INVITE_ROLES, "unknown")).toBe("unknown");
  });
});

describe("error mapping", () => {
  it("reads a 403 as an operator gate, not a failure", () => {
    expect(isOperatorDenied(new ApiError(403, "platform:read scope required"))).toBe(
      true
    );
    expect(isOperatorDenied(new ApiError(500, "boom"))).toBe(false);
    expect(isOperatorDenied(new Error("offline"))).toBe(false);
  });

  it("reads a 409 as a slug conflict", () => {
    expect(isSlugConflict(new ApiError(409, "workspace slug already exists"))).toBe(
      true
    );
    expect(isSlugConflict(new ApiError(400, "bad slug"))).toBe(false);
  });

  it("prefers the server message and never invents one", () => {
    expect(errorMessage(new ApiError(400, "engine must be one of opencode, goose, codex-local"))).toBe(
      "engine must be one of opencode, goose, codex-local"
    );
    expect(errorMessage("string throw")).toContain("다시 시도");
  });
});

describe("invite list status", () => {
  const base = { expiresAtMs: Date.now() + 86_400_000, usedCount: 0, maxUses: 1 };

  it("derives status from the server row only", () => {
    expect(inviteStatus(base).label).toBe("사용 가능");
    expect(inviteStatus({ ...base, revokedAtMs: Date.now() }).label).toBe("해지됨");
    expect(inviteStatus({ ...base, usedCount: 1 }).label).toBe("모두 사용됨");
    expect(inviteStatus({ ...base, expiresAtMs: Date.now() - 1000 }).label).toBe(
      "만료됨"
    );
  });

  it("formats an expiry as a local calendar day", () => {
    expect(formatDay(new Date(2026, 0, 5, 23, 30).getTime())).toBe("2026-01-05");
  });
});

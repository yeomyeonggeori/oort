import { describe, expect, it } from "vitest";
import { ApiError } from "../../lib/api";
import {
  autoTargetLabel,
  buildInviteMailto,
  buildJoinLink,
  choiceLabel,
  eligibleAutoTargets,
  errorMessage,
  formatDay,
  INVITE_ROLES,
  buildRoleLabelsPayload,
  draftFromRoleLabels,
  inviteCardText,
  inviteRoles,
  inviteStatus,
  isWorkspaceOperator,
  ROLE_LABEL_MAX_BYTES,
  roleLabelFieldError,
  roleLabelsEqual,
  roleLabelsSaveMessage,
  isOperatorDenied,
  isSlugConflict,
  maskedBearer,
  normalizeSlug,
  percentEncode,
  PROVIDER_MODES,
  providerSourceLabel,
  providerTestMessage,
  relativeSince,
  slugError,
  sortWorkHosts,
  WORK_ENGINES,
  WORK_TIER_MODES,
  workHostCounts,
  workHostIdTail,
  workHostRegistryMessage,
  workHostScopeLabel,
  workHostStatus,
  workHostTypeLabel,
  workspaceNameError,
  workTierPolicySaveMessage,
} from "./model";

// The values asserted here were taken from live momowebqa round trips against
// the real routes (ProviderLinkRoutes / WorkHostEngineRoutes / WorkspaceRoutes /
// InviteRoutes), so a server-side rule change breaks a test rather than a user.

describe("oort://join deep link (docs/onboarding-deeplink.md)", () => {
  const CODE = "vBca_VjT8-uPMgUV52QOQmKBvGBIFRAc"; // base64url, as issued

  it("percent-encodes the server base URL and keeps the code verbatim", () => {
    expect(buildJoinLink("https://api.example.com", CODE)).toBe(
      `oort://join?server=https%3A%2F%2Fapi.example.com&code=${CODE}`
    );
  });

  it("encodes the port separator too", () => {
    expect(buildJoinLink("http://127.0.0.1:28000", "abc")).toBe(
      "oort://join?server=http%3A%2F%2F127.0.0.1%3A28000&code=abc"
    );
  });

  it("emits only the two contract parameters, server first", () => {
    const url = new URL(buildJoinLink("https://api.example.com", CODE));
    expect(url.protocol).toBe("oort:");
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

  it("overrides invite labels without changing role ids or details", () => {
    const roles = inviteRoles({ admin: "리드", member: "  ", guest: "손님" });
    expect(roles.map((r) => r.id)).toEqual(["member", "admin", "guest"]);
    expect(choiceLabel(roles, "member")).toBe("멤버");
    expect(choiceLabel(roles, "admin")).toBe("리드");
    expect(choiceLabel(roles, "guest")).toBe("손님");
    expect(roles.find((r) => r.id === "admin")?.detail).toBe(
      INVITE_ROLES.find((r) => r.id === "admin")?.detail
    );
  });

  it("leaves INVITE_ROLES unchanged when there are no overrides", () => {
    expect(inviteRoles()).toEqual(INVITE_ROLES);
    expect(inviteRoles({})).toEqual(INVITE_ROLES);
  });
});

describe("role display override draft and payload", () => {
  it("accepts empty (restore default) and rejects whitespace-only or over-long", () => {
    expect(roleLabelFieldError("")).toBeNull();
    expect(roleLabelFieldError("마스터")).toBeNull();
    expect(roleLabelFieldError("   ")).toContain("공백만");
    expect(roleLabelFieldError("가".repeat(16))).toBeNull();
    expect(roleLabelFieldError("가".repeat(17))).toBe(
      "역할 이름은 한글 기준 16자까지 쓸 수 있습니다."
    );
    expect(ROLE_LABEL_MAX_BYTES).toBe(48);
  });

  it("rebuilds the whole object and sends null when every field is empty", () => {
    expect(
      buildRoleLabelsPayload({
        owner: "마스터",
        admin: "",
        member: "  동료  ",
        guest: "   ",
      })
    ).toEqual({ owner: "마스터", member: "동료" });
    expect(
      buildRoleLabelsPayload({ owner: "", admin: "  ", member: "", guest: "" })
    ).toBeNull();
  });

  it("round-trips stored labels into the four fields", () => {
    expect(draftFromRoleLabels({ owner: "마스터" })).toEqual({
      owner: "마스터",
      admin: "",
      member: "",
      guest: "",
    });
    expect(draftFromRoleLabels(null)).toEqual({
      owner: "",
      admin: "",
      member: "",
      guest: "",
    });
    expect(roleLabelsEqual({ owner: "마스터" }, { owner: "마스터" })).toBe(true);
    expect(roleLabelsEqual({ owner: "마스터" }, {})).toBe(false);
    expect(roleLabelsEqual(null, {})).toBe(true);
  });

  it("treats owner and admin as operators, not member or guest", () => {
    expect(isWorkspaceOperator("owner")).toBe(true);
    expect(isWorkspaceOperator("admin")).toBe(true);
    expect(isWorkspaceOperator("member")).toBe(false);
    expect(isWorkspaceOperator("guest")).toBe(false);
    expect(isWorkspaceOperator(undefined)).toBe(false);
  });

  it("maps a save failure without leaking the wire 400 sentence", () => {
    expect(roleLabelsSaveMessage(new ApiError(403, "operator required"))).toContain(
      "오너나 관리자"
    );
    expect(roleLabelsSaveMessage(new ApiError(400, "role_labels value exceeds 48 bytes"))).toBe(
      "표시명을 저장하지 못했습니다. 잠시 뒤에 다시 시도하세요."
    );
  });
});

describe("work tier policy (ADR-0125 D11)", () => {
  it("offers exactly the three modes WorkTierPolicyRoutes.validatedMode allows", () => {
    expect(WORK_TIER_MODES.map((m) => m.id)).toEqual(["t1_only", "ask", "auto"]);
  });

  it("never puts a tier number in front of a person", () => {
    for (const mode of WORK_TIER_MODES) {
      expect(`${mode.label} ${mode.detail}`).not.toMatch(/\bT[123]\b/);
    }
  });

  it("keeps the mac wording for the two platform-neutral modes", () => {
    expect(choiceLabel(WORK_TIER_MODES, "ask")).toBe("연결 끊김 시 묻기");
    expect(choiceLabel(WORK_TIER_MODES, "auto")).toBe("자동 재개");
  });
});

describe("auto target eligibility (mirrors requireAllowedTarget)", () => {
  // Ids as the registry returns them (lower-case) against a member id as login
  // returns it (upper-case): the pair that a raw === would silently drop.
  const workspaceHost = {
    id: "019f994c-4ee2-74f5-80f1-44408e9a2b82",
    scope: "workspace",
    ownerMemberId: "00000000-0000-7000-8000-000000000101",
    displayName: "dawn-build-01",
  };
  const myHost = {
    id: "019f994c-4ed0-76a9-9d43-a9bde45b8fcd",
    scope: "member",
    ownerMemberId: "00000000-0000-7000-8000-000000000101",
    displayName: "성재 MacBook Pro",
  };
  const otherHost = {
    id: "019f994c-4ed0-76a9-9d43-a9bde45b8fce",
    scope: "member",
    ownerMemberId: "00000000-0000-7000-8000-000000000102",
    displayName: "지수 MacBook Air",
  };
  const ME = "00000000-0000-7000-8000-000000000101".toUpperCase();

  it("lets a workspace default point only at a workspace-scoped host", () => {
    expect(
      eligibleAutoTargets([workspaceHost, myHost, otherHost], "workspace", ME).map(
        (h) => h.displayName
      )
    ).toEqual(["dawn-build-01"]);
  });

  it("lets my override point at a workspace host or one I own", () => {
    expect(
      eligibleAutoTargets([workspaceHost, myHost, otherHost], "member", ME).map(
        (h) => h.displayName
      )
    ).toEqual(["dawn-build-01", "성재 MacBook Pro"]);
  });

  it("never offers a revoked host, whatever its scope", () => {
    const revoked = { ...workspaceHost, revokedAtMs: 1784983342799 };
    expect(eligibleAutoTargets([revoked, myHost], "member", ME)).toEqual([myHost]);
  });

  it("names the stored target, and says so when it left the registry", () => {
    expect(autoTargetLabel("cloud", [workspaceHost])).toBe("oort Cloud");
    expect(autoTargetLabel(workspaceHost.id.toUpperCase(), [workspaceHost])).toBe(
      "dawn-build-01"
    );
    expect(autoTargetLabel(undefined, [workspaceHost])).toBe("고른 대상 없음");
    expect(autoTargetLabel("019f0000-0000-0000-0000-000000000000", [])).toBe(
      "등록 목록에 없는 호스트"
    );
  });

  it("marks a revoked target instead of passing it off as a live host", () => {
    const revoked = { ...workspaceHost, revokedAtMs: 1784983342799 };
    expect(autoTargetLabel(revoked.id, [revoked])).toBe("dawn-build-01 (해지됨)");
  });

  it("keeps the raw host id out of the sentence", () => {
    const missing = "019f0000-0000-0000-0000-000000000000";
    expect(autoTargetLabel(missing, [])).not.toContain(missing);
  });
});

describe("코드 실행 호스트 error copy", () => {
  // The routes answer in operator English. None of it reaches the panel.
  it("answers each tier policy status the client can provoke", () => {
    const at = (status: number, message: string) =>
      workTierPolicySaveMessage(new ApiError(status, message));

    expect(at(400, "auto mode requires autoTarget")).toContain("재개 대상");
    expect(at(403, "workspace tier policy requires owner or admin")).toContain(
      "오너나 관리자"
    );
    expect(at(409, "auto target work host is unavailable")).toContain("해지");
    expect(at(500, "boom")).toBe(
      "정책을 저장하지 못했습니다. 잠시 뒤에 다시 시도하세요."
    );
    expect(workTierPolicySaveMessage(new Error("network"))).toBe(
      "정책을 저장하지 못했습니다. 잠시 뒤에 다시 시도하세요."
    );
  });

  it("never leaks a wire message into user copy", () => {
    const wire = [
      "workspace policy requires a workspace-scoped host",
      "auto target work host is unavailable",
      "member policy target belongs to another member",
      "not a workspace member",
    ];
    for (const message of wire) {
      expect(workTierPolicySaveMessage(new ApiError(409, message))).not.toContain(
        message
      );
    }
    expect(workHostRegistryMessage()).not.toContain("workspace");
  });
});

describe("work host row (WorkHostRoutes projection)", () => {
  it("reads liveness from the server row, and revocation outranks it", () => {
    expect(workHostStatus({ online: true }).label).toBe("온라인");
    expect(workHostStatus({ online: false, lastSeenAtMs: 1 }).label).toBe(
      "오프라인"
    );
    expect(workHostStatus({ online: false }).label).toBe("연결된 적 없음");
    expect(
      workHostStatus({ online: true, revokedAtMs: 1, lastSeenAtMs: 1 })
    ).toEqual({ tone: "muted", label: "해지됨" });
  });

  it("labels every type and scope the server validates", () => {
    expect(["app", "workd", "cloud"].map(workHostTypeLabel)).toEqual([
      "데스크톱 앱",
      "workd 데몬",
      "oort Cloud",
    ]);
    expect(["member", "workspace"].map(workHostScopeLabel)).toEqual([
      "개인",
      "워크스페이스 공용",
    ]);
    // An enum this client has not heard of is shown, never swallowed.
    expect(workHostTypeLabel("gpu-farm")).toBe("gpu-farm");
  });

  it("reports how long ago a host was last seen, then falls back to a day", () => {
    const now = new Date(2026, 6, 25, 12, 0, 0).getTime();
    expect(relativeSince(now - 5_000, now)).toBe("방금");
    expect(relativeSince(now - 12 * 60_000, now)).toBe("12분 전");
    expect(relativeSince(now - 3 * 3_600_000, now)).toBe("3시간 전");
    expect(relativeSince(now - 3 * 86_400_000, now)).toBe("2026-07-22");
  });

  // The live momowebqa registry: six rows, four revoked, and three of them
  // sharing one displayName because the host re-registered three times.
  const LIVE = [
    { id: "019f9984-b2a9-7618-8ed1-eb0d622ccaa2", online: false, name: "성재 MacBook Pro 16인치, 사무실 창가 자리" },
    { id: "019f9984-b2cb-7c28-8a42-387c95d5b9b6", online: false, name: "dawn-build-01" },
    { id: "019f9984-b2ee-78b0-89c0-31ac6769e8f3", online: false, revokedAtMs: 1784987053140, name: "지수 MacBook Air" },
    { id: "019f999c-6845-79cd-841d-22f20d098c61", online: false, revokedAtMs: 1784988592207, name: "성재 iMac, 집 작업실" },
    { id: "019f999d-8729-72a6-995d-5dffec0bc8a0", online: false, revokedAtMs: 1784988665650, name: "성재 iMac, 집 작업실" },
    { id: "019f99a0-8ac1-77b0-948b-210e791c6238", online: false, revokedAtMs: 1784988863000, name: "성재 iMac, 집 작업실" },
  ];

  it("distinguishes rows by id tail, because a display name does not", () => {
    // Three live rows, one name. Only the tail separates them, so it is what
    // the accessible name of a per-row control has to carry.
    const sameName = LIVE.filter((h) => h.name === "성재 iMac, 집 작업실");
    expect(sameName).toHaveLength(3);
    const tails = sameName.map((h) => workHostIdTail(h.id));
    expect(tails).toEqual(["098c61", "0bc8a0", "1c6238"]);
    expect(new Set(tails).size).toBe(3);
    // Lower-cased always: work host ids arrive lower-cased and member ids can
    // arrive upper-cased, and nothing on this surface compares raw strings.
    expect(workHostIdTail("019F99A0-8AC1-77B0-948B-210E791C6238")).toBe("1c6238");
    expect(workHostIdTail("abc")).toBe("abc");
  });

  it("orders the registry online, offline, never seen, revoked", () => {
    const hosts = [
      { id: "revoked", online: false, revokedAtMs: 1 },
      { id: "never", online: false },
      { id: "online", online: true },
      { id: "offline", online: false, lastSeenAtMs: 1 },
      { id: "revoked-but-online", online: true, revokedAtMs: 1 },
    ];
    expect(sortWorkHosts(hosts).map((h) => h.id)).toEqual([
      "online",
      "offline",
      "never",
      "revoked",
      "revoked-but-online",
    ]);
    // The live ledger, as the server happens to return it, reversed: the two
    // usable hosts have to climb back to the top, and the four revoked rows
    // keep the (reversed) order they arrived in.
    const reversed = [...LIVE].reverse();
    expect(sortWorkHosts(reversed).map((h) => h.id)).toEqual([
      LIVE[1].id,
      LIVE[0].id,
      LIVE[5].id,
      LIVE[4].id,
      LIVE[3].id,
      LIVE[2].id,
    ]);
  });

  it("counts hosts you can use apart from hosts that are gone", () => {
    expect(workHostCounts(LIVE)).toEqual({ usable: 2, revoked: 4 });
    expect(workHostCounts([])).toEqual({ usable: 0, revoked: 0 });
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

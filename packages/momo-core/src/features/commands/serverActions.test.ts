import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ACTION_DESTINATION_META,
  actionDestination,
  fetchActionsCatalog,
  parseActionsCatalog,
} from "./serverActions";
import { installCoreHost, resetCoreHost } from "../../runtime/host";

// ADR-0186 부록 E의 본문 그대로.
const INVITE = {
  id: "invite.create",
  title: "팀원 초대 링크 만들기",
  summary: "승인하면 관리자 권한으로 초대 링크를 만듭니다.",
  risk: "approval",
  requiredRole: "admin",
  argsSchema: {
    type: "object",
    properties: { role: { enum: ["member", "admin"] } },
  },
  executable: true,
  unavailableReason: null,
};

describe("행동 카탈로그 파싱 (부록 E)", () => {
  it("부록 E 본문을 읽는다", () => {
    expect(parseActionsCatalog({ actions: [INVITE] })).toEqual([
      {
        id: "invite.create",
        title: "팀원 초대 링크 만들기",
        summary: "승인하면 관리자 권한으로 초대 링크를 만듭니다.",
        risk: "approval",
        requiredRole: "admin",
        executable: true,
        unavailableReason: null,
      },
    ]);
  });

  it("빈 카탈로그와 부재는 다른 답이다", () => {
    expect(parseActionsCatalog({ actions: [] })).toEqual([]);
    expect(parseActionsCatalog(null)).toBeNull();
    expect(parseActionsCatalog(undefined)).toBeNull();
  });

  it("계약 밖 모양은 전부 null이다 — 배열을 그대로 준 서버도", () => {
    expect(parseActionsCatalog([INVITE])).toBeNull();
    expect(parseActionsCatalog("actions")).toBeNull();
    expect(parseActionsCatalog({})).toBeNull();
    expect(parseActionsCatalog({ actions: {} })).toBeNull();
    expect(parseActionsCatalog({ actions: "invite.create" })).toBeNull();
  });

  it("한 항목이 어긋나면 카탈로그 전체가 null이다 — 절반은 그리지 않는다", () => {
    const broken = { ...INVITE, id: "channel.create", risk: "sometimes" };
    expect(parseActionsCatalog({ actions: [INVITE, broken] })).toBeNull();
    expect(
      parseActionsCatalog({ actions: [INVITE, { ...INVITE, executable: "yes" }] })
    ).toBeNull();
    expect(parseActionsCatalog({ actions: [INVITE, null] })).toBeNull();
    expect(
      parseActionsCatalog({ actions: [{ ...INVITE, id: "" }] })
    ).toBeNull();
    expect(
      parseActionsCatalog({ actions: [{ ...INVITE, summary: 7 }] })
    ).toBeNull();
    expect(
      parseActionsCatalog({ actions: [{ ...INVITE, requiredRole: 3 }] })
    ).toBeNull();
  });

  it("선택 필드의 null과 부재는 둘 다 null로 읽는다", () => {
    const { requiredRole: _role, unavailableReason: _reason, ...rest } = INVITE;
    const parsed = parseActionsCatalog({
      actions: [{ ...rest, risk: "none", executable: false }],
    });
    expect(parsed).toHaveLength(1);
    expect(parsed?.[0]?.requiredRole).toBeNull();
    expect(parsed?.[0]?.unavailableReason).toBeNull();
    expect(parsed?.[0]?.risk).toBe("none");
  });

  it("계약에 없는 필드는 버린다", () => {
    const parsed = parseActionsCatalog({ actions: [INVITE] });
    expect(parsed?.[0]).not.toHaveProperty("argsSchema");
  });
});

// ---- AX-4: 요청과 목적지 ----------------------------------------------------

function installHost(): void {
  installCoreHost({
    apiBase: () => "https://oort.test",
    absoluteApiBase: () => "https://oort.test",
    buildMode: () => "test",
    session: {
      getAccessToken: () => "access",
      getRefreshToken: () => null,
      getPersistedSession: () => null,
      applyLogin: () => {},
      applyRotation: () => {},
      markAuthExpired: () => {},
      clearSession: () => {},
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetCoreHost();
});

function respond(body: unknown, status = 200): typeof fetch {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      })
  ) as unknown as typeof fetch;
}

describe("카탈로그 요청 (부록 E)", () => {
  it("계약대로 온 본문을 읽고, 워크스페이스 경로로 묻는다", async () => {
    installHost();
    const fetchMock = respond({ actions: [INVITE] });
    vi.stubGlobal("fetch", fetchMock);
    const parsed = await fetchActionsCatalog("ws-1");
    expect(parsed?.[0]?.id).toBe("invite.create");
    expect(String((fetchMock as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0])).toBe(
      "https://oort.test/v1/workspaces/ws-1/actions"
    );
  });

  it("라우트가 없으면 null 이다 — 그리고 null 이면 그룹이 없다", async () => {
    installHost();
    vi.stubGlobal("fetch", respond({ error: { message: "not found" } }, 404));
    expect(await fetchActionsCatalog("ws-1")).toBeNull();
  });

  it("네트워크가 끊겨도 던지지 않는다", async () => {
    installHost();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("network down");
      })
    );
    expect(await fetchActionsCatalog("ws-1")).toBeNull();
  });

  it("본문이 계약과 다르면 null 이다 (반쯤 아는 목록을 그리지 않는다)", async () => {
    installHost();
    vi.stubGlobal("fetch", respond({ actions: [{ id: "x" }] }));
    expect(await fetchActionsCatalog("ws-1")).toBeNull();
  });
});

describe("행동 줄의 목적지 (v1)", () => {
  it("실물 화면이 있는 것만 답한다", () => {
    expect(actionDestination("invite.create")).toBe("/settings?section=members");
    expect(actionDestination("webhook.create")).toBe("/settings?section=webhooks");
  });

  it("모르는 id 는 null 이고, null 이면 그 줄은 눌리지 않는다", () => {
    expect(actionDestination("channel.create")).toBeNull();
    expect(actionDestination("")).toBeNull();
  });

  it("프로토타입 오염으로 목적지가 생기지 않는다", () => {
    expect(actionDestination("constructor")).toBeNull();
    expect(actionDestination("__proto__")).toBeNull();
    expect(actionDestination("toString")).toBeNull();
  });

  it("작은 글씨는 누르면 일어나는 일을 말한다", () => {
    expect(ACTION_DESTINATION_META).toBe("설정에서 직접 하기");
  });
});

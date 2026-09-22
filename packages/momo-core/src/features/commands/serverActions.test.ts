import { describe, expect, it } from "vitest";
import { parseActionsCatalog } from "./serverActions";

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

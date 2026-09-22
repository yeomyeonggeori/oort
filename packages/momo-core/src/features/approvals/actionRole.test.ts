import { describe, expect, it } from "vitest";
import {
  actionApproveConfirmCopy,
  approvalRoleCopy,
  roleDisplayName,
  roleRequiredCopy,
} from "./actionRole";

describe("행동의 결정 권한 낱말 (ADR-0186 부록 A · §5)", () => {
  it("역할 이름을 디렉터리 표에서 든다", () => {
    expect(roleDisplayName("admin")).toBe("관리자");
    expect(roleDisplayName("owner")).toBe("소유자");
    expect(roleDisplayName("member")).toBe("멤버");
  });

  it("모르는 역할은 감추지 않고 원문으로 지나간다", () => {
    expect(roleDisplayName("operator")).toBe("operator");
  });

  it("결정 전에는 누가 승인할 수 있는지를 말한다", () => {
    expect(approvalRoleCopy("admin")).toBe("관리자만 승인할 수 있습니다.");
  });

  it("403 뒤에는 「관리자가 승인해야 합니다」와 다음 행동을 함께 말한다", () => {
    const copy = roleRequiredCopy("admin");
    expect(copy).toContain("관리자가 승인해야 합니다.");
    expect(copy).toContain("아직 대기 중");
  });

  it("R1 N5: 모르는 역할에는 조사를 붙이지 않는다", () => {
    // 「member가 승인해야 합니다」는 조사가 맞아도 낱말이 주어가 되지 못한다.
    const copy = roleRequiredCopy("member_of_billing");
    expect(copy).not.toContain("member_of_billing가");
    expect(copy).not.toContain("member_of_billing이");
    expect(copy).toContain("member_of_billing 역할이 필요합니다.");
    expect(copy).toContain("아직 대기 중");
  });

  it("아는 역할 넷은 전부 조사가 맞는다", () => {
    for (const [role, expected] of [
      ["owner", "소유자가"],
      ["admin", "관리자가"],
      ["member", "멤버가"],
      ["guest", "게스트가"],
    ] as const) {
      expect(roleRequiredCopy(role).startsWith(`${expected} 승인해야`)).toBe(true);
    }
  });

  it("R1 M2: 행동 승인의 확정 문장은 에이전트 재개를 약속하지 않는다", () => {
    const copy = actionApproveConfirmCopy("admin");
    expect(copy).toBe("승인하면 서버가 관리자 권한으로 이 행동을 실행합니다.");
    expect(copy).not.toContain("에이전트");
    expect(copy).not.toContain("이어서");
  });

  it("역할을 모르면 권한 절을 빼고 말한다 — 없는 사실을 짓지 않는다", () => {
    expect(actionApproveConfirmCopy(null)).toBe(
      "승인하면 서버가 이 행동을 실행합니다."
    );
    expect(actionApproveConfirmCopy("operator")).toBe(
      "승인하면 서버가 이 행동을 실행합니다."
    );
  });

  it("프로토타입 키가 역할 이름으로 새지 않는다", () => {
    expect(roleDisplayName("constructor")).toBe("constructor");
    expect(roleDisplayName("__proto__")).toBe("__proto__");
  });
});

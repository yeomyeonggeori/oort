import { describe, expect, it } from "vitest";
import { ROLE_KEYS } from "../directory/model";
import {
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
    expect(approvalRoleCopy("admin")).toBe("관리자만 승인할 수 있어요.");
  });

  it("403 뒤에는 「관리자가 승인해야 해요」와 다음 행동을 함께 말한다", () => {
    const copy = roleRequiredCopy("admin");
    expect(copy).toContain("관리자가 승인해야 해요.");
    expect(copy).toContain("아직 대기 중");
  });

  it("R1 N5: 모르는 역할에는 조사를 붙이지 않는다", () => {
    // 「member가 승인해야 해요」는 조사가 맞아도 낱말이 주어가 되지 못한다.
    const copy = roleRequiredCopy("member_of_billing");
    expect(copy).not.toContain("member_of_billing가");
    expect(copy).not.toContain("member_of_billing이");
    expect(copy).toContain("member_of_billing 역할이 필요해요.");
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

  it("프로토타입 키가 역할 이름으로 새지 않는다", () => {
    expect(roleDisplayName("constructor")).toBe("constructor");
    expect(roleDisplayName("__proto__")).toBe("__proto__");
  });

  it("#3729: 합성 역할 두 낱말은 서버 계약의 문장 그대로 말한다", () => {
    expect(roleRequiredCopy("agent_editor").startsWith(
      "대상 에이전트의 소유자 또는 관리자가 승인해야 해요."
    )).toBe(true);
    expect(roleRequiredCopy("workspace_operator").startsWith(
      "워크스페이스 운영자(관리자)가 승인해야 해요."
    )).toBe(true);
    expect(approvalRoleCopy("agent_editor")).toBe(
      "대상 에이전트의 소유자 또는 관리자만 승인할 수 있어요."
    );
    expect(approvalRoleCopy("workspace_operator")).toBe(
      "워크스페이스 운영자(관리자)만 승인할 수 있어요."
    );
  });

  it("#3729: 합성 역할 403 문장에 원문 토큰이 새지 않는다", () => {
    expect(roleRequiredCopy("workspace_operator")).not.toContain("workspace_operator");
  });

  it("#3729: 합성 역할은 멤버 역할 표로 새지 않는다", () => {
    // 디렉터리의 역할 선택기가 이 표를 읽는다. 판정 이름이 거기 서면 「운영자」를
    // 사람에게 줄 수 있는 역할로 오해한다.
    expect(ROLE_KEYS as readonly string[]).not.toContain("agent_editor");
    expect(ROLE_KEYS as readonly string[]).not.toContain("workspace_operator");
  });

  it("#4394: requesting_member 는 「요청한 본인」이라고 말하고 원문 토큰을 내지 않는다", () => {
    expect(roleDisplayName("requesting_member")).toBe("요청한 본인");
    expect(approvalRoleCopy("requesting_member")).toBe("요청한 본인만 승인할 수 있어요.");
    const copy = roleRequiredCopy("requesting_member");
    expect(copy.startsWith("요청한 본인이 승인해야 해요.")).toBe(true);
    expect(copy).toContain("아직 대기 중");
    expect(copy).not.toContain("requesting_member");
  });
});

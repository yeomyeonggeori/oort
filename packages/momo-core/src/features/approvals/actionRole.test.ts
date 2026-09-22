import { describe, expect, it } from "vitest";
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
    expect(approvalRoleCopy("admin")).toBe("관리자만 승인할 수 있습니다.");
  });

  it("403 뒤에는 「관리자가 승인해야 합니다」와 다음 행동을 함께 말한다", () => {
    const copy = roleRequiredCopy("admin");
    expect(copy).toContain("관리자가 승인해야 합니다.");
    expect(copy).toContain("아직 대기 중");
  });

  it("프로토타입 키가 역할 이름으로 새지 않는다", () => {
    expect(roleDisplayName("constructor")).toBe("constructor");
    expect(roleDisplayName("__proto__")).toBe("__proto__");
  });
});

import { describe, expect, it } from "vitest";
import { APP_GRADE_LABEL, appGradeLegend, appToolGrade } from "./appGrade";

describe("도구 등급 R · A · B (ADR-0113 증보 2 E4)", () => {
  it("읽기+none=R, 쓰기+require_approval=A, 쓰기+always=B", () => {
    expect(appToolGrade({ risk: "read", approvalPolicy: "none" })).toBe("R");
    expect(appToolGrade({ risk: "write", approvalPolicy: "require_approval" })).toBe("A");
    expect(appToolGrade({ risk: "write", approvalPolicy: "always" })).toBe("B");
  });

  it("A와 B는 승인 단계(approvalTier)로는 갈리지 않는다: 이 함수는 그 값을 읽지 않는다", () => {
    // 두 도구가 같은 network_write여도 정책이 다르면 등급이 다르다.
    const a = { risk: "write", approvalPolicy: "require_approval", approvalTier: "network_write" };
    const b = { risk: "write", approvalPolicy: "always", approvalTier: "network_write" };
    expect(appToolGrade(a)).not.toBe(appToolGrade(b));
  });

  it("알 수 없는 조합은 등급이 아니다: 어림하지 않는다", () => {
    // 옛 서버(approvalPolicy 없음), 새 값, 관리자, 읽기인데 승인을 묻는 모순.
    for (const tool of [
      { risk: "read" },
      { risk: "write" },
      { risk: "write", approvalPolicy: "deny" },
      { risk: "admin", approvalPolicy: "deny" },
      { risk: "admin", approvalPolicy: "always" },
      { risk: "read", approvalPolicy: "always" },
      { risk: "write", approvalPolicy: "none" },
      { approvalPolicy: "none" },
      {},
    ]) {
      expect(appToolGrade(tool), JSON.stringify(tool)).toBeNull();
    }
  });

  it("칩 문장은 글자가 먼저이고, 뜻 설명은 C 등급을 만들지 않는다", () => {
    expect(APP_GRADE_LABEL).toEqual({ R: "R · 읽기", A: "A · 승인 후 쓰기", B: "B · 항상 묻고 쓰기" });
  });

  it("설명 줄은 이 앱에 있는 등급만 말한다: 읽기만 있는 앱에 쓰기 설명을 붙이지 않는다", () => {
    const R = { risk: "read", approvalPolicy: "none" };
    const A = { risk: "write", approvalPolicy: "require_approval" };
    const B = { risk: "write", approvalPolicy: "always" };
    expect(appGradeLegend([R, R])).toBe("R은 읽기만 해요.");
    expect(appGradeLegend([R, B])).toBe(
      "R은 읽기만 해요. B는 다른 사람에게 보이거나 알림이 가는 쓰기예요. 쓰기는 부를 때마다 승인받도록 선언돼 있어요."
    );
    expect(appGradeLegend([A])).toBe(
      "A는 내게만 영향이 있는 쓰기예요. 쓰기는 부를 때마다 승인받도록 선언돼 있어요."
    );
    // 등급을 아는 도구가 없으면 줄도 없다. C는 어떤 입력으로도 설명에 나오지 않는다.
    expect(appGradeLegend([])).toBeNull();
    expect(appGradeLegend([{ risk: "write" }, { risk: "admin", approvalPolicy: "deny" }])).toBeNull();
    for (const tools of [[R], [R, A, B], [A, B]]) {
      expect(appGradeLegend(tools)).not.toMatch(/\bC\b|[—–]/);
    }
  });
});

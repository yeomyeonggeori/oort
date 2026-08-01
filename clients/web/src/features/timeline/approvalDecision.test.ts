import { describe, expect, it } from "vitest";
import { serverSurface } from "@/features/capabilities/serverSurfaces";
import { interpretReceipt, unreadableAnswerOutcome } from "./approvalDecision";

// goal B12: 승인 라우트가 없는 서버의 404를 원장의 답으로 읽지 않는다.
//
// 이 표면의 404는 두 가지다. 원장을 가진 서버의 404는 "그런 승인은 없다"이고
// 영수증 스키마를 싣고 온다. 라우트를 싣지 않은 서버의 404는 "그런 경로가 없다"
// 이고 라우터 기본 응답이라 본문이 없다. 둘을 한 칸에 넣어 두면 화면이 거짓말을
// 한다.

describe("읽을 수 없는 답", () => {
  it("본문 없는 404는 미제공이라고 말하고 재시도를 권하지 않는다", () => {
    const outcome = unreadableAnswerOutcome(404, "");
    expect(outcome.kind).toBe("error");
    expect(outcome.errorCopy).toBe(serverSurface("approvals").absentReason);
    // 예전 문구는 "다시 시도하세요"였다. 결코 성공할 수 없는 재시도를 시키는
    // 문장이었고, 사용자 자리에서는 앱이 고장난 것으로 읽혔다.
    expect(outcome.errorCopy).not.toMatch(/다시 시도/);
  });

  it("공백뿐인 본문도 같다", () => {
    expect(unreadableAnswerOutcome(404, "  \n ").errorCopy).toBe(
      serverSurface("approvals").absentReason
    );
  });

  it("405와 501도 같은 판정을 받는다", () => {
    for (const status of [405, 501]) {
      expect(unreadableAnswerOutcome(status, "").errorCopy).toBe(
        serverSurface("approvals").absentReason
      );
    }
  });

  it("본문이 있는데 못 읽은 것은 미제공이 아니다", () => {
    // 원장을 가진 서버가 깨진 JSON을 보낸 경우다. 그때는 다시 시도할 값이 있다.
    const outcome = unreadableAnswerOutcome(404, "<html>gateway</html>");
    expect(outcome.errorCopy).toMatch(/다시 시도/);
    expect(outcome.errorCopy).not.toBe(serverSurface("approvals").absentReason);
  });

  it("미제공 코드가 아닌 상태는 기존 문구를 그대로 쓴다", () => {
    for (const status of [200, 403, 409, 500]) {
      expect(unreadableAnswerOutcome(status, "").errorCopy).toMatch(/다시 시도/);
    }
  });
});

describe("영수증 해석은 그대로다", () => {
  it("200은 기록된 결정이다", () => {
    const outcome = interpretReceipt(200, {
      approval_id: "a",
      status: "approved",
      decided_at_ms: 1_700_000_000_000,
      decided_by: "member-1",
    });
    expect(outcome.kind).toBe("committed");
    expect(outcome.status).toBe("approved");
    expect(outcome.decidedAtMs).toBe(1_700_000_000_000);
    expect(outcome.decidedByMemberId).toBe("member-1");
  });

  it("409에 확정 상태가 실려 오면 다른 곳에서 이미 결정된 것이다", () => {
    const outcome = interpretReceipt(409, {
      approval_id: "a",
      status: "rejected",
    });
    expect(outcome.kind).toBe("superseded");
    expect(outcome.note).toBe("다른 곳에서 이미 결정되었습니다.");
  });

  it("만료는 만료라고 말한다: 실패로 승격하지 않는다 (ADR-0132)", () => {
    const outcome = interpretReceipt(409, {
      approval_id: "a",
      status: "expired",
    });
    expect(outcome.kind).toBe("superseded");
    expect(outcome.note).toBe("결정 전에 만료되었습니다.");
  });

  it("영수증을 실은 404는 여전히 '찾을 수 없다'로 읽는다", () => {
    // 원장을 가진 서버의 정당한 답. 위의 본문 없는 404와 갈라지는 지점이다.
    const outcome = interpretReceipt(404, {
      approval_id: "a",
      status: "unknown-to-this-client",
    });
    expect(outcome.kind).toBe("error");
    expect(outcome.errorCopy).toMatch(/찾을 수 없습니다/);
  });
});

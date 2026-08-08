import { describe, expect, it } from "vitest";
import { serverSurface } from "../capabilities/serverSurfaces";
import {
  interpretReceipt,
  unreadableAnswerOutcome,
  unsettledAnswerClause,
} from "./approvalDecision";

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

  it("미제공은 이유를 코드로도 싣는다: 화면이 빨간 alert 대신 미제공으로 그릴 수 있게", () => {
    // 2R M1. `kind`는 여전히 error다 — 결정은 기록되지 않았고, 그것을 새 갈래로
    // 빼면 그 갈래를 모르는 호출자가 조용히 "결정됨" 쪽으로 떨어뜨린다.
    // 바뀌는 것은 **색**뿐이고, 그 판정에 필요한 것이 이 코드다.
    for (const status of [404, 405, 501]) {
      expect(unreadableAnswerOutcome(status, "").errorCode).toBe(
        "surface_absent"
      );
    }
  });

  it("진짜 실패에는 미제공 코드가 붙지 않는다", () => {
    expect(
      unreadableAnswerOutcome(404, "<html>gateway</html>").errorCode
    ).toBeUndefined();
    for (const status of [200, 403, 409, 500]) {
      expect(unreadableAnswerOutcome(status, "").errorCode).toBeUndefined();
    }
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

describe("영수증이 아닌 답 (2R, 리뷰 M5 이관)", () => {
  it("상태 코드가 사용자 문장에 새지 않는다", () => {
    for (const status of [500, 502, 503, 429, 418]) {
      const clause = unsettledAnswerClause(status);
      expect(clause).not.toMatch(/\d{3}/);
      expect(clause).not.toMatch(/[—–]/);
    }
  });

  it("사람이 판단할 수 있는 세 갈래로 접는다", () => {
    expect(unsettledAnswerClause(429)).toMatch(/요청이 잦아/);
    expect(unsettledAnswerClause(503)).toMatch(/서버가 오류로 답했습니다/);
    expect(unsettledAnswerClause(418)).toMatch(/받지 않았습니다/);
  });

  it("모든 갈래가 다음에 할 일을 말한다", () => {
    for (const status of [429, 500, 418]) {
      expect(unsettledAnswerClause(status)).toMatch(/다시 시도|받지 않았습니다/);
    }
  });
});

// 지금 이 레포에는 서버가 두 대 살고, 둘이 이 본문을 다른 표기로 낸다. Swift는
// snake_case(`ApprovalDecisionRoutes.swift`의 CodingKeys), Rust는 camelCase
// (`dto.rs:2269-2279` + 손으로 쓴 `approval.rs:638-644`). 그 차이가 조용했던 이유는
// `status`가 두 표기에서 같은 글자여서 **판정은 살아 있었기** 때문이고, 버려진 것은
// "누가, 언제"뿐이었다. 그 둘은 웹 카드의 「승인」 원장 줄이 서는 조건 그 자체라,
// 결정한 직후 그 줄이 통째로 사라진다 — 오류 하나 없이.
describe("영수증은 두 표기를 모두 읽는다 (2R N2)", () => {
  const snake = {
    approval_id: "a",
    status: "approved",
    decided_by: "member-1",
    decided_at_ms: 1_700_000_000_000,
  };
  const camel = {
    approvalId: "a",
    status: "approved",
    decidedBy: "member-1",
    decidedAtMs: 1_700_000_000_000,
  };

  it("두 표기가 같은 결과를 낸다", () => {
    expect(interpretReceipt(200, camel)).toEqual(interpretReceipt(200, snake));
  });

  it("camelCase 영수증에서도 누가·언제가 살아남는다", () => {
    const outcome = interpretReceipt(200, camel);
    expect(outcome.kind).toBe("committed");
    expect(outcome.decidedByMemberId).toBe("member-1");
    expect(outcome.decidedAtMs).toBe(1_700_000_000_000);
  });

  it("이미 결정된 요청도 camelCase에서 누가·언제를 싣는다", () => {
    const outcome = interpretReceipt(409, { ...camel, status: "rejected" });
    expect(outcome.kind).toBe("superseded");
    expect(outcome.decidedByMemberId).toBe("member-1");
    expect(outcome.decidedAtMs).toBe(1_700_000_000_000);
  });

  it("표기 판정은 필드마다 따로 한다", () => {
    // Rust는 `None`인 필드를 아예 뺀다(`skip_serializing_if`). 한 필드를 보고
    // 표기를 정한 뒤 나머지를 그 표기로 읽으면, 빠진 필드 하나가 나머지를 통째로
    // 버리게 만든다. 섞여 오든 절반만 오든 있는 것만 읽어야 한다.
    const mixed = interpretReceipt(200, {
      status: "approved",
      decided_by: "member-1",
      decidedAtMs: 1_700_000_000_000,
    });
    expect(mixed.decidedByMemberId).toBe("member-1");
    expect(mixed.decidedAtMs).toBe(1_700_000_000_000);

    const onlyTime = interpretReceipt(200, {
      status: "approved",
      decidedAtMs: 1_700_000_000_000,
    });
    expect(onlyTime.decidedAtMs).toBe(1_700_000_000_000);
    expect(onlyTime.decidedByMemberId).toBeUndefined();
  });

  it("정본 표기가 이긴다: 둘 다 오면 snake_case를 읽는다", () => {
    const outcome = interpretReceipt(200, {
      status: "approved",
      decided_by: "canonical",
      decidedBy: "ported",
      decided_at_ms: 1,
      decidedAtMs: 2,
    });
    expect(outcome.decidedByMemberId).toBe("canonical");
    expect(outcome.decidedAtMs).toBe(1);
  });

  it("빈 문자열은 값이 아니다: 두 표기 모두에서", () => {
    for (const receipt of [
      { status: "approved", decided_by: "" },
      { status: "approved", decidedBy: "" },
    ]) {
      expect(interpretReceipt(200, receipt).decidedByMemberId).toBeUndefined();
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

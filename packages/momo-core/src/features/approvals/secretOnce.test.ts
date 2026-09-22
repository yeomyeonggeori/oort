import { describe, expect, it } from "vitest";
import { parseDecisionResult, parseSecretOnce } from "./secretOnce";
import { interpretReceipt } from "../timeline/approvalDecision";

// ADR-0186 부록 C 의 샘플 그대로.
const APPENDIX_C = {
  actionId: "invite.create",
  ref: { type: "invite", id: "0199aa11-2222-7000-8000-0000000000f1" },
  secretOnce: {
    kind: "invite_link",
    value: "https://oort.test/join?code=Ab3-_x",
    expiresAtMs: 1_790_000_000_000,
  },
};

describe("결정 응답의 result (ADR-0186 부록 C)", () => {
  it("부록 C 샘플을 그대로 읽는다", () => {
    expect(parseDecisionResult(APPENDIX_C)).toEqual({
      actionId: "invite.create",
      ref: { type: "invite", id: "0199aa11-2222-7000-8000-0000000000f1" },
      secretOnce: {
        kind: "invite_link",
        value: "https://oort.test/join?code=Ab3-_x",
        expiresAtMs: 1_790_000_000_000,
      },
    });
  });

  it("actionId 가 없으면 블록이 아니다 — 무엇의 링크인지 모르는 링크는 그리지 않는다", () => {
    expect(parseDecisionResult({ secretOnce: APPENDIX_C.secretOnce })).toBeNull();
  });

  it("값이 반쯤 오면 시크릿이 아니다", () => {
    expect(parseSecretOnce({ kind: "invite_link" })).toBeNull();
    expect(parseSecretOnce({ value: "https://oort.test/join?code=x" })).toBeNull();
    expect(parseSecretOnce({ kind: "invite_link", value: "" })).toBeNull();
  });

  it("만료가 없으면 null 이다 — 모르는 것을 0으로 짓지 않는다", () => {
    expect(
      parseSecretOnce({ kind: "invite_link", value: "https://oort.test/j" })
        ?.expiresAtMs
    ).toBeNull();
  });

  it("승인 성공(200)에만 실린다", () => {
    const committed = interpretReceipt(200, {
      status: "approved",
      result: APPENDIX_C,
    } as never);
    expect(committed.kind).toBe("committed");
    expect(committed.result?.secretOnce?.value).toBe(
      "https://oort.test/join?code=Ab3-_x"
    );
  });

  it("409·403 의 본문에 같은 블록이 있어도 읽지 않는다", () => {
    for (const status of [409, 403]) {
      const outcome = interpretReceipt(status, {
        status: "approved",
        result: APPENDIX_C,
      } as never);
      expect(outcome.result).toBeUndefined();
    }
  });

  it("403 은 forbidden 갈래를 달고 온다 (역할 판정은 카드가 진다)", () => {
    const outcome = interpretReceipt(403, { status: "pending" } as never);
    expect(outcome.kind).toBe("error");
    expect(outcome.errorCode).toBe("forbidden");
  });
});

describe("403 영수증의 role_required (AX-3b #2549 계약)", () => {
  it("영수증이 이름을 대면 role_required 다", () => {
    // 코드는 `ErrorResponse.code` 가 아니라 **영수증의 status** 로 온다.
    const outcome = interpretReceipt(403, {
      approval_id: "0199aa11-2222-7000-8000-0000000000a1",
      status: "role_required",
    } as never);
    expect(outcome.kind).toBe("error");
    expect(outcome.errorCode).toBe("role_required");
    expect(outcome.errorCopy).toContain("아직 대기 중");
    // 승인의 **상태**는 뒤집지 않는다 — 여전히 pending 이다(§5). 그 값은
    // `approval_status` enum 밖이라 상태로 읽히지 않아야 한다.
    expect(outcome.status).toBeUndefined();
  });

  it("그 밖의 403 은 기존 forbidden 그대로다 (도구 호출 승인 회귀 0)", () => {
    const outcome = interpretReceipt(403, { status: "pending" } as never);
    expect(outcome.errorCode).toBe("forbidden");
    expect(outcome.errorCopy).toContain("채널 멤버인지 확인하세요");
  });

  it("role_required 는 200·409 에서 읽지 않는다", () => {
    // 200/409 는 영수증이 결정을 말하는 자리다. 거기서 같은 글자가 와도
    // 이 갈래로 떨어지면 성공한 결정이 거절로 읽힌다.
    expect(
      interpretReceipt(200, { status: "role_required" } as never).kind
    ).toBe("committed");
    expect(
      interpretReceipt(409, { status: "role_required" } as never).errorCode
    ).toBe("idempotency_conflict");
  });
});

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

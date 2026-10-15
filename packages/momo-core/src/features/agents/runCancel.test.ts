import { describe, expect, it } from "vitest";
import { ApiError } from "../../lib/api";
import { NetworkError } from "../../lib/http";
import { ledgerRows } from "./runLedger";
import {
  alreadyOverSentence,
  CANCEL_CONFIRM_SENTENCE,
  cancelConfirmSentence,
  cancelFailureOutcome,
  cancelReceipt,
} from "./runCancel";

// =============================================================================
// 사람의 「중단」이 하는 말 (#3852). 웹·데스크탑 작업 패널과 폰 턴 중단이 이 문장을
// 같이 쓴다. 문장은 해요체이고, 상태 코드는 화면에 나오지 않는다.
// =============================================================================

const RESULT = {
  runId: "run-1",
  status: "cancelled" as const,
  linkedWorkSessionIds: [],
  workSessionsTerminated: false,
};

describe("runCancel — 문장", () => {
  it("확인 문장은 잃는 것과 다시 시킬 수 있다는 것을 같이 말한다", () => {
    expect(CANCEL_CONFIRM_SENTENCE).toBe(
      "중단하면 이 실행은 여기서 끝나요. 같은 일은 다시 시킬 수 있어요."
    );
    expect(cancelConfirmSentence(1)).toBe(CANCEL_CONFIRM_SENTENCE);
    expect(cancelConfirmSentence(3)).toMatch(/실행 3개를 하고 있고, 그중 가장 먼저 시작한 하나만 멈춰요\.$/);
  });

  it("영수증은 누구의 실행인지와 멈추지 않은 세션을 말한다", () => {
    expect(cancelReceipt(RESULT, "김인턴")).toBe("김인턴의 실행을 중단했어요.");
    expect(
      cancelReceipt({ ...RESULT, linkedWorkSessionIds: ["s1", "s2"] }, "김인턴")
    ).toBe(
      "김인턴의 실행을 중단했어요. 이 실행에 연결된 작업 세션 2개는 계속 돌아요. 세션은 데스크톱에서 멈출 수 있어요."
    );
  });

  it("409는 오류가 아니라 이미 끝났다는 답이고, 어떻게 끝났는지 말한다", () => {
    const outcome = cancelFailureOutcome(
      new ApiError(409, "agent run is already succeeded")
    );
    expect(outcome).toEqual({
      kind: "alreadyOver",
      sentence: "이 실행은 이미 끝났어요. 에이전트가 먼저 마쳤어요.",
    });
    expect(alreadyOverSentence("something else")).toBe("이 실행은 이미 끝났어요.");
  });

  it("권한이 없으면 누가 멈출 수 있는지 문장으로 안내한다", () => {
    for (const status of [401, 403]) {
      const outcome = cancelFailureOutcome(new ApiError(status, "forbidden"));
      expect(outcome.kind).toBe("error");
      expect(outcome.sentence).toBe(
        "중단하지 못했어요. 이 실행이 있는 채널의 멤버만 중단할 수 있어요."
      );
    }
  });

  it("어떤 실패도 상태 코드나 합쇼체를 화면에 올리지 않는다", () => {
    const errors: unknown[] = [
      new ApiError(401, "x"),
      new ApiError(403, "x"),
      new ApiError(404, "x"),
      new ApiError(405, "x"),
      new ApiError(409, "agent run is already failed"),
      new ApiError(409, "agent run is already timed_out"),
      new ApiError(429, "x"),
      new ApiError(500, "x"),
      new ApiError(503, "x"),
      new NetworkError("unreachable", 15_000),
      new Error("?"),
    ];
    for (const error of errors) {
      const { sentence } = cancelFailureOutcome(error);
      expect(sentence).not.toMatch(/\b\d{3}\b/);
      expect(sentence).not.toMatch(/니다/);
    }
    for (const sentence of [
      CANCEL_CONFIRM_SENTENCE,
      cancelConfirmSentence(2),
      cancelReceipt(RESULT, "김인턴"),
      cancelReceipt({ ...RESULT, workSessionsTerminated: true }, "김인턴"),
      cancelReceipt({ ...RESULT, linkedWorkSessionIds: ["s"] }, "김인턴"),
    ]) {
      expect(sentence).not.toMatch(/니다/);
    }
  });
});

describe("runCancel — 원장에 남는 모양", () => {
  it("서버가 사람 중단에 쓰는 코드가 원장 줄의 사유가 된다", () => {
    const rows = ledgerRows([
      { kind: "started", createdAtMs: 1_000 } as never,
      { kind: "cancelled", createdAtMs: 2_000, code: "human_cancelled" } as never,
    ]);
    const last = rows[rows.length - 1];
    expect(last.kind).toBe("cancelled");
    expect(last.text).toBe("취소됐어요");
    expect(last.reason).toBe("사람이 중단했어요");
  });
});

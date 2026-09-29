import { describe, expect, it } from "vitest";
import type { Message } from "@momo/core/lib/api";
import { receiptRunIdFor } from "./receiptGate";

const RUN = "00000000-0000-7000-8000-00000000AAAA";

function message(props: Record<string, unknown> | undefined): Message {
  return { id: "m", channelId: "c", props } as unknown as Message;
}

const TURN = { source: "agent_worker.final_text.v0", run_id: RUN };
const on = { isAgent: true, deleted: false, provided: true };

describe("receiptRunIdFor", () => {
  it("정착한 턴 기록에서만 run을 낸다", () => {
    expect(receiptRunIdFor({ message: message(TURN), ...on })).toBe(RUN.toLowerCase());
  });

  it("같은 run의 다른 행(도구 결과 등)은 묻지 않는다", () => {
    expect(
      receiptRunIdFor({ message: message({ run_id: RUN, call_id: "c1" }), ...on })
    ).toBeNull();
    expect(
      receiptRunIdFor({
        message: message({ run_id: RUN, source: "agent_worker.loop_guard.v0" }),
        ...on,
      })
    ).toBeNull();
  });

  it("사람의 메시지, 삭제된 행, 표면이 없는 서버는 묻지 않는다", () => {
    expect(receiptRunIdFor({ message: message(TURN), ...on, isAgent: false })).toBeNull();
    expect(receiptRunIdFor({ message: message(TURN), ...on, deleted: true })).toBeNull();
    expect(receiptRunIdFor({ message: message(TURN), ...on, provided: false })).toBeNull();
    expect(receiptRunIdFor({ message: message(undefined), ...on })).toBeNull();
  });
});

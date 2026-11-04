import { describe, expect, it } from "vitest";
import type { PendingMessage, TimelineItem } from "@momo/core/features/timeline/model";
import type { Message } from "@momo/core/lib/api";
import { isSystemLineMessage, startGroupAfterSystemLine } from "./systemLineRows";

// =============================================================================
// 시스템 줄 둘레의 묶음 규칙 (#5079). 화면에 서는 모양은 `Timeline.systemLine.test.tsx` 가 진짜 목록으로 재고, 여기서는 그 화면
// 시험이 닿지 않는 두 성질만 잰다: 대기 행도 같은 규칙을 받는다는 것, 바꿀 것이 없으면 입력을 그대로 돌려준다는 것(memo 보존).
// =============================================================================

const ME = "00000000-0000-7000-8000-0000000001ff";

function message(seq: number, over: Partial<Message> = {}): Message {
  return {
    id: `0199eeee-0000-7000-8000-${String(seq).padStart(12, "0")}`,
    channelId: "ch",
    seq,
    hlcTs: seq,
    hlcCount: 0,
    authorMemberId: ME,
    type: "text",
    body: `메시지 ${seq}`,
    state: "sent",
    createdAtMs: 1_700_000_000_000 + seq * 1_000,
    ...over,
  };
}

const cancel = (seq: number) =>
  message(seq, { type: "system", body: "사람이 실행을 중단했어요.", props: { kind: "agent_run_cancelled" } });

const row = (m: Message, startsGroup: boolean): TimelineItem => ({ kind: "message", key: m.id, message: m, startsGroup });

const pendingRow = (startsGroup: boolean): TimelineItem => ({
  kind: "pending",
  key: "p-1",
  startsGroup,
  pending: {
    clientMsgId: "c-1",
    channelId: "ch",
    authorMemberId: ME,
    body: "다시 해 볼게요",
    createdAtMs: 1_700_000_100_000,
    sinceSeq: 2,
    status: "sending",
  } as PendingMessage,
});

describe("startGroupAfterSystemLine", () => {
  it("줄 바로 다음의 확정 행과 대기 행이 새 묶음으로 시작한다 - 확정 전후로 이름 머리가 깜빡이지 않는다", () => {
    const afterMessage = startGroupAfterSystemLine([row(message(1), true), row(cancel(2), false), row(message(3), false)]);
    expect(afterMessage.map((item) => (item.kind === "message" ? item.startsGroup : null))).toEqual([true, false, true]);

    const afterPending = startGroupAfterSystemLine([row(message(1), true), row(cancel(2), false), pendingRow(false)]);
    expect(afterPending[2]).toMatchObject({ kind: "pending", startsGroup: true });
  });

  it("바꿀 것이 없으면 입력 배열을 그대로 돌려주고, 이미 머리인 행·시스템 줄이 아닌 행은 건드리지 않는다", () => {
    const untouched = [row(message(1), true), row(message(2), false), pendingRow(false)];
    expect(startGroupAfterSystemLine(untouched)).toBe(untouched);

    const alreadyHead = [row(cancel(1), true), row(message(2), true)];
    expect(startGroupAfterSystemLine(alreadyHead)).toBe(alreadyHead);

    // 본문이 없어 일반 행으로 남는 중단 줄은 줄이 아니므로 다음 행의 묶음을 끊지 않는다.
    const noBody = message(1, { type: "system", body: "", props: { kind: "agent_run_cancelled" } });
    expect(isSystemLineMessage(noBody)).toBe(false);
    const afterNoBody = [row(noBody, true), row(message(2), false)];
    expect(startGroupAfterSystemLine(afterNoBody)).toBe(afterNoBody);
  });
});

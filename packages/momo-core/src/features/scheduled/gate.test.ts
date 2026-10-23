import { describe, expect, it } from "vitest";
import type { AttachmentDraft, UploadIssue } from "../attachments/model";
import { sendBlockReason } from "../attachments/model";
import { containsSecretKey } from "../chat/secretKey";
import {
  contentReadiness,
  scheduleBlockTitle,
  scheduleGate,
  type ScheduleBlock,
  type ScheduleGateInput,
} from "./gate";

function draft(overrides: Partial<AttachmentDraft> = {}): AttachmentDraft {
  return {
    localId: "d1",
    name: "일정.pdf",
    mime: "application/pdf",
    sizeBytes: 1024,
    sizeKnown: true,
    status: "uploaded",
    progress: 1,
    attachmentId: "a1",
    ...overrides,
  };
}

function failedDraft(issue: UploadIssue): AttachmentDraft {
  return draft({ status: "failed", issue, attachmentId: undefined });
}

// 아무것도 막지 않는 입력. 시험마다 한 가지만 켠다.
function input(overrides: Partial<ScheduleGateInput> = {}): ScheduleGateInput {
  return {
    offered: true,
    offline: false,
    schedulerDisabled: false,
    text: "내일 회의 전에 자료 올려 둘게요",
    attachments: [],
    commandDraft: false,
    personalCall: false,
    quoting: false,
    pendingCount: 0,
    routingSet: false,
    ...overrides,
  };
}

describe("contentReadiness: the part of the send gate that send and schedule share", () => {
  it("is ready with text, or with only uploaded files (a message of files alone)", () => {
    expect(contentReadiness("글", [])).toBe("ready");
    expect(contentReadiness("", [draft()])).toBe("ready");
    expect(contentReadiness("   ", [draft()])).toBe("ready");
  });

  it("is empty with neither text nor files, blank text included", () => {
    expect(contentReadiness("", [])).toBe("empty");
    expect(contentReadiness("  \n ", [])).toBe("empty");
  });

  it("blocks on files still going up, whatever the text says: ready, uploading and verifying all count as uploading", () => {
    for (const status of ["ready", "uploading", "verifying"] as const) {
      expect(contentReadiness("글", [draft({ status })]), status).toBe("attachUploading");
    }
  });

  it("blocks on a failed file even when the text is fine, because the server rolls the whole message back", () => {
    expect(contentReadiness("글", [failedDraft("mismatch")])).toBe("attachFailed");
    expect(contentReadiness("", [failedDraft("too-large")])).toBe("attachFailed");
  });

  it("says uploading before failed when both exist, exactly as the send gate does", () => {
    const mixed = [failedDraft("mismatch"), draft({ status: "uploading", progress: 0.4 })];
    expect(sendBlockReason(mixed)).toBe("uploading");
    expect(contentReadiness("글", mixed)).toBe("attachUploading");
  });
});

describe("the entry and the order of reasons (UI spec 0.4: one at a time, the upper first)", () => {
  it("draws no entry at all when the server has no schedules (the list answered 404)", () => {
    const gate = scheduleGate(input({ offered: false, offline: true, text: "", pendingCount: 99 }));
    expect(gate).toEqual({
      entry: "hidden",
      block: null,
      lines: null,
      limitReached: false,
      secretKey: false,
      routingNote: false,
    });
  });

  it("is open when nothing blocks", () => {
    expect(scheduleGate(input())).toEqual({
      entry: "shown",
      block: null,
      lines: null,
      limitReached: false,
      secretKey: false,
      routingNote: false,
    });
  });

  // 표의 순서: 오프라인 → 서버가 예약을 껐다 → 명령 → 개인 에이전트 호출 → 인용 → 첨부 올리는 중 →
  // 첨부 실패 → 보낼 내용 없음. 앞의 사유가 켜져 있으면 뒤의 사유는 보이지 않는다.
  const everyReasonOn: ScheduleGateInput = input({
    offline: true,
    schedulerDisabled: true,
    commandDraft: true,
    personalCall: true,
    quoting: true,
    text: "",
    attachments: [draft({ status: "uploading", progress: 0.2 }), failedDraft("mismatch")],
  });
  const order: ReadonlyArray<readonly [ScheduleBlock, Partial<ScheduleGateInput>]> = [
    ["offline", { offline: false }],
    ["unavailable", { schedulerDisabled: false }],
    ["command", { commandDraft: false }],
    ["personalCall", { personalCall: false }],
    ["quote", { quoting: false }],
    ["attachUploading", { attachments: [failedDraft("mismatch")] }],
    ["attachFailed", { attachments: [] }],
    ["empty", {}],
  ];

  it("picks the first reason of the table when every reason is on, then the next once it is cleared", () => {
    let current = everyReasonOn;
    for (const [expected, clear] of order) {
      expect(scheduleGate(current).block, `expected ${expected}`).toBe(expected);
      current = { ...current, ...clear };
    }
    expect(scheduleGate(current).block).toBe("empty");
  });

  // 사유를 하나씩 켜는 입력. 첨부 둘은 합쳐서 「올리는 중 + 실패」가 함께 있는 경우도 만든다.
  function only(name: ScheduleBlock): Partial<ScheduleGateInput> {
    switch (name) {
      case "offline":
        return { offline: true };
      case "unavailable":
        return { schedulerDisabled: true };
      case "command":
        return { commandDraft: true };
      case "personalCall":
        return { personalCall: true };
      case "quote":
        return { quoting: true };
      case "attachUploading":
        return { attachments: [draft({ status: "uploading", progress: 0.2 })] };
      case "attachFailed":
        return { attachments: [failedDraft("mismatch")] };
      case "empty":
        return { text: "" };
    }
  }
  function withReasons(...names: ScheduleBlock[]): ScheduleGateInput {
    let result = input();
    for (const name of names) {
      const patch = only(name);
      result = {
        ...result,
        ...patch,
        attachments: [...result.attachments, ...(patch.attachments ?? [])],
      };
    }
    return result;
  }

  const names = order.map((entry) => entry[0]);
  const pairs = names.flatMap((upper, index) => names.slice(index + 1).map((lower) => [upper, lower] as const));

  it.each(pairs)("puts %s above %s whenever both are on", (upper, lower) => {
    expect(scheduleGate(withReasons(lower, upper)).block).toBe(upper);
    expect(scheduleGate(withReasons(upper, lower)).block).toBe(upper);
  });

  it("covers every pair of the eight reasons", () => {
    expect(pairs).toHaveLength(28);
  });
});

describe("the two lines of each reason (UI spec 0.4 and 3.1)", () => {
  it("gives the offline reason no line of its own: the composer's existing offline line speaks", () => {
    const gate = scheduleGate(input({ offline: true }));
    expect(gate.block).toBe("offline");
    expect(gate.lines).toBeNull();
    expect(scheduleBlockTitle(gate.lines)).toBeNull();
  });

  it("gives each other reason a reason line and a next-action line in the spec's words", () => {
    expect(scheduleGate(input({ schedulerDisabled: true })).lines).toEqual({
      reason: "이 서버에서는 예약을 쓸 수 없어요",
      next: "관리자에게 물어보세요",
    });
    expect(scheduleGate(input({ commandDraft: true })).lines).toEqual({
      reason: "명령은 예약할 수 없어요",
      next: "명령을 지우면 예약할 수 있어요",
    });
    expect(scheduleGate(input({ personalCall: true })).lines).toEqual({
      reason: "개인 에이전트 호출은 예약할 수 없어요",
      next: "호출을 빼면 예약할 수 있어요",
    });
    expect(scheduleGate(input({ quoting: true })).lines).toEqual({
      reason: "인용 답장은 예약할 수 없어요",
      next: "인용을 지우면 예약할 수 있어요",
    });
    expect(scheduleGate(input({ attachments: [draft({ status: "uploading", progress: 0.3 })] })).lines).toEqual({
      reason: "파일이 올라가는 중이에요",
      next: "끝나면 예약할 수 있어요",
    });
    expect(scheduleGate(input({ text: "" })).lines).toEqual({
      reason: "보낼 내용을 쓰면 예약할 수 있어요",
      next: null,
    });
  });

  it("offers 다시 올리거나 지우면 only when a failed file can be uploaded again, else 지우면", () => {
    for (const issue of ["mismatch", "unavailable"] as const) {
      expect(scheduleGate(input({ attachments: [failedDraft(issue)] })).lines).toEqual({
        reason: "올리지 못한 파일이 있어요",
        next: "다시 올리거나 지우면 예약할 수 있어요",
      });
    }
    for (const issue of ["too-large", "forbidden", "no-archive", "blocked"] as const) {
      expect(scheduleGate(input({ attachments: [failedDraft(issue)] })).lines, issue).toEqual({
        reason: "올리지 못한 파일이 있어요",
        next: "지우면 예약할 수 있어요",
      });
    }
    // 다시 올릴 수 있는 실패가 하나라도 있으면 그쪽이 이긴다(보내기의 발치 문장과 같은 판정).
    expect(
      scheduleGate(input({ attachments: [failedDraft("too-large"), failedDraft("mismatch")] })).lines?.next
    ).toBe("다시 올리거나 지우면 예약할 수 있어요");
  });

  it("joins the two lines for title and aria-describedby, a full stop after each of two sentences and none after one", () => {
    expect(scheduleBlockTitle({ reason: "인용 답장은 예약할 수 없어요", next: "인용을 지우면 예약할 수 있어요" })).toBe(
      "인용 답장은 예약할 수 없어요. 인용을 지우면 예약할 수 있어요."
    );
    expect(scheduleBlockTitle({ reason: "보낼 내용을 쓰면 예약할 수 있어요", next: null })).toBe(
      "보낼 내용을 쓰면 예약할 수 있어요"
    );
  });
});

describe("reasons that do not block the button", () => {
  it("opens the menu at 50 waiting but flags the limit so the items dim and the limit sentence leads", () => {
    const below = scheduleGate(input({ pendingCount: 49 }));
    expect(below.limitReached).toBe(false);
    const at = scheduleGate(input({ pendingCount: 50 }));
    expect(at.block).toBeNull();
    expect(at.limitReached).toBe(true);
    expect(scheduleGate(input({ pendingCount: 51 })).limitReached).toBe(true);
  });

  it("leaves the button on for text that looks like a key, and flags it so choosing is refused with the key line", () => {
    const key = "sk-ant-api03-abcdefghijklmnop1234567890ABCDEFGHIJ";
    expect(containsSecretKey(key)).toBe(true);
    const gate = scheduleGate(input({ text: `이거 써 ${key}` }));
    expect(gate.block).toBeNull();
    expect(gate.secretKey).toBe(true);
    expect(scheduleGate(input({ text: "sk-learn은 라이브러리 이름이에요" })).secretKey).toBe(false);
  });

  it("uses the send path's own secret-key check, not a second copy of the pattern", () => {
    for (const text of ["", "평범한 글", "xai-short", "sk-ant-api03-abcdefghijklmnop1234567890ABCDEFGHIJ"]) {
      expect(scheduleGate(input({ text })).secretKey, text).toBe(containsSecretKey(text));
    }
  });

  it("says that a chosen model is not carried, without blocking", () => {
    const gate = scheduleGate(input({ routingSet: true }));
    expect(gate.block).toBeNull();
    expect(gate.routingNote).toBe(true);
    expect(scheduleGate(input()).routingNote).toBe(false);
  });

  it("flags the limit and the key even while another reason blocks the button", () => {
    const gate = scheduleGate(
      input({ quoting: true, pendingCount: 50, text: "sk-ant-api03-abcdefghijklmnop1234567890ABCDEFGHIJ" })
    );
    expect(gate.block).toBe("quote");
    expect(gate.limitReached).toBe(true);
    expect(gate.secretKey).toBe(true);
  });
});

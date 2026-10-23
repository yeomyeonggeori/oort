import { describe, expect, it } from "vitest";
import { ApiError } from "../../lib/api";
import { NetworkError } from "../../lib/http";
import { WireShapeError } from "../../lib/wire";
import { SCHEDULED_COPY } from "./copy";
import { isScheduledAbsent, isSchedulerDisabled, scheduledErrorLine, type ScheduledOp } from "./errors";
import { SCHEDULED_FAILURE_REASONS } from "./types";

// UI 명세 3.3 「서버 오류 → 문장」의 표를 한 줄씩 옮겼다. 서버의 영어 `error.message`는 화면에 쓰이지 않는다.
const SERVER_ENGLISH = "the scheduled message could not be changed";

function failure(status: number, code?: string): ApiError {
  return new ApiError(status, SERVER_ENGLISH, code);
}

const LIMIT = "예약은 50개까지 걸 수 있어요. 대기 중인 예약을 지우거나 지금 보낸 뒤에 다시 해 보세요.";
const TOO_LATE = "곧 보내서 바꿀 수 없어요. 지금 보내거나 지울 수 있어요.";

type Row = readonly [ops: readonly ScheduledOp[], status: number, code: string | undefined, text: string];

const TABLE: readonly Row[] = [
  [["create", "edit", "change", "rearm"], 400, "send_at_too_soon", "1분 뒤부터 예약할 수 있어요"],
  [["create", "edit", "change", "rearm"], 400, "send_at_too_far", "120일 안에서 골라 주세요"],
  [["create", "edit"], 400, "empty_message", "보낼 글이나 첨부를 넣어 주세요"],
  [
    ["create"],
    400,
    undefined,
    "첨부 개수나 답하려는 메시지를 확인해 주세요. 첨부는 20개까지, 같은 파일은 한 번만 넣을 수 있어요.",
  ],
  [["create"], 404, undefined, "답하려던 메시지나 첨부를 찾을 수 없어요. 내용을 확인하고 다시 해 주세요."],
  [["create", "rearm"], 409, "pending_limit_reached", LIMIT],
  [
    ["create"],
    409,
    "attachment_reserved",
    "이 파일은 다른 예약에 쓰이고 있어요. 다른 파일을 고르거나 그 예약을 지워 주세요.",
  ],
  [["create"], 409, undefined, "첨부한 파일을 쓸 수 없어요. 다시 올려 주세요."],
  [["edit", "change"], 409, "scheduled_too_late", TOO_LATE],
  [["create", "edit", "change", "rearm", "delete", "sendNow"], 409, "scheduled_already_sent", "이미 보냈어요"],
  [
    ["edit", "change"],
    409,
    "scheduled_busy",
    "지금 보내는 중이라 바꿀 수 없어요. 잠시 뒤에 다시 해 주세요.",
  ],
  [["delete", "sendNow"], 409, "scheduled_busy", "지금 보내는 중이에요. 잠시 뒤에 목록을 새로 불러와 주세요."],
  [["edit", "change", "delete", "sendNow"], 404, undefined, "예약을 찾을 수 없어요. 이미 지워졌을 수 있어요."],
  [
    ["create", "edit", "change", "rearm", "delete", "sendNow"],
    429,
    undefined,
    "요청이 너무 많아요. 잠시 뒤에 다시 해 주세요.",
  ],
];

describe("server errors become the spec's sentences (UI spec 3.3)", () => {
  for (const [ops, status, code, text] of TABLE) {
    for (const op of ops) {
      it(`${op} · ${status}${code === undefined ? "" : ` ${code}`}`, () => {
        const line = scheduledErrorLine(op, failure(status, code), "채널");
        expect(line.text).toBe(text);
        expect(line.next).toBeUndefined();
        expect(line.text).not.toContain("scheduled message");
      });
    }
  }

  it("puts the 장소 word into a refused create: 채널 or 대화", () => {
    expect(scheduledErrorLine("create", failure(403), "채널").text).toBe(
      "이 채널에 예약할 수 없어요. 들어가 있는 채널인지, 첨부가 내 파일인지 확인해 주세요."
    );
    expect(scheduledErrorLine("create", failure(403), "대화").text).toBe(
      "이 대화에 예약할 수 없어요. 들어가 있는 대화인지, 첨부가 내 파일인지 확인해 주세요."
    );
  });

  it("answers a disabled scheduler with the reason line and a separate next-action line", () => {
    for (const op of ["create", "edit", "change", "rearm", "sendNow"] as const) {
      expect(scheduledErrorLine(op, failure(503, "scheduler_disabled"), "채널"), op).toEqual({
        text: "이 서버에서는 예약을 쓸 수 없어요",
        next: "관리자에게 물어보세요",
      });
    }
  });

  it("answers a refused send-now with the failure reason's reason line, for every closed reason", () => {
    for (const reason of SCHEDULED_FAILURE_REASONS) {
      const line = scheduledErrorLine("sendNow", failure(409, reason), "채널");
      expect(line.text.length, reason).toBeGreaterThan(0);
      expect(line.text, reason).not.toBe("처리하지 못했어요. 목록을 새로 불러와 다시 해 주세요.");
    }
    expect(scheduledErrorLine("sendNow", failure(409, "not_member"), "채널").text).toBe(
      "이 채널에서 나가서 보내지 못했어요"
    );
    expect(scheduledErrorLine("sendNow", failure(409, "not_member"), "대화").text).toBe(
      "이 대화에서 나가서 보내지 못했어요"
    );
    expect(scheduledErrorLine("sendNow", failure(409, "attachment_unavailable"), "채널").text).toBe(
      "첨부한 파일을 쓸 수 없어서 보내지 못했어요"
    );
  });

  it("does not read an unknown 409 code on send-now as a failure reason", () => {
    expect(scheduledErrorLine("sendNow", failure(409, "something_else"), "채널").text).toBe(
      SCHEDULED_COPY.errors.otherWrite
    );
  });

  it("tells the two 404s apart: a missing row is a sentence, the list's 404 is not an error line at all", () => {
    expect(scheduledErrorLine("delete", failure(404), "채널").text).toBe(
      "예약을 찾을 수 없어요. 이미 지워졌을 수 있어요."
    );
    expect(isScheduledAbsent(failure(404))).toBe(true);
    expect(isScheduledAbsent(failure(500))).toBe(false);
    expect(isScheduledAbsent(new NetworkError("unreachable", 15_000))).toBe(false);
  });

  it("tells a disabled scheduler from other 503s and other codes", () => {
    expect(isSchedulerDisabled(failure(503, "scheduler_disabled"))).toBe(true);
    expect(isSchedulerDisabled(failure(503))).toBe(false);
    expect(isSchedulerDisabled(failure(500, "scheduler_disabled"))).toBe(false);
    expect(isSchedulerDisabled(null)).toBe(false);
  });
});

describe("an answer that never came is not reported as a failure (UI spec 0.5, step 5)", () => {
  const dropped = new NetworkError("unreachable", 15_000);
  const timedOut = new NetworkError("timeout", 15_000);

  it("says 확인하지 못했어요 per operation, never 하지 못했어요", () => {
    expect(scheduledErrorLine("create", dropped, "채널").text).toBe(
      "예약됐는지 확인하지 못했어요. 연결을 확인하고 다시 눌러 주세요."
    );
    for (const op of ["edit", "change", "rearm"] as const) {
      expect(scheduledErrorLine(op, timedOut, "채널").text, op).toBe(
        "바뀌었는지 확인하지 못했어요. 연결을 확인하고 목록을 새로 불러와 주세요."
      );
    }
    expect(scheduledErrorLine("delete", dropped, "채널").text).toBe(
      "지워졌는지 확인하지 못했어요. 연결을 확인하고 목록을 새로 불러와 주세요."
    );
    expect(scheduledErrorLine("sendNow", dropped, "채널").text).toBe(
      "보냈는지 확인하지 못했어요. 연결을 확인하고 목록을 새로 불러와 주세요."
    );
  });
});

describe("anything else", () => {
  it("falls back to one sentence for a create and one for every other write", () => {
    expect(scheduledErrorLine("create", failure(500), "채널").text).toBe("예약하지 못했어요. 다시 해 주세요.");
    expect(scheduledErrorLine("create", new WireShapeError(), "채널").text).toBe(
      "예약하지 못했어요. 다시 해 주세요."
    );
    expect(scheduledErrorLine("create", failure(409, "scheduled_busy"), "채널").text).toBe(
      "예약하지 못했어요. 다시 해 주세요."
    );
    for (const op of ["edit", "change", "rearm", "delete", "sendNow"] as const) {
      expect(scheduledErrorLine(op, failure(500), "채널").text, op).toBe(
        "처리하지 못했어요. 목록을 새로 불러와 다시 해 주세요."
      );
      expect(scheduledErrorLine(op, new Error("boom"), "채널").text, op).toBe(
        "처리하지 못했어요. 목록을 새로 불러와 다시 해 주세요."
      );
    }
  });

  it("never shows the server's English message in any answer", () => {
    for (const status of [400, 401, 403, 404, 409, 429, 500, 503]) {
      for (const op of ["create", "edit", "change", "rearm", "delete", "sendNow"] as const) {
        const line = scheduledErrorLine(op, failure(status), "채널");
        expect(line.text).not.toContain("scheduled message");
      }
    }
  });
});

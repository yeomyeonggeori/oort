import { describe, expect, it } from "vitest";
import {
  SCHEDULED_COPY,
  SCHEDULED_UNKNOWN_CHANNEL_LABEL,
  dmConversationLabel,
  errorPlaceWord,
  failureLines,
  placeWord,
} from "./copy";
import { SCHEDULED_FAILURE_REASONS } from "./types";

// 아래 문장은 UI 명세(ADR-0208 부록 B) 3절의 표를 글자 그대로 옮긴 것이다. 코어 `copy.ts`가 이 문장과
// 한 글자라도 다르면 이 시험이 깨진다. 명세를 먼저 고치고 여기를 맞춘다.
const SPEC_3_1: ReadonlyArray<readonly [string, string]> = [
  ["trigger.label", "예약해서 보내기"],
  ["trigger.hint", "길게 눌러 예약"],
  ["disabled.empty.reason", "보낼 내용을 쓰면 예약할 수 있어요"],
  ["disabled.quote.reason", "인용 답장은 예약할 수 없어요"],
  ["disabled.quote.next", "인용을 지우면 예약할 수 있어요"],
  ["disabled.command.reason", "명령은 예약할 수 없어요"],
  ["disabled.command.next", "명령을 지우면 예약할 수 있어요"],
  ["disabled.personalCall.reason", "개인 에이전트 호출은 예약할 수 없어요"],
  ["disabled.personalCall.next", "호출을 빼면 예약할 수 있어요"],
  ["disabled.attachUploading.reason", "파일이 올라가는 중이에요"],
  ["disabled.attachUploading.next", "끝나면 예약할 수 있어요"],
  ["disabled.attachFailed.reason", "올리지 못한 파일이 있어요"],
  ["disabled.attachFailed.nextRetry", "다시 올리거나 지우면 예약할 수 있어요"],
  ["disabled.attachFailed.nextRemove", "지우면 예약할 수 있어요"],
  ["disabled.unavailable.reason", "이 서버에서는 예약을 쓸 수 없어요"],
  ["disabled.unavailable.next", "관리자에게 물어보세요"],
  ["dialog.offline", "연결이 없어서 지금은 할 수 없어요. 연결되면 다시 눌러 주세요."],
  [
    "disabled.limit",
    "예약은 50개까지 걸 수 있어요. 대기 중인 예약을 지우거나 지금 보낸 뒤에 다시 해 보세요.",
  ],
  ["secretKey.lead", "키는 채팅에 붙여 넣지 마세요. 이 메시지는 예약하지 않았어요."],
  ["menu.custom", "직접 고르기…"],
  ["menu.customDetail", "날짜와 시간을 골라요"],
  ["menu.routingNote", "모델 지정은 예약에 담기지 않아요"],
  ["preset.tomorrow", "내일"],
  ["preset.nextMonday", "다음 주 월요일"],
  ["dialog.title", "보낼 시각 고르기"],
  ["dialog.titleChange", "보낼 시각 바꾸기"],
  ["dialog.titleRearm", "다시 예약하기"],
  ["dialog.description", "고른 시각에 이 메시지를 보내요. 내 기기가 꺼져 있어도 보내요."],
  ["dialog.date", "날짜"],
  ["dialog.time", "시간"],
  ["dialog.commit", "예약하기"],
  ["dialog.commitChange", "변경하기"],
  ["dialog.cancel", "취소"],
  ["dialog.saving", "예약 중"],
  ["dialog.errSoon", "1분 뒤부터 예약할 수 있어요"],
  ["dialog.errFar", "120일 안에서 골라 주세요"],
  ["dialog.errInvalid", "날짜와 시간을 확인해 주세요"],
  ["status.sentNow", "메시지를 보냈어요"],
  ["banner.action", "보기"],
  ["nav.label", "예약됨"],
  ["list.title", "예약됨"],
  ["list.sectionFailed", "보내지 못함"],
  ["list.sectionPending", "보낼 예정"],
  ["list.soon", "곧 보내요"],
  ["list.sending", "보내는 중"],
  ["list.filterAction", "모두 보기"],
  ["action.sendNow", "지금 보내기"],
  ["action.change", "시간 바꾸기"],
  ["action.rearm", "다시 예약"],
  ["action.review", "내용 확인"],
  ["action.edit", "고치기"],
  ["action.copy", "내용 복사"],
  ["action.delete", "지우기"],
  ["lock.reason", "곧 보내서 바꿀 수 없어요"],
  ["error.tooLate", "곧 보내서 바꿀 수 없어요. 지금 보내거나 지울 수 있어요."],
  ["review.title", "내용을 확인해 주세요"],
  [
    "review.body",
    "로그인이 끝나서 멈춘 예약이에요. 내가 쓴 글이 맞는지 확인한 뒤에 보내 주세요.",
  ],
  ["review.close", "닫기"],
  ["review.bodyLabel", "예약한 메시지 본문"],
  ["edit.title", "예약한 메시지 고치기"],
  ["edit.attachNote", "첨부는 바꿀 수 없어요. 바꾸려면 지우고 다시 예약해 주세요."],
  ["edit.commit", "저장하기"],
  ["edit.saving", "저장 중"],
  ["delete.title", "예약을 지울까요?"],
  ["delete.body", "지우면 이 메시지는 보내지 않아요. 되돌릴 수 없어요."],
  ["delete.confirm", "지우기"],
  ["delete.pending", "지우는 중"],
  ["empty.title", "예약한 메시지가 없어요"],
  ["empty.bodyWeb", "메시지를 쓰고 보내기 옆 화살표에서 시각을 고르면 예약돼요"],
  ["empty.bodyPhone", "보내기 단추를 길게 누르면 예약할 수 있어요"],
  ["empty.action", "대화로 돌아가기"],
  ["load.error", "예약 목록을 불러오지 못했어요"],
  ["load.retry", "다시 불러오기"],
  ["offline.list", "연결이 없어요. 연결되면 예약을 바꿀 수 있어요."],
];

function lookup(path: string): unknown {
  return path.split(".").reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], SCHEDULED_COPY);
}

describe("scheduled copy table (UI spec section 3)", () => {
  it.each(SPEC_3_1)("%s is the spec sentence, character for character", (path, sentence) => {
    expect(lookup(path)).toBe(sentence);
  });

  it("builds the parameterised sentences the spec writes with placeholders", () => {
    const copy = SCHEDULED_COPY;
    expect(copy.menu.zone("Asia/Seoul (UTC+9)")).toBe("Asia/Seoul (UTC+9) 기준이에요");
    expect(copy.dialog.preview("내일 오전 9:00")).toBe("내일 오전 9:00에 보내요");
    expect(copy.status.scheduled("내일 오전 9:00")).toBe("내일 오전 9:00에 보낼게요");
    expect(copy.banner.pending("채널", 2)).toBe("이 채널에 예약된 메시지 2개");
    expect(copy.banner.pending("대화", 2)).toBe("이 대화에 예약된 메시지 2개");
    expect(copy.banner.pending("스레드", 1)).toBe("이 스레드에 예약된 메시지 1개");
    expect(copy.banner.failed(1)).toBe("예약한 메시지 1개를 보내지 못했어요");
    expect(copy.nav.badgeLabel(3)).toBe("보내지 못한 예약 3개");
    expect(copy.list.count(3)).toBe("내 예약 3개");
    expect(copy.list.when("10월 26일 (월) 오전 9:00")).toBe("10월 26일 (월) 오전 9:00에 보내요");
    expect(copy.list.attachments(2)).toBe("첨부 2개");
    expect(copy.list.filter("#일반")).toBe("#일반 예약만 보고 있어요");
    expect(copy.action.rowMenu("#일반", "내일 오전 9:00")).toBe("#일반, 내일 오전 9:00 예약 동작");
    expect(copy.review.attachments(2, ["일정.pdf", "변경목록.csv"])).toBe(
      "첨부 2개: 일정.pdf, 변경목록.csv"
    );
    expect(copy.review.when("내일 오전 9:00")).toBe("내일 오전 9:00에 보내려던 예약이에요");
  });

  it("picks the place word: 채널, 대화 for any DM, 스레드 for a thread reply", () => {
    expect(placeWord({ kind: "public" })).toBe("채널");
    expect(placeWord({ kind: "private" })).toBe("채널");
    expect(placeWord({ kind: "dm" })).toBe("대화");
    expect(placeWord({ kind: "dm", thread: true })).toBe("스레드");
    expect(placeWord({ kind: undefined })).toBe("채널");
    // 오류 문장은 스레드가 아니라 그 채널·대화의 멤버십을 말한다.
    expect(errorPlaceWord("dm")).toBe("대화");
    expect(errorPlaceWord("public")).toBe("채널");
  });

  it("labels a DM row with the right 과/와 and reuses the reminder's unknown-channel label", () => {
    expect(dmConversationLabel("김인턴")).toBe("김인턴과의 대화");
    expect(dmConversationLabel("하나")).toBe("하나와의 대화");
    expect(SCHEDULED_UNKNOWN_CHANNEL_LABEL).toBe("알 수 없는 채널");
  });
});

describe("failure reason sentences (UI spec 3.2)", () => {
  it("names all eight reasons with the spec's reason line and next-action line", () => {
    expect(failureLines("sessions_ended", "채널")).toEqual({
      reason: "로그인이 끝나서 예약을 멈췄어요",
      next: "내용을 확인하고 보내거나 다시 예약해 주세요",
    });
    expect(failureLines("author_inactive", "채널")).toEqual({
      reason: "계정이 정지돼 있어서 보내지 못했어요",
      next: "정지가 풀린 뒤에 다시 예약해 주세요",
    });
    expect(failureLines("missed", "채널")).toEqual({
      reason: "예약한 시각이 많이 지나서 보내지 않았어요",
      next: "지금 보내거나 다시 예약할 수 있어요",
    });
    expect(failureLines("send_error", "채널")).toEqual({
      reason: "서버 문제로 보내지 못했어요",
      next: "잠시 뒤에 지금 보내기로 다시 해 볼 수 있어요",
    });
    expect(failureLines("attachment_unavailable", "채널")).toEqual({
      reason: "첨부한 파일을 쓸 수 없어서 보내지 못했어요",
      next: "파일을 다시 올려서 새로 예약해 주세요",
    });
    expect(failureLines("root_unavailable", "채널")).toEqual({
      reason: "답하려던 메시지가 지워져서 보내지 못했어요",
      next: "내용을 복사해서 채널에 새로 보내 주세요",
    });
  });

  it("puts the 장소 word where the spec has a placeholder", () => {
    expect(failureLines("not_member", "채널")).toEqual({
      reason: "이 채널에서 나가서 보내지 못했어요",
      next: "채널에 다시 들어간 뒤에 보낼 수 있어요",
    });
    expect(failureLines("not_member", "대화")).toEqual({
      reason: "이 대화에서 나가서 보내지 못했어요",
      next: "대화에 다시 들어간 뒤에 보낼 수 있어요",
    });
    expect(failureLines("not_allowed", "대화")).toEqual({
      reason: "이 대화의 규칙 때문에 보내지 못했어요",
      next: "관리자에게 물어보세요",
    });
    expect(failureLines("root_unavailable", "대화").next).toBe("내용을 복사해서 대화에 새로 보내 주세요");
  });

  it("reads a missing reason like not_allowed, and every closed reason has two non-empty lines", () => {
    expect(failureLines(undefined, "채널")).toEqual(failureLines("not_allowed", "채널"));
    for (const reason of SCHEDULED_FAILURE_REASONS) {
      const lines = failureLines(reason, "채널");
      expect(lines.reason.length, reason).toBeGreaterThan(0);
      expect(lines.next.length, reason).toBeGreaterThan(0);
    }
  });
});

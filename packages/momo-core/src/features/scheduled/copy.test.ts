import { describe, expect, it } from "vitest";
import {
  SCHEDULED_COPY,
  SCHEDULED_UNKNOWN_CHANNEL_KEY,
  dmConversationLabel,
  errorPlaceWord,
  failureLines,
  placeWord,
} from "./copy";
import { SCHEDULED_FAILURE_REASONS } from "./types";
import type { MessageRef, PlainMessageKey } from "../../i18n/keys";
import { catalog as koCatalog } from "../../i18n/generated/ko-KR";
import { createMessageCopy } from "../../testkit";

// 문장은 사전(`scheduled.json`)에 있고 `SCHEDULED_COPY`는 그 키 표다(#6058). 명세의 문장을 단정하는 이 시험은 제품과 같은
// 한국어 생성물로 키를 풀어서 예전과 똑같이 한 글자씩 견준다.
const ko = createMessageCopy({ messageLocale: "ko-KR", catalog: koCatalog });
const say = (ref: MessageRef) => {
  const speak = ko as unknown as (key: string, values?: unknown) => string;
  return ref.values === undefined ? speak(ref.key) : speak(ref.key, ref.values);
};

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

const sayLines = (lines: { reason: MessageRef; next: MessageRef }) => ({
  reason: say(lines.reason),
  next: say(lines.next),
});

function lookup(path: string): unknown {
  return path.split(".").reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], SCHEDULED_COPY);
}

describe("scheduled copy table (UI spec section 3)", () => {
  it.each(SPEC_3_1)("%s is the spec sentence, character for character", (path, sentence) => {
    expect(ko(lookup(path) as PlainMessageKey)).toBe(sentence);
  });

  it("builds the parameterised sentences the spec writes with placeholders", () => {
    const copy = SCHEDULED_COPY;
    expect(ko(copy.menu.zone, { zone: "Asia/Seoul (UTC+9)" })).toBe("Asia/Seoul (UTC+9) 기준이에요");
    expect(ko(copy.dialog.preview, { when: "내일 오전 9:00" })).toBe("내일 오전 9:00에 보내요");
    expect(ko(copy.status.scheduled, { when: "내일 오전 9:00" })).toBe("내일 오전 9:00에 보낼게요");
    expect(ko(copy.banner.pending, { place: "channel", count: 2 })).toBe("이 채널에 예약된 메시지 2개");
    expect(ko(copy.banner.pending, { place: "dm", count: 2 })).toBe("이 대화에 예약된 메시지 2개");
    expect(ko(copy.banner.pending, { place: "thread", count: 1 })).toBe("이 스레드에 예약된 메시지 1개");
    expect(ko(copy.banner.failed, { count: 1 })).toBe("예약한 메시지 1개를 보내지 못했어요");
    expect(ko(copy.nav.badgeLabel, { count: 3 })).toBe("보내지 못한 예약 3개");
    expect(ko(copy.list.count, { count: 3 })).toBe("내 예약 3개");
    expect(ko(copy.list.when, { when: "10월 26일 (월) 오전 9:00" })).toBe("10월 26일 (월) 오전 9:00에 보내요");
    expect(ko(copy.list.attachments, { count: 2 })).toBe("첨부 2개");
    expect(ko(copy.list.filter, { placeLabel: "#일반" })).toBe("#일반 예약만 보고 있어요");
    expect(ko(copy.action.rowMenu, { channelLabel: "#일반", when: "내일 오전 9:00" })).toBe(
      "#일반, 내일 오전 9:00 예약 동작"
    );
    expect(ko(copy.review.attachments, { count: 2, names: "일정.pdf, 변경목록.csv" })).toBe(
      "첨부 2개: 일정.pdf, 변경목록.csv"
    );
    expect(ko(copy.review.when, { when: "내일 오전 9:00" })).toBe("내일 오전 9:00에 보내려던 예약이에요");
  });

  it("picks the place word: channel, dm for any DM, thread for a thread reply", () => {
    expect(placeWord({ kind: "public" })).toBe("channel");
    expect(placeWord({ kind: "private" })).toBe("channel");
    expect(placeWord({ kind: "dm" })).toBe("dm");
    expect(placeWord({ kind: "dm", thread: true })).toBe("thread");
    expect(placeWord({ kind: undefined })).toBe("channel");
    // 오류 문장은 스레드가 아니라 그 채널·대화의 멤버십을 말한다.
    expect(errorPlaceWord("dm")).toBe("dm");
    expect(errorPlaceWord("public")).toBe("channel");
  });

  it("labels a DM row with the right 과/와 and reuses the reminder's unknown-channel label", () => {
    expect(say(dmConversationLabel("김인턴"))).toBe("김인턴과의 대화");
    expect(say(dmConversationLabel("하나"))).toBe("하나와의 대화");
    expect(say(dmConversationLabel("Hermes"))).toBe("Hermes와의 대화");
    expect(ko(SCHEDULED_UNKNOWN_CHANNEL_KEY)).toBe("알 수 없는 채널");
  });
});

describe("copy failure sentence (not in the spec table, design-review #4215 round 2 M5)", () => {
  it("says it in two haeyo lines: the reason, then where the whole text can be copied from", () => {
    expect({
      reason: ko(SCHEDULED_COPY.list.copyFailed.reason),
      next: ko(SCHEDULED_COPY.list.copyFailed.next),
    }).toEqual({
      reason: "복사하지 못했어요",
      next: "고치기에서 글을 열어 복사할 수 있어요",
    });
  });

  it("names an action that exists: 고치기 is the row action that opens the whole text", () => {
    expect(ko(SCHEDULED_COPY.list.copyFailed.next)).toContain(ko(SCHEDULED_COPY.action.edit));
  });
});

describe("failure reason sentences (UI spec 3.2)", () => {
  it("names all eight reasons with the spec's reason line and next-action line", () => {
    expect(sayLines(failureLines("sessions_ended", "channel"))).toEqual({
      reason: "로그인이 끝나서 예약을 멈췄어요",
      next: "내용을 확인하고 보내거나 다시 예약해 주세요",
    });
    expect(sayLines(failureLines("author_inactive", "channel"))).toEqual({
      reason: "계정이 정지돼 있어서 보내지 못했어요",
      next: "정지가 풀린 뒤에 다시 예약해 주세요",
    });
    expect(sayLines(failureLines("missed", "channel"))).toEqual({
      reason: "예약한 시각이 많이 지나서 보내지 않았어요",
      next: "지금 보내거나 다시 예약할 수 있어요",
    });
    expect(sayLines(failureLines("send_error", "channel"))).toEqual({
      reason: "서버 문제로 보내지 못했어요",
      next: "잠시 뒤에 지금 보내기로 다시 해 볼 수 있어요",
    });
    expect(sayLines(failureLines("attachment_unavailable", "channel"))).toEqual({
      reason: "첨부한 파일을 쓸 수 없어서 보내지 못했어요",
      next: "파일을 다시 올려서 새로 예약해 주세요",
    });
    expect(sayLines(failureLines("root_unavailable", "channel"))).toEqual({
      reason: "답하려던 메시지가 지워져서 보내지 못했어요",
      next: "내용을 복사해서 채널에 새로 보내 주세요",
    });
  });

  it("puts the 장소 word where the spec has a placeholder", () => {
    expect(sayLines(failureLines("not_member", "channel"))).toEqual({
      reason: "이 채널에서 나가서 보내지 못했어요",
      next: "채널에 다시 들어간 뒤에 보낼 수 있어요",
    });
    expect(sayLines(failureLines("not_member", "dm"))).toEqual({
      reason: "이 대화에서 나가서 보내지 못했어요",
      next: "대화에 다시 들어간 뒤에 보낼 수 있어요",
    });
    expect(sayLines(failureLines("not_allowed", "dm"))).toEqual({
      reason: "이 대화의 규칙 때문에 보내지 못했어요",
      next: "관리자에게 물어보세요",
    });
    expect(say(failureLines("root_unavailable", "dm").next)).toBe("내용을 복사해서 대화에 새로 보내 주세요");
  });

  it("reads a missing reason like not_allowed, and every closed reason has two non-empty lines", () => {
    expect(failureLines(undefined, "channel")).toEqual(failureLines("not_allowed", "channel"));
    for (const reason of SCHEDULED_FAILURE_REASONS) {
      const lines = failureLines(reason, "channel");
      expect(say(lines.reason).length, reason).toBeGreaterThan(0);
      expect(say(lines.next).length, reason).toBeGreaterThan(0);
    }
  });
});

// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import type { PendingMessage } from "@momo/core/features/timeline/model";
import {
  adoptDraftAuthor,
  draftKey,
  listDrafts,
  readDraft,
  readFailedSends,
  readThreadDraft,
  rememberFailedSend,
  writeDraft,
  writeThreadDraft,
} from "./draftStore";

// 누구의 초안인가 (#5799). 실제 엔진 시험(`app/signOutDrafts.browser.test.ts`)이 로그인·만료 길 전체를 재고, 이 파일은 그 밑의 규칙을
// 하나씩 잠근다: 쓴 사람을 적고, 다른 사람·모르는 사람의 것은 읽지 않으며, 작성자를 정할 때 다른 사람의 것을 지우고, 다른 사람의
// 보내지 못한 글은 남기지 않는다.

const WS = "00000000-0000-7000-8000-000000000001";
const CH = "00000000-0000-7000-8000-000000000201";
const DOHYEON = "019f94e3-7a10-79cd-9dee-208f47edd9a8";
const SEOYEON = "019f94e3-7a10-79cd-9dee-208f47edd9b9";

function row(author: string, body: string): PendingMessage {
  return {
    clientMsgId: `0199aaaa-0000-7000-8000-${author.slice(-12)}`,
    channelId: CH,
    authorMemberId: author,
    body,
    createdAtMs: 1,
    sinceSeq: null,
    status: "failed",
  } as PendingMessage;
}

beforeEach(() => {
  localStorage.clear();
});

describe("초안의 작성자 (#5799)", () => {
  it("쓴 사람을 적고, 같은 사람에게만 돌려준다 — 다른 사람·작성자를 모르는 값은 읽지 않는다", () => {
    adoptDraftAuthor(DOHYEON);
    writeDraft(WS, CH, "도현의 초안");
    expect(JSON.parse(localStorage.getItem(draftKey(WS, CH)) ?? "{}").author).toBe(DOHYEON);
    expect(readDraft(WS, CH)).toBe("도현의 초안");

    adoptDraftAuthor(SEOYEON);
    // 다른 사람의 값과 작성자를 모르는 값.
    localStorage.setItem(draftKey(WS, CH), JSON.stringify({ text: "앞 사람의 글", atMs: Date.now(), author: DOHYEON }));
    localStorage.setItem(draftKey(WS, "옛-대화"), JSON.stringify({ text: "옛 글", atMs: Date.now() }));
    localStorage.setItem(`momo.thread-draft.v1:${WS}:뿌리`, JSON.stringify({ text: "앞 사람의 답글", atMs: Date.now(), author: DOHYEON }));
    expect(readDraft(WS, CH)).toBe("");
    expect(readDraft(WS, "옛-대화")).toBe("");
    expect(readThreadDraft(WS, "뿌리")).toBe("");
    expect(listDrafts().map((d) => d.text)).toEqual([]);
  });

  it("작성자를 정하면 다른 사람이 남긴 것(작성자를 모르는 값 포함)을 지우고 그 사람의 것은 남긴다", () => {
    adoptDraftAuthor(DOHYEON);
    writeDraft(WS, CH, "도현의 초안");
    writeThreadDraft(WS, "뿌리", "도현의 답글");
    rememberFailedSend(WS, row(DOHYEON, "도현의 못 보낸 글"), null);
    localStorage.setItem(draftKey(WS, "옛-대화"), JSON.stringify({ text: "옛 글", atMs: Date.now() }));

    adoptDraftAuthor(DOHYEON); // 같은 사람: 옛 값만 지운다
    expect(readDraft(WS, CH)).toBe("도현의 초안");
    expect(readThreadDraft(WS, "뿌리")).toBe("도현의 답글");
    expect(readFailedSends(WS, CH, DOHYEON).map((r) => r.row.body)).toEqual(["도현의 못 보낸 글"]);
    expect(localStorage.getItem(draftKey(WS, "옛-대화"))).toBeNull();

    adoptDraftAuthor(SEOYEON); // 다른 사람: 앞 사람의 것은 이 기기에 남지 않는다
    expect(Object.values(localStorage).some((value) => value.includes("도현의"))).toBe(false);
  });

  it("다른 사람이 작성자로 선 뒤에는 앞 사람의 보내지 못한 글을 남기지 않는다", () => {
    adoptDraftAuthor(SEOYEON);
    rememberFailedSend(WS, row(DOHYEON, "앞 사람의 글"), null);
    rememberFailedSend(WS, row(SEOYEON, "서연의 글"), null);
    expect(Object.values(localStorage).some((value) => value.includes("앞 사람의 글"))).toBe(false);
    expect(readFailedSends(WS, CH, SEOYEON).map((r) => r.row.body)).toEqual(["서연의 글"]);
  });
});

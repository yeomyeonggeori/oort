import { describe, expect, it } from "vitest";
import type { Message, MessageAttachment } from "../../lib/api";
import {
  addPending,
  buildTimelineItems,
  discardPending,
  failPending,
  retryPending,
  unsettledPending,
  type PendingMessage,
} from "./model";

// =============================================================================
// #5210: 보내지 못한 메시지를 지우는 판정. 웹·폰 훅은 `discardPending` 의 답을 그대로 따르므로
// 판정의 모든 갈래(대기·보내는 중·실패·서버 확인됨)가 여기서 한 번씩 잠긴다.
// =============================================================================

const ME = "0199aaaa-0000-7000-8000-000000000001";
const DAY = new Date(2026, 10, 3, 14, 0, 0).getTime();

function pending(
  clientMsgId: string,
  body: string,
  overrides: Partial<PendingMessage> = {}
): PendingMessage {
  return {
    clientMsgId,
    channelId: "c",
    authorMemberId: ME,
    body,
    createdAtMs: DAY,
    sinceSeq: 10,
    status: "sending",
    ...overrides,
  };
}

function confirmed(seq: number, body: string): Message {
  return {
    id: `id-${seq}`,
    channelId: "c",
    seq,
    hlcTs: seq,
    hlcCount: 0,
    authorMemberId: ME,
    type: "text",
    body,
    state: "sent",
    createdAtMs: DAY,
  };
}

const FILE: MessageAttachment = {
  id: "0199cccc-0000-7000-8000-0000000000f1",
  name: "견적서.pdf",
  mime: "application/pdf",
  sizeBytes: 48_213,
};

const ids = (list: PendingMessage[]) => list.map((p) => p.clientMsgId);

describe("discardPending: 지울 수 있는 것은 마지막 시도가 끝난 로컬 행뿐이다", () => {
  it("failed 행을 지우고, 지운 행(본문·첨부 그대로)을 돌려준다", () => {
    const text = pending("k1", "배포 끝났어요", { status: "failed" });
    const withFile = pending("k2", "견적서 보냅니다", {
      status: "failed",
      attachments: [FILE],
    });
    const result = discardPending([text, withFile], "k2");
    expect(ids(result.list)).toEqual(["k1"]);
    // 같은 객체다: 「지우고 고쳐 쓰기」를 붙이는 날 호출자가 본문·첨부를 여기서 읽는다.
    expect(result.discarded).toBe(withFile);
    expect(result.discarded?.attachments).toEqual([FILE]);
    expect(result.refused).toBeUndefined();
  });

  it("보내는 중인 행은 지우지 않는다: 이 키의 요청이 날아가는 중이라 서버가 이미 받았을 수 있다", () => {
    const sending = pending("k1", "보내는 중");
    const list = [sending];
    const result = discardPending(list, "k1");
    expect(result.refused).toBe("sending");
    expect(result.discarded).toBeNull();
    // 같은 배열이다: 훅이 setState 를 건너뛴다.
    expect(result.list).toBe(list);
    expect(list[0]?.status).toBe("sending");
  });

  it("행이 없으면 아무것도 하지 않는다", () => {
    const other = pending("k1", "다른 글", { status: "failed" });
    const list = [other];
    expect(discardPending([], "k1")).toEqual({
      list: [],
      discarded: null,
      refused: "gone",
    });
    const result = discardPending(list, "없는-키");
    expect(result.refused).toBe("gone");
    expect(result.list).toBe(list);
  });

  it("키로 지운다: 같은 본문의 다른 실패 행은 그대로다", () => {
    const first = pending("k1", "네", { status: "failed" });
    const second = pending("k2", "네", { status: "failed" });
    const result = discardPending([first, second], "k2");
    expect(result.list).toEqual([first]);
    expect(result.list[0]).toBe(first);
  });

  it("입력 목록과 행을 바꾸지 않는다", () => {
    const row = Object.freeze(pending("k1", "고정", { status: "failed" }));
    const list = Object.freeze([row]) as PendingMessage[];
    const result = discardPending(list, "k1");
    expect(result.list).toEqual([]);
    expect(list).toHaveLength(1);
    expect(row.status).toBe("failed");
  });
});

describe("discardPending: 다시 보내기와 같은 키로 겨루지 않는다", () => {
  it("다시 보내기를 누른 순간부터 지우기는 막힌다. 키는 그대로이고, 다시 실패하면 지울 수 있다", () => {
    const failed = failPending(addPending([], pending("k1", "재시도")), "k1");
    const retried = retryPending(failed, "k1");
    expect(retried[0]?.clientMsgId).toBe("k1");
    expect(retried[0]?.status).toBe("sending");

    const blocked = discardPending(retried, "k1");
    expect(blocked.refused).toBe("sending");
    expect(blocked.list).toBe(retried);

    const failedAgain = failPending(retried, "k1");
    const allowed = discardPending(failedAgain, "k1");
    expect(allowed.discarded?.clientMsgId).toBe("k1");
    expect(allowed.list).toEqual([]);
  });

  it("지운 뒤의 다시 보내기는 행을 되살리지 못한다", () => {
    const failed = failPending(addPending([], pending("k1", "지울 글")), "k1");
    const { list } = discardPending(failed, "k1");
    expect(retryPending(list, "k1")).toEqual([]);
    expect(failPending(list, "k1")).toEqual([]);
  });

  it("다시 보내기가 멱등키를 바꾸지 않는다: 실패한 요청이 이미 커밋됐어도 서버는 같은 메시지를 돌려준다", () => {
    const failed = failPending(
      addPending([], pending("k-same", "한 번만", { attachments: [FILE] })),
      "k-same"
    );
    const retried = retryPending(failed, "k-same");
    expect(retried[0]).toMatchObject({
      clientMsgId: "k-same",
      body: "한 번만",
      attachments: [FILE],
      status: "sending",
    });
  });
});

describe("discardPending: 서버가 받아 버린 뒤에는 지울 행도, 건드릴 메시지도 없다", () => {
  it("echo 가 행을 정착시키면 대기 목록에는 지울 것이 없고 확정 메시지는 그대로다", () => {
    const failed = pending("k1", "네", { status: "failed", sinceSeq: 10 });
    const twin = confirmed(11, "네");
    const open = unsettledPending([twin], [failed]);
    expect(open).toEqual([]);

    const result = discardPending(open, "k1");
    expect(result.refused).toBe("gone");
    expect(buildTimelineItems([twin], { pending: result.list }).map((i) => i.kind))
      .toEqual(["day", "message"]);
  });

  it("정착이 쓸어내기 전의 낡은 행을 지워도 확정 메시지는 줄지 않는다", () => {
    // 응답이 유실돼 실패로 보였지만 서버는 받았다. 확정 행이 이미 화면에 있다(렌더 접기가 낡은
    // 행을 숨긴다). 그 사이에 지우기가 닿아도 지워지는 것은 로컬 행뿐이다.
    const failed = pending("k1", "네", { status: "failed", sinceSeq: 10 });
    const twin = confirmed(11, "네");
    const kinds = (list: PendingMessage[]) =>
      buildTimelineItems([twin], { pending: list }).map((i) => i.kind);
    expect(kinds([failed])).toEqual(["day", "message"]);
    const result = discardPending([failed], "k1");
    expect(result.discarded).toBe(failed);
    expect(kinds(result.list)).toEqual(["day", "message"]);
  });

  it("확정 메시지 하나는 가장 오래된 행 하나만 정착시키고, 남은 행은 키로 지운다", () => {
    const first = pending("k1", "네", { status: "failed", sinceSeq: 10 });
    const second = pending("k2", "네", { status: "failed", sinceSeq: 10 });
    const open = unsettledPending([confirmed(11, "네")], [first, second]);
    expect(ids(open)).toEqual(["k2"]);
    expect(discardPending(open, "k2").list).toEqual([]);
    expect(discardPending(open, "k1").refused).toBe("gone");
  });
});

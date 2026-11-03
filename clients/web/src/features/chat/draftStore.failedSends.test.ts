// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import type { PendingMessage } from "@momo/core/features/timeline/model";
import {
  DRAFT_TTL_MS,
  MAX_FAILED_SENDS,
  clearAllDrafts,
  forgetFailedSend,
  readFailedSends,
  rememberFailedSend,
} from "./draftStore";

// #5221: 보내지 못한 글을 이 기기에 남기는 규칙. 초안과 같은 규칙이다(머리말): 30일, 정원, 비밀 키 거부, 로그아웃에 지움.
// 한 행이 한 열쇠라 서로의 것을 덮지 않는다.

const WS = "00000000-0000-7000-8000-000000000001";
const CH = "00000000-0000-7000-8000-000000000002";
const CH_B = "00000000-0000-7000-8000-000000000003";
const ME = "00000000-0000-7000-8000-0000000001ff";
const OTHER = "00000000-0000-7000-8000-0000000001aa";
const T0 = 1_800_000_000_000;

function row(id: string, over: Partial<PendingMessage> = {}): PendingMessage {
  return {
    clientMsgId: id,
    channelId: CH,
    authorMemberId: ME,
    body: `본문 ${id}`,
    createdAtMs: T0,
    sinceSeq: 7,
    status: "failed",
    ...over,
  };
}

const keysOf = () => Object.keys(localStorage).filter((key) => key.startsWith("momo.failed-send.v1:"));

beforeEach(() => localStorage.clear());

describe("보내지 못한 글의 저장소", () => {
  // 지키는 것: 행 전체가 돌아온다(멱등 키·첨부·인용·모델 고르기·미리보기 끔). 상태는 언제나 「못 보낸」이다.
  it("행 전체를 보낸 순서대로 돌려주고, 보내는 중이던 행도 못 보낸 행으로 돌아온다", () => {
    const withAttachment = row("b", {
      createdAtMs: T0 + 2,
      status: "sending",
      replyToId: "q1",
      suppressUnfurl: true,
      attachments: [{ id: "f1", name: "보고서.pdf", mime: "application/pdf", sizeBytes: 10 }] as never,
    });
    rememberFailedSend(WS, withAttachment, "server", T0 + 5);
    rememberFailedSend(WS, row("a", { createdAtMs: T0 + 1 }), "rejected", T0 + 6);
    const back = readFailedSends(WS, CH, ME, T0 + 10);
    expect(back.map((entry) => entry.row.clientMsgId)).toEqual(["a", "b"]);
    expect(back.map((entry) => entry.kind)).toEqual(["rejected", "server"]);
    expect(back[1]?.row).toMatchObject({ ...withAttachment, status: "failed" });
  });

  // 지키는 것: 채널·작성자 경계. 다른 채널의 글과 같은 기기를 나눠 쓰는 다른 계정의 글은 돌려주지 않는다.
  it("다른 채널의 글과 다른 작성자의 글은 돌려주지 않는다", () => {
    rememberFailedSend(WS, row("a"), null, T0);
    rememberFailedSend(WS, row("b", { channelId: CH_B }), null, T0);
    expect(readFailedSends(WS, CH, ME, T0).map((e) => e.row.clientMsgId)).toEqual(["a"]);
    expect(readFailedSends(WS, CH_B, ME, T0).map((e) => e.row.clientMsgId)).toEqual(["b"]);
    expect(readFailedSends(WS, CH, OTHER, T0)).toEqual([]);
  });

  // 지키는 것: 30일 수명. 읽을 때 판정하고 폐기한다(경계 값은 남긴다).
  it("30일이 지난 글은 읽는 순간 버리고, 정확히 30일이면 남긴다", () => {
    rememberFailedSend(WS, row("old"), null, T0);
    expect(readFailedSends(WS, CH, ME, T0 + DRAFT_TTL_MS).map((e) => e.row.clientMsgId)).toEqual(["old"]);
    expect(readFailedSends(WS, CH, ME, T0 + DRAFT_TTL_MS + 1)).toEqual([]);
    expect(keysOf()).toEqual([]);
  });

  // 지키는 것: 정원. 넘치면 가장 오래된 것부터 버린다(쓰는 글은 언제나 산다).
  it("정원을 넘기면 가장 오래된 글부터 버리고 방금 남긴 글은 산다", () => {
    for (let i = 0; i < MAX_FAILED_SENDS + 3; i++) {
      rememberFailedSend(WS, row(`r${String(i).padStart(3, "0")}`, { createdAtMs: T0 + i }), null, T0 + i);
    }
    expect(keysOf()).toHaveLength(MAX_FAILED_SENDS);
    const ids = readFailedSends(WS, CH, ME, T0 + 1000).map((e) => e.row.clientMsgId);
    expect(ids).not.toContain("r000");
    expect(ids).not.toContain("r002");
    expect(ids).toContain("r003");
    expect(ids).toContain(`r${String(MAX_FAILED_SENDS + 2).padStart(3, "0")}`);
  });

  // 지키는 것: 읽는 쪽도 상태를 「못 보낸」으로 고정한다(옛 판·손으로 고친 항목이 보내는 중으로 되살아나지 않게).
  it("저장본에 보내는 중이라고 적혀 있어도 못 보낸 행으로 돌아온다", () => {
    localStorage.setItem(
      `momo.failed-send.v1:${WS}:${CH}:planted`,
      JSON.stringify({ row: { ...row("planted"), status: "sending" }, kind: null, atMs: T0 })
    );
    expect(readFailedSends(WS, CH, ME, T0).map((e) => [e.row.clientMsgId, e.row.status])).toEqual([
      ["planted", "failed"],
    ]);
  });

  // 지키는 것: 읽을 수 없는 항목은 항목이 아니다(손으로 고쳐졌거나 옛 판). 읽는 김에 지운다.
  it("깨진 항목은 돌려주지 않고 지운다", () => {
    localStorage.setItem(`momo.failed-send.v1:${WS}:${CH}:bad`, "{not json");
    localStorage.setItem(
      `momo.failed-send.v1:${WS}:${CH}:odd`,
      JSON.stringify({ row: { clientMsgId: "odd" }, kind: null, atMs: T0 })
    );
    expect(readFailedSends(WS, CH, ME, T0)).toEqual([]);
    expect(keysOf()).toEqual([]);
  });

  // 지키는 것: 키 모양이 든 글은 두지 않고, 이미 있던 것도 지운다. 지우기와 로그아웃은 기기에서 지운다.
  it("키 모양이 든 글은 남기지 않고, forget 과 로그아웃은 기기에서 지운다", () => {
    rememberFailedSend(WS, row("a"), null, T0);
    rememberFailedSend(WS, row("a", { body: `sk-ant-${"a1".repeat(12)}` }), null, T0 + 1);
    expect(keysOf()).toEqual([]);
    rememberFailedSend(WS, row("b"), null, T0);
    rememberFailedSend(WS, row("c"), null, T0);
    forgetFailedSend(WS, CH, "b");
    expect(readFailedSends(WS, CH, ME, T0).map((e) => e.row.clientMsgId)).toEqual(["c"]);
    clearAllDrafts();
    expect(keysOf()).toEqual([]);
  });
});

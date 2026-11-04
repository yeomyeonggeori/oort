import { describe, expect, it } from "vitest";
import type { PendingMessage } from "../timeline/model";
import { parseFailedSend, serializeFailedSend } from "./failedSendRecord";

const T0 = 1_800_000_000_000;
const row: PendingMessage = {
  clientMsgId: "k1",
  channelId: "c1",
  authorMemberId: "m1",
  body: "금요일 공지",
  createdAtMs: T0,
  sinceSeq: 7,
  status: "sending",
  replyToId: "q1",
  suppressUnfurl: true,
};

describe("남겨 둔 못 보낸 글의 모양", () => {
  // 지키는 것: 쓴 것이 그대로 읽힌다(멱등 키·인용·미리보기 끔). 상태만 못 보낸 쪽으로 고정된다.
  it("한 건을 문자열로 만들고 되읽으면 같은 행이고 상태만 못 보낸으로 바뀐다", () => {
    const back = parseFailedSend(serializeFailedSend(row, "server", T0 + 9));
    expect(back).toEqual({ row: { ...row, status: "failed" }, kind: "server", atMs: T0 + 9 });
  });

  // 지키는 것: 읽는 쪽도 상태를 못 보낸으로 고정한다(보내는 중이라 적힌 옛 판·손으로 고친 항목).
  it("저장본에 보내는 중이라고 적혀 있어도 못 보낸으로 돌려준다", () => {
    const planted = JSON.stringify({ row, kind: null, atMs: T0 });
    expect(parseFailedSend(planted)?.row.status).toBe("failed");
  });

  // 지키는 것: 모르는 종류는 종류 없음으로 읽는다(이름을 믿지 않는다).
  it("모르는 종류 이름은 null 로 읽는다", () => {
    const odd = JSON.stringify({ row, kind: "teapot", atMs: T0 });
    expect(parseFailedSend(odd)?.kind).toBeNull();
  });

  // 지키는 것: 모양이 어긋난 항목은 항목이 아니다.
  it("읽을 수 없거나 칸이 모자라거나 모양이 다르면 null", () => {
    for (const raw of [
      null,
      "{not json",
      "[]",
      "null",
      JSON.stringify({ row, kind: null }),
      JSON.stringify({ row: { ...row, clientMsgId: "" }, kind: null, atMs: T0 }),
      JSON.stringify({ row: { ...row, body: 3 }, kind: null, atMs: T0 }),
      JSON.stringify({ row: { ...row, sinceSeq: "7" }, kind: null, atMs: T0 }),
      JSON.stringify({ row: { ...row, attachments: "x" }, kind: null, atMs: T0 }),
      JSON.stringify({ row: { ...row, createdAtMs: "x" }, kind: null, atMs: T0 }),
      JSON.stringify({ row: { ...row, authorMemberId: "" }, kind: null, atMs: T0 }),
      JSON.stringify({ row: { ...row, channelId: 1 }, kind: null, atMs: T0 }),
    ]) {
      expect(parseFailedSend(raw)).toBeNull();
    }
    // 이어서 sinceSeq 가 null 인 행(첫 전송 전 빈 채널)은 정상이다.
    expect(parseFailedSend(serializeFailedSend({ ...row, sinceSeq: null }, null, T0))?.row.sinceSeq).toBeNull();
  });
});

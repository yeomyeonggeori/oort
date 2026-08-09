import { describe, expect, it } from "vitest";
import { attachmentsFromWire, payloadToMessage } from "./realtimeEvents";

// 실시간 프레임이 나르는 첨부 (ADR-0151).
//
// 서버가 이 배열을 outbox 행에 박아 넣기로 한 결정에는 이유가 있고
// (`build_broadcast_payload` 의 주석: 첨부 행은 complete 된 뒤 불변이므로 영원히
// 재생되는 행에 실려도 참이다), 그 결정 덕분에 클라는 실시간으로 온 메시지에도
// 파일 카드를 그릴 수 있다. 그러려면 컨버터가 그 키를 실제로 읽어야 한다 —
// #1202 이전의 `payloadToMessage` 는 모르는 키를 조용히 버렸고, 그 상태로는
// 실시간으로 도착한 첨부 메시지가 새로고침 전까지 파일 없는 메시지로 보인다.

function frame(over: Record<string, unknown> = {}) {
  return {
    id: "0199cccc-0000-7000-8000-000000000001",
    channel_id: "00000000-0000-7000-8000-000000000201",
    seq: 12,
    type: "text",
    body: "로그 붙입니다",
    author_member_id: "00000000-0000-7000-8000-000000000101",
    hlc_ts: 1,
    hlc_count: 0,
    ...over,
  } as Parameters<typeof payloadToMessage>[0];
}

describe("realtime attachments", () => {
  it("carries the attachments a live frame declares", () => {
    const message = payloadToMessage(
      frame({
        attachments: [
          { id: "att-1", name: "drain.log", mime: "text/plain", sizeBytes: 18 },
        ],
      })
    );
    expect(message.attachments).toEqual([
      { id: "att-1", name: "drain.log", mime: "text/plain", sizeBytes: 18 },
    ]);
  });

  it("leaves the field absent when the frame carries none", () => {
    expect(payloadToMessage(frame()).attachments).toBeUndefined();
    expect(payloadToMessage(frame({ attachments: [] })).attachments).toBeUndefined();
  });

  it("drops only the malformed entry, never the whole array", () => {
    const parsed = attachmentsFromWire([
      { id: "att-1", name: "a.txt", mime: "text/plain", sizeBytes: 1 },
      { id: "att-2", name: "b.txt", mime: "text/plain" },
      { id: "att-3", name: "c.txt", mime: "text/plain", sizeBytes: 3 },
    ]);
    expect(parsed.map((a) => a.id)).toEqual(["att-1", "att-3"]);
  });

  it("answers empty for anything that is not an array", () => {
    expect(attachmentsFromWire(undefined)).toEqual([]);
    expect(attachmentsFromWire(null)).toEqual([]);
    expect(attachmentsFromWire({ id: "att-1" })).toEqual([]);
  });
});

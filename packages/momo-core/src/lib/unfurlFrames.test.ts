import { describe, expect, it } from "vitest";
import { asUnfurlFrame } from "./realtimeEvents";

const FRAME = {
  type: "message.unfurl",
  v: 1,
  ts: 1_700_000_000_000,
  seq: 42,
  payload: {
    message_id: "m-1",
    channel_id: "c-1",
    unfurls: [
      {
        id: "u-1",
        message_id: "m-1",
        url: "https://example.com/guide",
        status: "ok",
        title: "가이드",
        image_url: "/v1/workspaces/w-1/unfurls/u-1/image",
      },
    ],
  },
};

describe("unfurl frames", () => {
  it("normalises the full projection", () => {
    const frame = asUnfurlFrame(FRAME);
    expect(frame?.type).toBe("message.unfurl");
    if (frame?.type === "message.unfurl") {
      expect(frame.payload.unfurls[0]).toMatchObject({
        messageId: "m-1",
        status: "ok",
        imageUrl: "/v1/workspaces/w-1/unfurls/u-1/image",
      });
    }
  });

  it("accepts a removal without carrying old metadata", () => {
    expect(
      asUnfurlFrame({
        type: "message.unfurl.removed",
        v: 1,
        ts: FRAME.ts,
        seq: FRAME.seq,
        payload: { message_id: "m-1", channel_id: "c-1" },
      })
    ).toMatchObject({ type: "message.unfurl.removed", payload: { message_id: "m-1" } });
  });

  it("drops a partial projection instead of erasing valid local cards", () => {
    expect(
      asUnfurlFrame({
        ...FRAME,
        payload: { ...FRAME.payload, unfurls: [{ status: "ok" }] },
      })
    ).toBeNull();
    expect(asUnfurlFrame({ ...FRAME, v: 2 })).toBeNull();
  });
});

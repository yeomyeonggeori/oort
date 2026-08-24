import { describe, expect, it } from "vitest";
import {
  clearMessageUnfurls,
  emptyUnfurls,
  mergeColdMessageUnfurls,
  messageUnfurlFromWire,
  replaceMessageUnfurls,
  unfurlRenderState,
  unfurlsFor,
  type MessageUnfurl,
} from "./unfurl";

const ok: MessageUnfurl = {
  id: "u-1",
  messageId: "M-1",
  url: "https://example.com/guide",
  status: "ok",
  title: "운영 가이드",
};

describe("unfurl state", () => {
  it("names all four rendering states", () => {
    expect(unfurlRenderState(undefined)).toEqual({ kind: "empty" });
    expect(unfurlRenderState({ ...ok, status: "pending" }).kind).toBe("pending");
    expect(unfurlRenderState(ok).kind).toBe("ok");
    expect(unfurlRenderState({ ...ok, status: "failed" })).toEqual({
      kind: "quiet",
      reason: "failed",
    });
    expect(unfurlRenderState({ ...ok, status: "blocked" })).toEqual({
      kind: "quiet",
      reason: "blocked",
    });
  });

  it("keeps a live update and removal ahead of a racing REST answer", () => {
    const live = replaceMessageUnfurls(emptyUnfurls(), "M-1", [ok]);
    expect(mergeColdMessageUnfurls(live, "m-1", [])).toBe(live);

    const removed = clearMessageUnfurls(live, "M-1");
    expect(mergeColdMessageUnfurls(removed, "m-1", [ok])).toBe(removed);
    expect(unfurlsFor(removed, "M-1")).toEqual([]);
  });

  it("accepts the realtime row but keeps only an authenticated proxy image", () => {
    expect(
      messageUnfurlFromWire({
        id: "u-1",
        message_id: "m-1",
        url: "https://example.com",
        status: "ok",
        title: "Example",
        image_url: "/v1/workspaces/w-1/unfurls/u-1/image",
      })
    ).toEqual({
      id: "u-1",
      messageId: "m-1",
      url: "https://example.com",
      status: "ok",
      title: "Example",
      imageUrl: "/v1/workspaces/w-1/unfurls/u-1/image",
    });

    expect(
      messageUnfurlFromWire({
        id: "u-2",
        messageId: "m-1",
        url: "https://example.com",
        status: "ok",
        imageUrl: "https://remote.example/image.png",
      })?.imageUrl
    ).toBeUndefined();
    expect(
      messageUnfurlFromWire({
        id: "u-3",
        messageId: "m-1",
        url: "javascript:alert(1)",
        status: "ok",
      })
    ).toBeNull();
  });
});

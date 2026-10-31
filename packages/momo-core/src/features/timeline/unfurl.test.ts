import { describe, expect, it } from "vitest";
import {
  clearMessageUnfurls,
  emptyUnfurls,
  isUnfurlIconPath,
  isUnfurlImagePath,
  isUnfurlProxyPath,
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

// ADR-0170 amendment 2026-10-31 (#4881): the optional card fields.
describe("unfurl site metadata", () => {
  const row = {
    id: "u-1",
    messageId: "m-1",
    url: "https://example.com/story",
    status: "ok",
  };
  const ICON = "/v1/workspaces/w-1/unfurls/u-1/icon";
  const IMAGE = "/v1/workspaces/w-1/unfurls/u-1/image";

  it("reads the REST camelCase and the realtime snake_case spellings alike", () => {
    const expected = {
      id: "u-1",
      messageId: "m-1",
      url: "https://example.com/story",
      status: "ok",
      siteName: "News Example",
      iconUrl: ICON,
      imageWidth: 1200,
      imageHeight: 630,
      isVideo: true,
    };
    expect(
      messageUnfurlFromWire({
        ...row,
        siteName: "News Example",
        iconUrl: ICON,
        imageWidth: 1200,
        imageHeight: 630,
        isVideo: true,
      })
    ).toStrictEqual(expected);
    expect(
      messageUnfurlFromWire({
        id: "u-1",
        message_id: "m-1",
        url: "https://example.com/story",
        status: "ok",
        site_name: "News Example",
        icon_url: ICON,
        image_width: 1200,
        image_height: 630,
        is_video: true,
      })
    ).toStrictEqual(expected);
  });

  it("decodes a row from a server without the new fields to exactly the old shape", () => {
    expect(
      messageUnfurlFromWire({ ...row, title: "T", imageUrl: IMAGE })
    ).toStrictEqual({ ...row, title: "T", imageUrl: IMAGE });
  });

  it("keeps an icon only as the icon proxy path", () => {
    for (const bad of [
      "https://remote.example/favicon.ico",
      "//remote.example/favicon.ico",
      IMAGE,
      `${ICON}?x=1`,
      `${ICON}/extra`,
      "/v1/workspaces/w-1/unfurls/u-1/icon.svg",
      "javascript:alert(1)",
      "",
    ]) {
      const decoded = messageUnfurlFromWire({ ...row, iconUrl: bad });
      expect(decoded, bad).not.toBeNull();
      expect(decoded?.iconUrl, bad).toBeUndefined();
    }
    // The two proxy paths are not interchangeable.
    expect(isUnfurlIconPath(ICON)).toBe(true);
    expect(isUnfurlIconPath(IMAGE)).toBe(false);
    expect(isUnfurlImagePath(ICON)).toBe(false);
    expect(isUnfurlProxyPath(ICON) && isUnfurlProxyPath(IMAGE)).toBe(true);
    expect(isUnfurlProxyPath("https://remote.example/x.png")).toBe(false);
    // And an image path is still not accepted where the picture goes if it is the icon's.
    expect(messageUnfurlFromWire({ ...row, imageUrl: ICON })?.imageUrl).toBeUndefined();
  });

  it("takes a size only as an integer pair inside 1..16384", () => {
    const sizes = (width: unknown, height: unknown) => {
      const decoded = messageUnfurlFromWire({ ...row, imageWidth: width, imageHeight: height });
      return [decoded?.imageWidth, decoded?.imageHeight];
    };
    expect(sizes(1200, 630)).toEqual([1200, 630]);
    expect(sizes(1, 16384)).toEqual([1, 16384]);
    for (const [width, height] of [
      [1200, undefined],
      [undefined, 630],
      [0, 630],
      [1200, -1],
      [16385, 630],
      [12.5, 630],
      ["1200", "630"],
      [Number.NaN, 630],
      [Number.POSITIVE_INFINITY, 630],
      [null, null],
    ]) {
      expect(sizes(width, height), `${String(width)}x${String(height)}`).toEqual([
        undefined,
        undefined,
      ]);
    }
  });

  it("takes isVideo only when it is exactly true and a site name only as text", () => {
    expect(messageUnfurlFromWire({ ...row, isVideo: true })?.isVideo).toBe(true);
    for (const bad of [false, "true", 1, null, {}]) {
      expect(messageUnfurlFromWire({ ...row, isVideo: bad })).toStrictEqual(row);
    }
    expect(messageUnfurlFromWire({ ...row, siteName: "" })).toStrictEqual(row);
    expect(messageUnfurlFromWire({ ...row, siteName: 42 })).toStrictEqual(row);
  });
});

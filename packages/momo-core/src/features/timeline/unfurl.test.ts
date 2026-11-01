import { describe, expect, it } from "vitest";
import {
  DEFAULT_UNFURL_SIZE,
  UNFURL_MAX_CARDS,
  clearMessageUnfurls,
  emptyUnfurls,
  isUnfurlIconPath,
  isUnfurlImagePath,
  isUnfurlProxyPath,
  mergeColdMessageUnfurls,
  messageUnfurlFromWire,
  replaceMessageUnfurls,
  unfurlCardModel,
  unfurlRenderState,
  unfurlsFor,
  visibleUnfurls,
  type MessageUnfurl,
  type UnfurlSize,
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

// #4882: one case per row of the replacement table (docs/design-system/link-cards.md).
describe("unfurl card display model", () => {
  const ICON = "/v1/workspaces/w-1/unfurls/u-1/icon";
  const IMAGE = "/v1/workspaces/w-1/unfurls/u-1/image";
  const full: MessageUnfurl = {
    id: "u-1",
    messageId: "m-1",
    url: "https://news.example/story",
    status: "ok",
    title: "Release notes",
    description: "What changed this week.",
    domain: "news.example",
    siteName: "News Example",
    imageUrl: IMAGE,
    iconUrl: ICON,
    imageWidth: 1200,
    imageHeight: 630,
  };
  const row = (patch: Partial<MessageUnfurl> = {}, drop: (keyof MessageUnfurl)[] = []): MessageUnfurl => {
    const next: Record<string, unknown> = { ...full, ...patch };
    for (const key of drop) delete next[key];
    return next as unknown as MessageUnfurl;
  };
  const noPicture = ["imageUrl", "imageWidth", "imageHeight"] as const;
  const model = (unfurl: MessageUnfurl, size: UnfurlSize = "compact", imageFailed = false) =>
    unfurlCardModel(unfurl, { size, imageFailed });

  it("starts at the small card", () => {
    expect(DEFAULT_UNFURL_SIZE).toBe("compact");
    expect(model(full)?.layout).toBe("compact");
  });

  it("row: no picture becomes an icon tile, the site icon first and the globe after it", () => {
    const withIcon = model(row({}, [...noPicture]));
    expect(withIcon?.picture).toEqual({ kind: "tile" });
    expect(withIcon?.iconUrl).toBe(ICON);
    const bare = model(row({}, [...noPicture, "iconUrl"]));
    expect(bare?.picture).toEqual({ kind: "tile" });
    expect(bare?.iconUrl).toBeUndefined();
  });

  it("row: a picture that failed to load is the same tile, and a large card falls back to the small row", () => {
    const failed = model(full, "rich", true);
    expect(failed?.picture).toEqual(model(row({}, [...noPicture]))?.picture);
    expect(failed?.layout).toBe("compact");
    expect(model(full, "rich", false)?.layout).toBe("rich");
  });

  it("row: the description line goes when it is missing or only repeats the title", () => {
    expect(model(full)?.description).toBe("What changed this week.");
    expect(model(row({}, ["description"]))).not.toHaveProperty("description");
    expect(model(row({ description: "  release   NOTES " }))).not.toHaveProperty("description");
    // The shown title counts: with no title, a description equal to the site name is the same line twice.
    expect(model(row({ description: "News Example" }, ["title"]))).not.toHaveProperty("description");
  });

  it("row: no title shows the site name, then the domain, in the title slot", () => {
    expect(model(row({}, ["title"]))?.title).toBe("News Example");
    expect(model(row({}, ["title", "siteName"]))?.title).toBe("news.example");
    expect(model(row({ title: "   " }, ["siteName"]))?.title).toBe("news.example");
  });

  it("row: the address line is the real domain whatever the page calls itself", () => {
    const spoof = model(row({ siteName: "apple.com", domain: "evil.example" }, ["title"]));
    expect(spoof?.title).toBe("apple.com");
    expect(spoof?.domain).toBe("evil.example");
    // No server domain: read it from the link itself, lower-cased, without userinfo or port.
    expect(model(row({ url: "https://User@Sub.News.Example:8443/a?b#c" }, ["domain"]))?.domain).toBe(
      "sub.news.example"
    );
  });

  it("row: a small or square picture is shown whole, a wide one is cropped to its box", () => {
    const shapeOf = (width: number, height: number) => {
      const picture = model(row({ imageWidth: width, imageHeight: height }))?.picture;
      return picture?.kind === "image" ? picture.shape : picture?.kind;
    };
    expect(shapeOf(299, 150)).toBe("small"); // under 300 wide
    expect(shapeOf(300, 200)).toBe("wide"); // 300 is wide enough
    expect(shapeOf(1200, 923)).toBe("wide"); // ratio 1.3001
    expect(shapeOf(1200, 924)).toBe("small"); // ratio 1.2987
    expect(shapeOf(600, 600)).toBe("small"); // square
    expect(shapeOf(400, 900)).toBe("small"); // portrait
    // Unknown size (an older server) is not a claim: the picture is cropped as before.
    expect(model(row({}, ["imageWidth", "imageHeight"]))?.picture).toEqual({
      kind: "image",
      imageUrl: IMAGE,
      shape: "wide",
    });
    // A large card cannot fill its frame with a small picture, so it becomes the small row.
    expect(model(row({ imageWidth: 600, imageHeight: 600 }), "rich")?.layout).toBe("compact");
    expect(model(full, "rich")?.layout).toBe("rich");
  });

  it("row: a video keeps the original page as its target and says it is a video", () => {
    const video = model(row({ isVideo: true }));
    expect(video?.isVideo).toBe(true);
    expect(video?.url).toBe("https://news.example/story");
    expect(model(full)?.isVideo).toBe(false);
  });

  it("row: no title and no picture, a failed or blocked fetch, or the off choice draws no card", () => {
    const nothing = row({}, ["title", ...noPicture]);
    expect(model(nothing)).toBeNull(); // site name, description and icon alone are not a card
    expect(model(row({ status: "failed" }))).toBeNull();
    expect(model(row({ status: "blocked" }))).toBeNull();
    expect(model(row({ status: "pending" }))).toBeNull();
    expect(model(full, "off")).toBeNull();
    expect(visibleUnfurls([nothing, row({ id: "u-2", status: "failed" })])).toEqual([]);
    // A picture alone is enough, titled with the site name.
    expect(model(row({}, ["title"]))?.title).toBe("News Example");
  });

  it("row: only the first 3 distinct links draw, and a quiet one does not free a place", () => {
    const link = (n: number, patch: Partial<MessageUnfurl> = {}) =>
      row({ id: `u-${n}`, url: `https://site${n}.example/p`, domain: `site${n}.example`, ...patch });
    const four = [link(1), link(2), link(3), link(4)];
    expect(UNFURL_MAX_CARDS).toBe(3);
    expect(visibleUnfurls(four).map((u) => u.id)).toEqual(["u-1", "u-2", "u-3"]);
    // The same page written another way is one link, so it does not use up a place.
    const repeats = [
      link(1),
      link(2, { url: "https://SITE1.example/p#again" }),
      link(3, { url: "https://site1.example/p" }),
      link(4),
      link(5),
      link(6),
    ];
    expect(visibleUnfurls(repeats).map((u) => u.id)).toEqual(["u-1", "u-4", "u-5"]);
    // A first link that failed leaves only its link; the fourth link still gets no card.
    expect(visibleUnfurls([link(1, { status: "failed" }), link(2), link(3), link(4)]).map((u) => u.id)).toEqual([
      "u-2",
      "u-3",
    ]);
    // Loading rows hold their place like ready ones.
    expect(visibleUnfurls([link(1, { status: "pending" }), link(2)]).map((u) => u.id)).toEqual(["u-1", "u-2"]);
  });

  it("draws text only: direction controls and runs of spaces are gone", () => {
    const text = model(
      row({
        title: "\u202Eexe.txt\u202C  \n report\u2066",
        description: "a\u2069  b\u00a0\u00a0c",
        siteName: "\u202Esite",
      })
    );
    expect(text?.title).toBe("exe.txt report");
    expect(text?.description).toBe("a b c");
    expect(model(row({ siteName: "\u202Esite" }, ["title"]))?.title).toBe("site");
  });
});

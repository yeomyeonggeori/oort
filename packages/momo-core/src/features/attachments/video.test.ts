import { describe, expect, it } from "vitest";
import type { MessageAttachment } from "../../lib/api";
import {
  attachmentMetaLine,
  formatVideoDuration,
  isInAppPlayableVideo,
  isVideoAttachment,
  showsInlinePreview,
  videoCardSize,
} from "./model";

// 영상 첨부의 읽기 모델 (#5208). 폰이 카드·재생 화면을 그리고 웹이 같은 모델을 쓸 수 있게 코어에 둔다.

function video(over: Partial<MessageAttachment> = {}): MessageAttachment {
  return {
    id: "att-v",
    name: "IMG_0001.MOV",
    mime: "video/quicktime",
    sizeBytes: 61_200_000,
    ...over,
  };
}

const MEDIA = { kind: "video", durationMs: 42_000, width: 1280, height: 720, hasPoster: true } as const;

describe("formatVideoDuration", () => {
  it("writes minutes and zero-padded seconds under an hour", () => {
    expect(formatVideoDuration(42_000)).toBe("0:42");
    expect(formatVideoDuration(61_000)).toBe("1:01");
    expect(formatVideoDuration(600_000)).toBe("10:00");
  });

  it("writes hours with padded minutes at an hour and over", () => {
    expect(formatVideoDuration(3_600_000)).toBe("1:00:00");
    expect(formatVideoDuration(3_661_000)).toBe("1:01:01");
  });

  it("drops the sub-second part instead of rounding up (a clip never shows longer than it is)", () => {
    expect(formatVideoDuration(999)).toBe("0:00");
    expect(formatVideoDuration(59_999)).toBe("0:59");
  });

  it("answers 0:00 for what is not a length", () => {
    expect(formatVideoDuration(Number.NaN)).toBe("0:00");
    expect(formatVideoDuration(-5_000)).toBe("0:00");
    expect(formatVideoDuration(Number.POSITIVE_INFINITY)).toBe("0:00");
  });
});

describe("isVideoAttachment / isInAppPlayableVideo", () => {
  it("calls any video/* a video, parameters and case aside", () => {
    expect(isVideoAttachment(video())).toBe(true);
    expect(isVideoAttachment(video({ mime: "Video/MP4; codecs=avc1" }))).toBe(true);
    expect(isVideoAttachment(video({ mime: "video/webm" }))).toBe(true);
    expect(isVideoAttachment(video({ mime: "image/png" }))).toBe(false);
    expect(isVideoAttachment(video({ mime: "application/pdf" }))).toBe(false);
  });

  it("plays in the app only what AVFoundation reads: mp4, quicktime, m4v", () => {
    expect(isInAppPlayableVideo(video({ mime: "video/mp4" }))).toBe(true);
    expect(isInAppPlayableVideo(video({ mime: "video/quicktime" }))).toBe(true);
    expect(isInAppPlayableVideo(video({ mime: "VIDEO/MP4; codecs=avc1" }))).toBe(true);
    expect(isInAppPlayableVideo(video({ mime: "video/webm" }))).toBe(false);
    expect(isInAppPlayableVideo(video({ mime: "image/png" }))).toBe(false);
  });

  it("does not turn a video into an inline photo (the web shares showsInlinePreview)", () => {
    expect(showsInlinePreview(video({ mime: "video/mp4", sizeBytes: 1024 }))).toBe(false);
  });
});

describe("videoCardSize", () => {
  const MAX = { width: 280, height: 320 };

  it("fits a 16:9 clip to the full width", () => {
    expect(videoCardSize({ ...MEDIA, width: 1920, height: 1080 }, MAX)).toEqual({ width: 280, height: 158 });
  });

  it("fits a 9:16 clip to the full height", () => {
    expect(videoCardSize({ ...MEDIA, width: 1080, height: 1920 }, MAX)).toEqual({ width: 180, height: 320 });
  });

  it("keeps a square clip square", () => {
    expect(videoCardSize({ ...MEDIA, width: 500, height: 500 }, MAX)).toEqual({ width: 280, height: 280 });
  });

  it("clamps an extreme shape instead of drawing a sliver", () => {
    expect(videoCardSize({ ...MEDIA, width: 16_384, height: 100 }, MAX)).toEqual({ width: 280, height: 158 });
    expect(videoCardSize({ ...MEDIA, width: 100, height: 16_384 }, MAX)).toEqual({ width: 180, height: 320 });
  });

  it("falls back to 16:9 when the clip was not measured", () => {
    expect(videoCardSize(null, MAX)).toEqual({ width: 280, height: 158 });
  });
});

describe("attachmentMetaLine", () => {
  it("is unchanged for a video nobody measured", () => {
    expect(attachmentMetaLine(video())).toBe("동영상 · 58.4 MB");
  });

  it("carries the length between the kind and the size once the sender measured it", () => {
    expect(attachmentMetaLine(video({ media: { ...MEDIA } }))).toBe("동영상 · 0:42 · 58.4 MB");
  });

  it("ignores a summary the wire should not have carried (REST pages are not re-parsed)", () => {
    const hostile = video({ media: { ...MEDIA, durationMs: -1 } as unknown as MessageAttachment["media"] });
    expect(attachmentMetaLine(hostile)).toBe("동영상 · 58.4 MB");
  });

  it("never adds a length to a photo or a document", () => {
    expect(attachmentMetaLine({ id: "a", name: "a.pdf", mime: "application/pdf", sizeBytes: 2048 })).toBe(
      "PDF · 2 KB",
    );
  });
});

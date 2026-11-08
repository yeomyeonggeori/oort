import { describe, expect, it } from "vitest";
import type { MessageAttachment } from "../../lib/api";
import {
  attachmentImageSizeOf,
  attachmentMediaOf,
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

// ---- 사진·GIF 의 가로세로 (ADR-0151 증보 9, #5469) -----------------------------------------------
//
// 사진 요약은 영상 요약과 **다른 읽기 길**이다: `attachmentMediaOf` 는 영상만, `attachmentImageSizeOf` 는 사진만 읽는다. 사진 요약이
// 영상 카드(길이 표기)로 새거나, 영상·문서에 붙은 사진 요약이 칸을 정하면 안 된다.

function photo(over: Partial<MessageAttachment> = {}): MessageAttachment {
  return { id: "att-p", name: "IMG_0001.jpg", mime: "image/jpeg", sizeBytes: 3_100_000, ...over };
}

const PICTURE = { kind: "image", width: 4032, height: 3024 } as const;

describe("attachmentImageSizeOf", () => {
  it("reads a picture's declared size off a photo or a GIF", () => {
    expect(attachmentImageSizeOf(photo({ media: { ...PICTURE } }))).toEqual({ width: 4032, height: 3024 });
    expect(attachmentImageSizeOf(photo({ mime: "image/gif", media: { ...PICTURE, width: 480, height: 270 } }))).toEqual({
      width: 480,
      height: 270,
    });
  });

  it("answers null when nobody declared a size (the old message: the client's own memory sizes it)", () => {
    expect(attachmentImageSizeOf(photo())).toBeNull();
    expect(attachmentImageSizeOf(null)).toBeNull();
    expect(attachmentImageSizeOf(undefined)).toBeNull();
  });

  it("re-checks the range, because a REST page is not re-parsed", () => {
    for (const media of [
      { ...PICTURE, width: 0 },
      { ...PICTURE, height: 16_385 },
      { ...PICTURE, width: 640.5 },
      { kind: "image", width: 640 },
      { kind: "hologram", width: 4, height: 3 },
    ]) {
      expect(attachmentImageSizeOf(photo({ media: media as unknown as MessageAttachment["media"] }))).toBeNull();
    }
  });

  it("does not trust a picture's summary on a file that is not declared as an image", () => {
    for (const mime of ["video/mp4", "application/pdf", "text/plain", "", "audio/mpeg"]) {
      expect(attachmentImageSizeOf(photo({ mime, media: { ...PICTURE } }))).toBeNull();
    }
    // a hostile or older page whose mime is not a string
    expect(attachmentImageSizeOf(photo({ mime: undefined as unknown as string, media: { ...PICTURE } }))).toBeNull();
  });

  it("does not read a video's summary as a size", () => {
    expect(attachmentImageSizeOf(photo({ mime: "image/jpeg", media: { ...MEDIA } }))).toBeNull();
  });
});

describe("attachmentMediaOf is the video's reader only", () => {
  it("never answers a picture's summary (a card would draw a length that does not exist)", () => {
    expect(attachmentMediaOf(photo({ media: { ...PICTURE } }))).toBeNull();
    expect(attachmentMediaOf(video({ media: { ...PICTURE } }))).toBeNull();
    expect(attachmentMediaOf(video({ media: { ...MEDIA } }))).toEqual(MEDIA);
  });

  it("leaves a photo's meta line the way it was (no length, no extra part)", () => {
    expect(attachmentMetaLine(photo({ media: { ...PICTURE } }))).toBe("이미지 · 3 MB");
    expect(attachmentMetaLine(photo())).toBe(attachmentMetaLine(photo({ media: { ...PICTURE } })));
  });

  it("keeps the video card's box a function of a video summary only", () => {
    expect(videoCardSize(attachmentMediaOf(video({ media: { ...PICTURE } })), { width: 280, height: 320 })).toEqual(
      videoCardSize(null, { width: 280, height: 320 }),
    );
  });
});

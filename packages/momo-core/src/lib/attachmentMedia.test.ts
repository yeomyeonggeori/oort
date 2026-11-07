import { describe, expect, it } from "vitest";
import type { VideoMedia } from "./api";
import {
  attachmentMediaFromWire,
  canDeclareImageSize,
  IMAGE_MEDIA_MIMES,
  imageSizeDeclaration,
  MAX_IMAGE_DIMENSION,
} from "./attachmentMedia";

// 영상 첨부의 요약 `media` (openapi `AttachmentMedia`, ADR-0151 증보 5 D5, #4673).
//
// 숫자는 **보내는 기기의 선언**이고 서버는 범위만 본다. 그래서 받는 쪽은 숫자를 믿고 칸을 그리기 전에
// 한 번 더 거른다. 어긋난 요약은 **요약만** 버린다 — 첨부(파일 카드와 바이트)는 남아야 한다.

const valid = { kind: "video", durationMs: 42_000, width: 1280, height: 720, hasPoster: true };

describe("attachmentMediaFromWire", () => {
  it("reads a well-formed video summary", () => {
    expect(attachmentMediaFromWire(valid)).toEqual(valid);
  });

  it("keeps hasPoster false as false (a measured video without a frame)", () => {
    expect(attachmentMediaFromWire({ ...valid, hasPoster: false })).toEqual({
      ...valid,
      hasPoster: false,
    });
  });

  it("accepts the documented bounds and refuses one step past them", () => {
    expect((attachmentMediaFromWire({ ...valid, durationMs: 1 }) as VideoMedia).durationMs).toBe(1);
    expect((attachmentMediaFromWire({ ...valid, durationMs: 86_400_000 }) as VideoMedia).durationMs).toBe(
      86_400_000,
    );
    expect(attachmentMediaFromWire({ ...valid, durationMs: 0 })).toBeUndefined();
    expect(attachmentMediaFromWire({ ...valid, durationMs: 86_400_001 })).toBeUndefined();
    expect(attachmentMediaFromWire({ ...valid, width: 16_384 })?.width).toBe(16_384);
    expect(attachmentMediaFromWire({ ...valid, width: 16_385 })).toBeUndefined();
    expect(attachmentMediaFromWire({ ...valid, height: 0 })).toBeUndefined();
  });

  it("refuses what is not a whole number or not a number", () => {
    expect(attachmentMediaFromWire({ ...valid, durationMs: 41.5 })).toBeUndefined();
    expect(attachmentMediaFromWire({ ...valid, width: "1280" })).toBeUndefined();
    expect(attachmentMediaFromWire({ ...valid, height: Number.NaN })).toBeUndefined();
    expect(attachmentMediaFromWire({ ...valid, durationMs: Number.POSITIVE_INFINITY })).toBeUndefined();
  });

  it("refuses another kind and a missing or non-boolean hasPoster", () => {
    expect(attachmentMediaFromWire({ ...valid, kind: "audio" })).toBeUndefined();
    expect(attachmentMediaFromWire({ ...valid, hasPoster: "true" })).toBeUndefined();
    const { hasPoster: _omitted, ...without } = valid;
    expect(attachmentMediaFromWire(without)).toBeUndefined();
  });

  it("answers undefined for anything that is not an object", () => {
    expect(attachmentMediaFromWire(undefined)).toBeUndefined();
    expect(attachmentMediaFromWire(null)).toBeUndefined();
    expect(attachmentMediaFromWire("video")).toBeUndefined();
    expect(attachmentMediaFromWire(42)).toBeUndefined();
  });

  it("copies only the five documented keys (nothing else rides along)", () => {
    const parsed = attachmentMediaFromWire({ ...valid, posterUrl: "https://example.test/x", extra: 1 });
    expect(Object.keys(parsed ?? {}).sort()).toEqual(
      ["durationMs", "hasPoster", "height", "kind", "width"],
    );
  });
});

// ---- 사진·GIF 의 가로세로 (ADR-0151 증보 9, #5469) ------------------------------------------------------
//
// 사진 요약은 `{kind: "image", width, height}` 셋이다. 서버가 범위만 보고 저장한 **보내는 기기의 선언**이라 받는 쪽이 같은 범위를
// 한 번 더 지킨다. 영상 요약과 달리 길이·포스터가 없고, 영상 요약의 거름(다섯 키)은 그대로다.

const picture = { kind: "image", width: 4032, height: 3024 };

describe("attachmentMediaFromWire — a photo's or GIF's size", () => {
  it("reads a well-formed picture summary", () => {
    expect(attachmentMediaFromWire(picture)).toEqual(picture);
  });

  it("accepts the documented bounds and refuses one step past them", () => {
    expect(attachmentMediaFromWire({ ...picture, width: 1, height: 1 })).toEqual({ kind: "image", width: 1, height: 1 });
    expect(attachmentMediaFromWire({ ...picture, width: MAX_IMAGE_DIMENSION })).toEqual({
      ...picture,
      width: 16_384,
    });
    expect(MAX_IMAGE_DIMENSION).toBe(16_384);
    for (const width of [0, -5, 16_385]) {
      expect(attachmentMediaFromWire({ ...picture, width })).toBeUndefined();
      expect(attachmentMediaFromWire({ ...picture, height: width })).toBeUndefined();
    }
  });

  it("refuses what is not a whole number or not a number, and a size with a missing side", () => {
    for (const bad of [41.5, "4032", Number.NaN, Number.POSITIVE_INFINITY, null, undefined, true]) {
      expect(attachmentMediaFromWire({ ...picture, width: bad })).toBeUndefined();
      expect(attachmentMediaFromWire({ ...picture, height: bad })).toBeUndefined();
    }
    expect(attachmentMediaFromWire({ kind: "image", width: 640 })).toBeUndefined();
    expect(attachmentMediaFromWire({ kind: "image", height: 480 })).toBeUndefined();
  });

  it("copies only the three documented keys — a video's keys never ride along on a picture", () => {
    const parsed = attachmentMediaFromWire({
      ...picture,
      durationMs: 5_000,
      hasPoster: true,
      posterUrl: "https://example.test/x",
    });
    expect(Object.keys(parsed ?? {}).sort()).toEqual(["height", "kind", "width"]);
  });

  it("does not read a picture's keys as a video, nor a video's as a picture", () => {
    expect(attachmentMediaFromWire({ kind: "video", width: 4032, height: 3024 })).toBeUndefined();
    expect(attachmentMediaFromWire({ ...valid, kind: "image" })).toEqual({
      kind: "image",
      width: 1280,
      height: 720,
    });
    expect(attachmentMediaFromWire({ ...valid, kind: "Image" })).toBeUndefined();
    expect(attachmentMediaFromWire({ ...picture, kind: "gif" })).toBeUndefined();
  });
});

describe("the sender's declaration", () => {
  it("names the four types the server's closed list holds, and no other", () => {
    expect([...IMAGE_MEDIA_MIMES]).toEqual(["image/jpeg", "image/png", "image/gif", "image/webp"]);
    for (const mime of IMAGE_MEDIA_MIMES) expect(canDeclareImageSize(mime)).toBe(true);
    expect(canDeclareImageSize(" IMAGE/PNG ")).toBe(true);
    expect(canDeclareImageSize("image/png; charset=binary")).toBe(true);
    for (const mime of ["image/heic", "image/svg+xml", "image/avif", "image/bmp", "video/mp4", "application/pdf", "", undefined, null, 7]) {
      expect(canDeclareImageSize(mime)).toBe(false);
    }
  });

  it("turns a measured size into the request body, rounding a size measured in points", () => {
    expect(imageSizeDeclaration({ width: 4032, height: 3024 })).toEqual({ kind: "image", width: 4032, height: 3024 });
    expect(imageSizeDeclaration({ width: 100.4, height: 50.6 })).toEqual({ kind: "image", width: 100, height: 51 });
  });

  it("declares nothing rather than something wrong", () => {
    for (const size of [
      null,
      undefined,
      { width: 0, height: 10 },
      { width: 10, height: 0 },
      { width: 16_385, height: 10 },
      { width: 10, height: 16_385 },
      { width: Number.NaN, height: 10 },
      { width: 10, height: Number.POSITIVE_INFINITY },
      { width: -3, height: 10 },
      { width: 0.4, height: 10 },
    ]) {
      expect(imageSizeDeclaration(size)).toBeNull();
    }
    expect(imageSizeDeclaration({ width: 16_384, height: 16_384 })).not.toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { attachmentMediaFromWire } from "./attachmentMedia";

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
    expect(attachmentMediaFromWire({ ...valid, durationMs: 1 })?.durationMs).toBe(1);
    expect(attachmentMediaFromWire({ ...valid, durationMs: 86_400_000 })?.durationMs).toBe(86_400_000);
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

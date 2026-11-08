import { describe, expect, it } from "vitest";
import { attachmentMediaFromWire } from "./attachmentMedia";
import { attachmentsFromWire } from "./realtimeEvents";

// =============================================================================
// 「옛 판 동작」 단정 (ADR-0151 증보 9 I8, #5469).
//
// 서버가 사진·GIF 에 `media: {kind: "image", width, height}` 를 싣기 시작해도, **이미 나간 클라이언트**(v0.1.42·0.1.43·0.1.44)는 그
// 요약만 버리고 첨부를 지금처럼 그린다. 그 근거는 코드를 읽은 것이 아니라 **나간 코드 그대로**여야 한다: 아래 두 함수는 #5208
// (`3248e7eeb`, v0.1.42 부터 태그에 든다)의 `attachmentMediaFromWire` 와 그 호출처의 첨부 만들기를 **글자 그대로 옮겨 얼린** 것이다.
// 현재 코드를 고쳐도 이 사본은 바뀌지 않으므로, 이 시험은 「나간 판이 사진 요약을 만나면 무엇을 하는가」를 고정한다.
// (그 앞 판은 `media` 를 읽지 않는다 — 모르는 키는 어디서도 쓰이지 않는다.)
// =============================================================================

const SHIPPED_MAX_VIDEO_DURATION_MS = 86_400_000;
const SHIPPED_MAX_VIDEO_DIMENSION = 16_384;

function shippedBoundedInteger(value: unknown, max: number): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= max
    ? value
    : undefined;
}

/** v0.1.42~0.1.44 의 `attachmentMediaFromWire` — 옮겨 얼린 사본(고치지 않는다). */
function shippedAttachmentMediaFromWire(value: unknown) {
  if (typeof value !== "object" || value === null) return undefined;
  const source = value as Record<string, unknown>;
  if (source.kind !== "video") return undefined;
  const durationMs = shippedBoundedInteger(source.durationMs, SHIPPED_MAX_VIDEO_DURATION_MS);
  const width = shippedBoundedInteger(source.width, SHIPPED_MAX_VIDEO_DIMENSION);
  const height = shippedBoundedInteger(source.height, SHIPPED_MAX_VIDEO_DIMENSION);
  if (durationMs === undefined || width === undefined || height === undefined) return undefined;
  if (typeof source.hasPoster !== "boolean") return undefined;
  return { kind: "video", durationMs, width, height, hasPoster: source.hasPoster };
}

/** v0.1.42~0.1.44 `attachmentsFromWire` 의 한 건 만들기 — 어긋난 요약은 요약만 버리고 첨부는 남긴다(옮겨 얼린 사본). */
function shippedAttachmentOf(entry: { id: string; name: string; mime: string; sizeBytes: number; media?: unknown }) {
  const { id, name, mime, sizeBytes } = entry;
  const media = shippedAttachmentMediaFromWire(entry.media);
  return media === undefined ? { id, name, mime, sizeBytes } : { id, name, mime, sizeBytes, media };
}

const photo = { id: "att-1", name: "IMG_0001.jpg", mime: "image/jpeg", sizeBytes: 3_100_000 };
const sizes: Array<[number, number]> = [
  [4032, 3024],
  [3024, 4032],
  [1, 1],
  [16_384, 16_384],
  [16_384, 1],
  [1, 16_384],
  [480, 270],
  [1170, 2532],
];

describe("what the clients already out do with a picture's summary (frozen copy of #5208)", () => {
  it("the shipped filter drops every picture summary the server can send", () => {
    for (const [width, height] of sizes) {
      expect(shippedAttachmentMediaFromWire({ kind: "image", width, height })).toBeUndefined();
    }
  });

  it("…and the shipped attachment survives with exactly the four keys it always had", () => {
    for (const [width, height] of sizes) {
      const kept = shippedAttachmentOf({ ...photo, media: { kind: "image", width, height } });
      expect(kept).toEqual(photo);
      expect("media" in kept).toBe(false);
    }
  });

  it("the frozen copy is a real filter (it keeps a video summary the same way the current code does)", () => {
    const video = { kind: "video", durationMs: 42_000, width: 1280, height: 720, hasPoster: true };
    expect(shippedAttachmentMediaFromWire(video)).toEqual(video);
    expect(attachmentMediaFromWire(video)).toEqual(shippedAttachmentMediaFromWire(video));
    // and it turns a bad video summary away, as the current code does: the copy is not a no-op
    expect(shippedAttachmentMediaFromWire({ ...video, durationMs: 0 })).toBeUndefined();
    expect(attachmentMediaFromWire({ ...video, durationMs: 0 })).toBeUndefined();
  });

  it("the current code reads the same picture summaries as a picture, and keeps the attachment either way", () => {
    for (const [width, height] of sizes) {
      expect(attachmentMediaFromWire({ kind: "image", width, height })).toEqual({ kind: "image", width, height });
      const [live] = attachmentsFromWire([{ ...photo, media: { kind: "image", width, height } }]);
      expect(live).toEqual({ ...photo, media: { kind: "image", width, height } });
    }
    // a kind this code does not know is dropped as the shipped code drops a picture: the attachment stays
    const [future] = attachmentsFromWire([{ ...photo, media: { kind: "hologram", width: 4, height: 3 } }]);
    expect(future).toEqual(photo);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { declareImageSize } from "./declareImageSize";

// 보내는 쪽의 선언 한 걸음 (ADR-0151 증보 9 I7). 서버 호출은 갈아 끼운 가짜(`put`)이고 시험이 보는 것은 **무엇을 보냈는가**와
// **보내기를 막지 않는가**다.

const ids = { workspaceId: "ws-1", channelId: "ch-1", attachmentId: "att-1" };
const measured = (width: number, height: number) => async () => ({ width, height });

describe("declareImageSize", () => {
  it("sends the measured size as a picture's request and reports it declared", async () => {
    const put = vi.fn(async () => ({ kind: "image", width: 4032, height: 3024 }) as never);
    const outcome = await declareImageSize({ ...ids, mime: "image/jpeg", measure: measured(4032, 3024), put });
    expect(outcome).toBe("declared");
    expect(put).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledWith("ws-1", "ch-1", "att-1", { kind: "image", width: 4032, height: 3024 });
  });

  it("declares a GIF, a PNG and a WebP too (the server's whole closed list)", async () => {
    for (const mime of ["image/gif", "image/png", "image/webp", "IMAGE/PNG", "image/png; charset=binary"]) {
      const put = vi.fn(async () => ({ kind: "image", width: 1, height: 1 }) as never);
      expect(await declareImageSize({ ...ids, mime, measure: measured(480, 270), put })).toBe("declared");
      expect(put).toHaveBeenCalledTimes(1);
    }
  });

  it("sends nothing for a type the server would refuse, and never even measures it", async () => {
    for (const mime of ["image/heic", "image/svg+xml", "image/avif", "video/mp4", "application/pdf", ""]) {
      const put = vi.fn();
      const measure = vi.fn(measured(10, 10));
      expect(await declareImageSize({ ...ids, mime, measure, put })).toBe("skipped");
      expect(put).not.toHaveBeenCalled();
      expect(measure).not.toHaveBeenCalled();
    }
  });

  it("sends nothing when the size could not be measured or is out of range (a wrong size is worse than none)", async () => {
    for (const measure of [
      async () => null,
      async () => {
        throw new Error("decode failed");
      },
      measured(0, 10),
      measured(16_385, 10),
      measured(Number.NaN, 10),
    ]) {
      const put = vi.fn();
      expect(await declareImageSize({ ...ids, mime: "image/png", measure, put })).toBe("skipped");
      expect(put).not.toHaveBeenCalled();
    }
  });

  it("rounds a size measured in points to the whole pixels the server takes", async () => {
    const put = vi.fn(async () => ({ kind: "image", width: 1, height: 1 }) as never);
    await declareImageSize({ ...ids, mime: "image/png", measure: measured(100.4, 50.6), put });
    expect(put).toHaveBeenCalledWith("ws-1", "ch-1", "att-1", { kind: "image", width: 100, height: 51 });
  });

  it("never throws: a refused or unreachable server is `failed`, and the send goes on without a summary", async () => {
    for (const error of [new Error("offline"), Object.assign(new Error("429"), { status: 429 }), "not even an Error"]) {
      const put = vi.fn(async () => {
        throw error;
      });
      await expect(declareImageSize({ ...ids, mime: "image/png", measure: measured(8, 8), put })).resolves.toBe("failed");
    }
  });
});

describe("declareImageSize holds the send for at most its budget", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("stops waiting for a server that does not answer", async () => {
    const put = vi.fn(() => new Promise<never>(() => undefined));
    const pending = declareImageSize({ ...ids, mime: "image/png", measure: measured(8, 8), put, budgetMs: 4_000 });
    let outcome: string | undefined;
    void pending.then((value) => {
      outcome = value;
    });
    await vi.advanceTimersByTimeAsync(3_999);
    expect(outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toBe("failed");
  });

  it("stops waiting for a measurement that never ends", async () => {
    const put = vi.fn();
    const pending = declareImageSize({
      ...ids,
      mime: "image/gif",
      measure: () => new Promise<never>(() => undefined),
      put,
      budgetMs: 1_000,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toBe("failed");
    expect(put).not.toHaveBeenCalled();
  });

  it("clears its timer when it finishes first (nothing is left running)", async () => {
    const put = vi.fn(async () => ({ kind: "image", width: 1, height: 1 }) as never);
    await declareImageSize({ ...ids, mime: "image/png", measure: measured(8, 8), put });
    expect(vi.getTimerCount()).toBe(0);
  });
});

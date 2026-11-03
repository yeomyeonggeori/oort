// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { canCopyImage, copyImageToClipboard, pngBlobFromDataUrl } from "./copyImage";

// 이미지 복사의 바이트 길 (#5190). 클립보드 쓰기와 PNG 변환(캔버스)은 진짜 브라우저의 일이라 `scripts/capture-5190.mjs`가 Chromium에서
// 잰다(JPEG를 그려 PNG로 바꾸는 갈래 포함). 여기서는 jsdom이 할 수 있는 길만 잰다: PNG는 바이트를 그대로 건네고, 이미지가 아니면 던진다.

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "clipboard");
});

/** jsdom의 Blob은 Node의 `Response`가 읽지 못한다: jsdom의 `FileReader`로 읽는다. */
function bytesOf(blob: Blob): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve([...new Uint8Array(reader.result as ArrayBuffer)]);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

describe("copy image bytes", () => {
  it("passes PNG bytes through untouched, as a PNG blob", async () => {
    // "AQID" = 0x01 0x02 0x03. 건넨 바이트가 그대로인지 값으로 잰다(길이만 보지 않는다).
    const blob = await pngBlobFromDataUrl("data:image/png;base64,AQID");
    expect(blob.type).toBe("image/png");
    expect(blob.size).toBe(3);
    expect(await bytesOf(blob)).toEqual([1, 2, 3]);
  });

  it("refuses an address that is not a base64 image", async () => {
    await expect(pngBlobFromDataUrl("data:text/html;base64,PGI+")).rejects.toThrow("not an image data url");
    await expect(pngBlobFromDataUrl("https://example.test/a.png")).rejects.toThrow("not an image data url");
  });

  it("is only offered where the clipboard can take an image", () => {
    expect(canCopyImage(), "plain jsdom has neither").toBe(false);
    vi.stubGlobal("ClipboardItem", class {});
    expect(canCopyImage(), "an item class alone is not enough").toBe(false);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { write: async () => {} } });
    expect(canCopyImage()).toBe(true);
  });

  it("hands the clipboard one image/png item whose body is a promise, so the write happens inside the gesture", async () => {
    const seen: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "ClipboardItem",
      class {
        constructor(items: Record<string, unknown>) {
          seen.push(items);
        }
      }
    );
    const write = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { write } });
    await copyImageToClipboard("data:image/png;base64,AQID");
    expect(write).toHaveBeenCalledTimes(1);
    expect(Object.keys(seen[0])).toEqual(["image/png"]);
    expect(seen[0]["image/png"]).toBeInstanceOf(Promise);
  });
});

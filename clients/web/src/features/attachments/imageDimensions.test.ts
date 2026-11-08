// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeDisplayBitmap, measureImageFile, shareImageSize, sizeOfBitmap } from "./imageDimensions";

// 보낼 사진의 표시 크기를 재는 자 (ADR-0151 증보 9 I7). 여기서 재는 것은 셋이다: 재는 값이 **디코드된 그림의 크기**(방향 적용)이고
// 그림을 바로 놓는다는 것, **같은 파일을 두 번 풀지 않는다**는 것, 그리고 **못 풀면 던지지 않고 `null`** 이라는 것(호출처가 그것을
// 「선언하지 않음」으로 읽는다).

const createImageBitmap = vi.fn();

function image(name = "photo.jpg"): File {
  return new File([new Uint8Array(8)], name, { type: "image/jpeg" });
}

function bitmap(width: number, height: number) {
  return { width, height, close: vi.fn() };
}

beforeEach(() => {
  createImageBitmap.mockReset();
  vi.stubGlobal("createImageBitmap", createImageBitmap);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("measureImageFile", () => {
  it("answers the decoded picture's size, as it is shown (a portrait photo is portrait), and lets go of the pixels", async () => {
    const decoded = bitmap(3024, 4032);
    createImageBitmap.mockResolvedValue(decoded);
    const file = image();
    expect(await measureImageFile(file)).toEqual({ width: 3024, height: 4032 });
    expect(createImageBitmap).toHaveBeenCalledTimes(1);
    expect(decoded.close).toHaveBeenCalledTimes(1);
  });

  it("decodes a file once, however many times and however closely together it is asked", async () => {
    createImageBitmap.mockResolvedValue(bitmap(480, 270));
    const file = image();
    const [first, second] = await Promise.all([measureImageFile(file), measureImageFile(file)]);
    const third = await measureImageFile(file);
    expect([first, second, third]).toEqual([
      { width: 480, height: 270 },
      { width: 480, height: 270 },
      { width: 480, height: 270 },
    ]);
    expect(createImageBitmap).toHaveBeenCalledTimes(1);
  });

  it("keeps one answer per file, not one for all files", async () => {
    createImageBitmap
      .mockResolvedValueOnce(bitmap(100, 50))
      .mockResolvedValueOnce(bitmap(60, 90));
    expect(await measureImageFile(image("a.png"))).toEqual({ width: 100, height: 50 });
    expect(await measureImageFile(image("b.png"))).toEqual({ width: 60, height: 90 });
    expect(createImageBitmap).toHaveBeenCalledTimes(2);
  });

  it("answers null — and does not throw — when the browser cannot decode the file", async () => {
    createImageBitmap.mockRejectedValue(new DOMException("The source image could not be decoded.", "InvalidStateError"));
    await expect(measureImageFile(image("heic.png"))).resolves.toBeNull();
  });

  it("answers null in a browser that has no createImageBitmap", async () => {
    vi.stubGlobal("createImageBitmap", undefined);
    await expect(measureImageFile(image("old-browser.png"))).resolves.toBeNull();
  });

  it("answers null for a picture with no size, and still lets go of it", async () => {
    for (const [width, height] of [
      [0, 100],
      [100, 0],
      [Number.NaN, 100],
      [100, Number.POSITIVE_INFINITY],
    ]) {
      const decoded = bitmap(width as number, height as number);
      createImageBitmap.mockResolvedValueOnce(decoded);
      await expect(measureImageFile(image())).resolves.toBeNull();
      expect(decoded.close).toHaveBeenCalledTimes(1);
    }
  });
});

describe("the orientation is asked for, not left to the engine's default", () => {
  const unknownValue = () => new TypeError("The provided value 'from-image' is not a valid enum value of type ImageOrientation.");

  it("asks for the EXIF orientation to be applied, in the first and only call when the engine knows the value", async () => {
    const decoded = bitmap(3024, 4032);
    createImageBitmap.mockResolvedValue(decoded);
    const file = image("portrait.jpg");
    expect(await measureImageFile(file)).toEqual({ width: 3024, height: 4032 });
    expect(createImageBitmap).toHaveBeenCalledTimes(1);
    expect(createImageBitmap).toHaveBeenNthCalledWith(1, file, { imageOrientation: "from-image" });
  });

  it("asks once more, with the engine's default, when the engine does not know the value (a TypeError), and still answers the size", async () => {
    const decoded = bitmap(1920, 1080);
    createImageBitmap.mockRejectedValueOnce(unknownValue()).mockResolvedValueOnce(decoded);
    const file = image("old-engine.jpg");
    expect(await measureImageFile(file)).toEqual({ width: 1920, height: 1080 });
    expect(createImageBitmap).toHaveBeenCalledTimes(2);
    expect(createImageBitmap.mock.calls[0]).toEqual([file, { imageOrientation: "from-image" }]);
    expect(createImageBitmap.mock.calls[1]).toEqual([file]);
    // the picture that came out of the second try is let go like any other
    expect(decoded.close).toHaveBeenCalledTimes(1);
  });

  it("answers null — nothing to declare — when the engine fails both ways, and does not throw", async () => {
    createImageBitmap.mockRejectedValue(unknownValue());
    await expect(measureImageFile(image("neither.jpg"))).resolves.toBeNull();
    expect(createImageBitmap).toHaveBeenCalledTimes(2);
  });

  it("does not decode a file twice because it cannot be decoded: only an unknown value is retried", async () => {
    createImageBitmap.mockRejectedValue(new DOMException("The source image could not be decoded.", "InvalidStateError"));
    await expect(measureImageFile(image("corrupt.jpg"))).resolves.toBeNull();
    expect(createImageBitmap).toHaveBeenCalledTimes(1);
  });

  it("is one function for whoever decodes a draft: it hands the picture over and lets the caller close it", async () => {
    const decoded = bitmap(10, 20);
    createImageBitmap.mockResolvedValue(decoded);
    const file = image("shared.jpg");
    await expect(decodeDisplayBitmap(file)).resolves.toBe(decoded);
    expect(decoded.close).not.toHaveBeenCalled();
    expect(createImageBitmap).toHaveBeenCalledWith(file, { imageOrientation: "from-image" });
  });

  it("lets an error that is not an unknown value reach the caller, and a second failure too", async () => {
    const corrupt = new DOMException("The source image could not be decoded.", "InvalidStateError");
    createImageBitmap.mockRejectedValueOnce(corrupt);
    await expect(decodeDisplayBitmap(image("a.jpg"))).rejects.toBe(corrupt);
    const second = new TypeError("still not");
    createImageBitmap.mockRejectedValueOnce(unknownValue()).mockRejectedValueOnce(second);
    await expect(decodeDisplayBitmap(image("b.jpg"))).rejects.toBe(second);
  });
});

describe("shareImageSize — one decode when the tray's thumbnail is already decoding the file", () => {
  it("takes the size from the decode under way and decodes nothing itself", async () => {
    const file = image();
    const share = shareImageSize(file);
    const asked = measureImageFile(file);
    share({ width: 1600, height: 900 });
    expect(await asked).toEqual({ width: 1600, height: 900 });
    expect(createImageBitmap).not.toHaveBeenCalled();
  });

  it("passes a failed decode on as no size (and does not try again)", async () => {
    const file = image();
    const share = shareImageSize(file);
    share(null);
    expect(await measureImageFile(file)).toBeNull();
    expect(createImageBitmap).not.toHaveBeenCalled();
  });

  it("does nothing when the size already has an owner: the first answer stands", async () => {
    createImageBitmap.mockResolvedValue(bitmap(640, 480));
    const file = image();
    const own = measureImageFile(file);
    const share = shareImageSize(file);
    share({ width: 1, height: 1 });
    expect(await own).toEqual({ width: 640, height: 480 });
    expect(await measureImageFile(file)).toEqual({ width: 640, height: 480 });
    expect(createImageBitmap).toHaveBeenCalledTimes(1);
  });

  it("is shared per file: another file is still measured on its own", async () => {
    createImageBitmap.mockResolvedValue(bitmap(30, 20));
    const shared = image("shared.png");
    shareImageSize(shared)({ width: 5, height: 5 });
    expect(await measureImageFile(image("other.png"))).toEqual({ width: 30, height: 20 });
    expect(await measureImageFile(shared)).toEqual({ width: 5, height: 5 });
  });
});

describe("sizeOfBitmap", () => {
  it("is a size only when both sides are positive finite numbers", () => {
    expect(sizeOfBitmap({ width: 1, height: 1 })).toEqual({ width: 1, height: 1 });
    for (const bad of [
      { width: 0, height: 1 },
      { width: 1, height: 0 },
      { width: -2, height: 1 },
      { width: 1, height: Number.NaN },
      { width: Number.POSITIVE_INFINITY, height: 1 },
    ]) {
      expect(sizeOfBitmap(bad)).toBeNull();
    }
  });
});

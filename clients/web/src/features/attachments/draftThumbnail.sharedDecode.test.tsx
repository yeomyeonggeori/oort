// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 트레이 썸네일의 풀기가 보내는 쪽의 가로세로 선언과 **한 번의 풀기**를 나눈다 (ADR-0151 증보 9 I7, #5469).
//
// 같은 사진을 두 번 풀면(그림 한 장을 그리려고 한 번, 크기를 재려고 한 번) 큰 사진에서 시간과 메모리를 두 배로 쓴다. 트레이가 이미
// 푼 파일은 크기를 거기서 받고, `draftThumbnail.test.tsx` 의 「파일당 한 번」 단정도 그대로 선다.

vi.mock("@momo/core/lib/api", () => ({
  ApiError: class extends Error {},
  // 업로드는 이 파일의 관심이 아니다. 영원히 대기시켜 칩이 「업로드 중」에 머문다.
  createAttachmentUpload: () => new Promise(() => {}),
  completeAttachmentUpload: () => new Promise(() => {}),
}));

const createImageBitmap = vi.fn();

const { addFiles, draftFile, readSurface, resetAttachmentDraftsForTest, surfaceKey } =
  await import("./draftStore");
const { AttachmentTray } = await import("./AttachmentTray");
const { measureImageFile } = await import("./imageDimensions");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KEY = surfaceKey("ws", "ch");
const TARGET = { workspaceId: "ws", channelId: "ch" };

let host: HTMLDivElement;
let root: Root;

function renderTray() {
  const drafts = readSurface(KEY).drafts;
  act(() => {
    root.render(
      <AttachmentTray
        drafts={drafts}
        rejected={0}
        folders={0}
        onRemove={() => {}}
        onRetry={() => {}}
        onClear={() => {}}
        onAcknowledgeNotices={() => {}}
      />
    );
  });
}

async function flush() {
  await act(async () => {
    await new Promise((done) => setTimeout(done, 0));
  });
}

/** 트레이에 올린 사진 한 장과, 초안이 쥔 그 `File`. */
function pickedPhoto(name: string, type = "image/jpeg"): File {
  addFiles(KEY, TARGET, [new File([new Uint8Array(64_000)], name, { type })]);
  const localId = readSurface(KEY).drafts[0]?.localId ?? "";
  const stored = draftFile(localId);
  if (stored === undefined) throw new Error("the draft holds its file");
  return stored;
}

beforeEach(() => {
  resetAttachmentDraftsForTest();
  createImageBitmap.mockReset();
  vi.stubGlobal("createImageBitmap", createImageBitmap);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () => ({ drawImage: vi.fn() }) as unknown as CanvasRenderingContext2D
  );
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(
    () => "data:image/png;base64,VEhVTUI="
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the tray thumbnail and the size declaration decode a picture once", () => {
  it("gives the declaration the size the thumbnail's decode saw, without a second decode", async () => {
    createImageBitmap.mockResolvedValue({ width: 1600, height: 900, close: vi.fn() });
    const file = pickedPhoto("one-decode.jpg");
    renderTray();
    await flush();
    expect(createImageBitmap).toHaveBeenCalledTimes(1);
    // the declaration asks later (after the bytes are up): the tray's answer is what it gets
    expect(await measureImageFile(file)).toEqual({ width: 1600, height: 900 });
    expect(createImageBitmap).toHaveBeenCalledTimes(1);
  });

  it("answers no size when the thumbnail's decode failed, and does not decode again to find out", async () => {
    createImageBitmap.mockRejectedValue(new Error("undecodable"));
    const file = pickedPhoto("undecodable.jpg");
    renderTray();
    await flush();
    expect(createImageBitmap).toHaveBeenCalledTimes(1);
    expect(await measureImageFile(file)).toBeNull();
    expect(createImageBitmap).toHaveBeenCalledTimes(1);
  });

  it("decodes for the tray with the orientation asked for, so the size it shares is the shown one", async () => {
    createImageBitmap.mockResolvedValue({ width: 3024, height: 4032, close: vi.fn() });
    const file = pickedPhoto("portrait.jpg");
    renderTray();
    await flush();
    expect(createImageBitmap).toHaveBeenCalledTimes(1);
    expect(createImageBitmap).toHaveBeenNthCalledWith(1, file, { imageOrientation: "from-image" });
    expect(await measureImageFile(file)).toEqual({ width: 3024, height: 4032 });
  });

  it("still draws the thumbnail and shares the size when the engine does not know the orientation value (one decode, tried twice)", async () => {
    const close = vi.fn();
    createImageBitmap.mockImplementation((_file: File, options?: unknown) =>
      options === undefined
        ? Promise.resolve({ width: 1280, height: 720, close })
        : Promise.reject(new TypeError("not a valid enum value of type ImageOrientation"))
    );
    const file = pickedPhoto("old-engine.jpg");
    renderTray();
    await flush();
    renderTray();
    expect(host.querySelector('[data-testid="attachment-chip-thumb"]')).not.toBeNull();
    expect(createImageBitmap).toHaveBeenCalledTimes(2);
    expect(await measureImageFile(file)).toEqual({ width: 1280, height: 720 });
    expect(createImageBitmap).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("measures by itself when no tray ever decoded the file (the composer is not on screen)", async () => {
    createImageBitmap.mockResolvedValue({ width: 800, height: 600, close: vi.fn() });
    const file = pickedPhoto("no-tray.jpg");
    // nothing renders the tray: the draft is still uploading, nobody drew its thumbnail
    expect(await measureImageFile(file)).toEqual({ width: 800, height: 600 });
    expect(createImageBitmap).toHaveBeenCalledTimes(1);
  });
});

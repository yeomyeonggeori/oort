// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 컴포저 트레이 썸네일 (#2701).
//
// 여기서 재는 것은 「그림이 보이는가」 하나가 아니라 셋이다.
//   1. 안전한 래스터 이미지만 썸네일이 된다(타임라인 인라인 미리보기와 같은 판정).
//   2. 썸네일은 `data:` 로 걸린다. 배포 CSP 가 `img-src 'self' data:` 라서
//      `blob:` 은 깨진 상자가 된다 — 이 단정이 없으면 jsdom 에서는 초록이고
//      배포에서는 빈 칸인 수리가 통과한다.
//   3. 디코드에 실패한 파일은 아이콘으로 돌아간다. 첨부 자체는 멀쩡하므로 오류
//      문장을 칩에 얹지 않는다.

vi.mock("@momo/core/lib/api", () => ({
  ApiError: class extends Error {},
  // 업로드는 이 파일의 관심이 아니다. 영원히 대기시켜 칩이 「업로드 중」에 머문다.
  createAttachmentUpload: () => new Promise(() => {}),
  completeAttachmentUpload: () => new Promise(() => {}),
}));

const createImageBitmap = vi.fn();
const toDataURL = vi.fn(() => "data:image/png;base64,VEhVTUI=");
const drawImage = vi.fn();

const { addFiles, dropDraft, readSurface, resetAttachmentDraftsForTest, surfaceKey } =
  await import("./draftStore");
const { AttachmentTray } = await import("./AttachmentTray");

const KEY = surfaceKey("ws", "ch");
const TARGET = { workspaceId: "ws", channelId: "ch" };

let host: HTMLDivElement;
let root: Root;

function file(name: string, type: string, size = 64_000): File {
  return new File([new Uint8Array(size)], name, { type });
}

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

beforeEach(() => {
  resetAttachmentDraftsForTest();
  createImageBitmap.mockReset();
  toDataURL.mockClear();
  drawImage.mockClear();
  createImageBitmap.mockResolvedValue({ width: 1600, height: 900, close: vi.fn() });
  vi.stubGlobal("createImageBitmap", createImageBitmap);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () => ({ drawImage }) as unknown as CanvasRenderingContext2D
  );
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(toDataURL);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(URL, "createObjectURL");
});

describe("composer tray thumbnail", () => {
  it("draws a raster image draft as a data: thumbnail, never a blob: URL", async () => {
    const createObjectURL = vi.fn(() => "blob:nope");
    Object.defineProperty(URL, "createObjectURL", {
      value: createObjectURL,
      configurable: true,
    });
    addFiles(KEY, TARGET, [file("deny-after-denial.png", "image/png")]);
    renderTray();
    const chip = host.querySelector('[data-testid="attachment-chip"]');
    expect(chip?.getAttribute("data-thumb")).toBe("loading");
    await flush();
    renderTray();
    const img = host.querySelector<HTMLImageElement>(
      '[data-testid="attachment-chip-thumb"]'
    );
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).toMatch(/^data:image\//);
    expect(img?.getAttribute("alt")).toBe("");
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(createImageBitmap).toHaveBeenCalledTimes(1);
    // 표시 크기의 두 배로 그린다. 원본 해상도로 문자열을 만들면 20개 상한에서
    // base64 가 수백 MB 가 된다.
    expect(drawImage).toHaveBeenCalledTimes(1);
  });

  it("keeps the icon for files that are not safe raster images", async () => {
    addFiles(KEY, TARGET, [
      file("drain.log", "text/plain"),
      file("logo.svg", "image/svg+xml"),
    ]);
    renderTray();
    await flush();
    renderTray();
    expect(host.querySelector('[data-testid="attachment-chip-thumb"]')).toBeNull();
    for (const chip of host.querySelectorAll('[data-testid="attachment-chip"]')) {
      expect(chip.getAttribute("data-thumb")).toBe("none");
    }
    expect(createImageBitmap).not.toHaveBeenCalled();
  });

  it("falls back to the icon when the browser cannot decode the image", async () => {
    createImageBitmap.mockRejectedValue(new Error("decode"));
    addFiles(KEY, TARGET, [file("IMG_0412.heic", "image/heic")]);
    renderTray();
    await flush();
    renderTray();
    const chip = host.querySelector('[data-testid="attachment-chip"]');
    expect(chip?.getAttribute("data-thumb")).toBe("failed");
    expect(host.querySelector('[data-testid="attachment-chip-thumb"]')).toBeNull();
    // 썸네일 실패는 첨부 실패가 아니다: 상태 줄은 업로드 문장 그대로다.
    expect(
      host.querySelector('[data-testid="attachment-chip-status"]')?.className
    ).not.toMatch(/text-danger/);
  });

  it("decodes once per file even across re-renders, and stops after removal", async () => {
    addFiles(KEY, TARGET, [file("curve.png", "image/png")]);
    renderTray();
    await flush();
    renderTray();
    renderTray();
    expect(createImageBitmap).toHaveBeenCalledTimes(1);
    const localId = readSurface(KEY).drafts[0]?.localId ?? "";
    dropDraft(KEY, localId);
    renderTray();
    expect(host.querySelector('[data-testid="attachment-chip"]')).toBeNull();
  });
});

// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ATTACH_COPY, type MessageAttachment } from "@momo/core/features/attachments/model";
import { inlineImageBox } from "./inlineImageModel";

// 처음 보는 사진도 첫 프레임부터 제 칸에 선다 (ADR-0151 증보 9 I6, #5469).
//
// 보내는 기기가 선언한 가로세로(`media: {kind: "image", width, height}`)는 **그림이 오기 전까지의 칸**이다. 여기서 재는 것은 다섯이다.
//   1. 받는 동안의 자리가 **그림이 설 상자와 같다**(같은 폭·높이 속성) — 그림이 도착해도 줄 높이가 움직이지 않는다.
//   2. **디코드된 실제 크기가 선언을 이긴다**: 선언이 틀리면 한 번 고쳐 서고 그 크기를 기억한다.
//   3. 선언은 **기억되지 않는다**(거짓 선언이 「잰 크기」로 남지 않는다) — 기억한 잰 크기가 선언보다 먼저다.
//   4. 선언이 없거나 어긋나면 오늘과 같다(높이 180 자리, 옛 메시지).
//   5. 격자 타일·못 불러온 그림은 그대로다.
// 코어의 범위·종류 판정(`attachmentImageSizeOf`)은 코어 시험이 재고, 여기서는 그 판정이 **화면에 닿는 길**을 잰다.

let previewStatus: "loading" | "ready" | "failed" = "ready";

vi.mock("@/app/session", () => ({
  useSession: () => ({ workspaceId: "ws", connStatus: "connected" }),
}));
vi.mock("@/features/attachments/content", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/attachments/content")>();
  return {
    ...actual,
    useAttachmentPreview: () =>
      previewStatus === "ready"
        ? { status: "ready", dataUrl: "data:image/png;base64,AAAA", retry: () => {} }
        : { status: previewStatus, retry: () => {} },
  };
});

const { AttachmentList } = await import("../timeline/AttachmentList");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

const declared = (width: number, height: number) => ({ kind: "image", width, height });

function photo(id: string, media?: unknown, mime = "image/jpeg"): MessageAttachment {
  return {
    id,
    name: "IMG_0001.jpg",
    mime,
    sizeBytes: 3_100_000,
    ...(media === undefined ? {} : { media }),
  } as MessageAttachment;
}

function render(attachments: MessageAttachment[]) {
  act(() => {
    root.render(<AttachmentList channelId="ch" attachments={attachments} />);
  });
}

function remount() {
  act(() => root.unmount());
  root = createRoot(host);
}

const q = (selector: string, from: ParentNode = host) => from.querySelector<HTMLElement>(selector);
const figure = () => q('[data-testid="attachment-image"]') as HTMLElement;
const picture = () => q('[data-testid="attachment-image"] img') as HTMLImageElement;
const clip = () => q('[data-testid="attachment-image"] button') as HTMLButtonElement;
const reserve = () => q('[data-testid="attachment-image-reserve"]') as HTMLCanvasElement | null;

/** 브라우저가 디코드를 마친 순간: 자연 크기가 생기고 `load` 가 뜬다. */
function decoded(node: HTMLImageElement, width: number, height: number) {
  Object.defineProperty(node, "naturalWidth", { configurable: true, value: width });
  Object.defineProperty(node, "naturalHeight", { configurable: true, value: height });
  act(() => {
    node.dispatchEvent(new Event("load"));
  });
}

const box = (el: Element | null) => [el?.getAttribute("width"), el?.getAttribute("height")];

beforeEach(() => {
  previewStatus = "ready";
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("a picture whose sender declared its size", () => {
  it("is waited for in the same box the picture will fill — the row does not move when the picture arrives", () => {
    previewStatus = "loading";
    render([photo("declared-standard", declared(4032, 3024))]);
    const waiting = reserve();
    expect(waiting).not.toBeNull();
    const rule = inlineImageBox({ width: 4032, height: 3024 });
    expect(rule).toEqual({ width: 360, height: 270, wide: false });
    expect(box(waiting)).toEqual(["360", "270"]);
    // while it waits there is no picture yet, and the frame is not the old 180-high one
    expect(picture()).toBeNull();
    expect(clip().className).not.toContain("h-preview-frame");

    // the bytes arrive: the first frame of the picture is already the box it was waited for in
    previewStatus = "ready";
    render([photo("declared-standard", declared(4032, 3024))]);
    expect(reserve()).toBeNull();
    expect(box(picture())).toEqual(["360", "270"]);
    // and the decode of an honest declaration moves nothing
    decoded(picture(), 4032, 3024);
    expect(box(picture())).toEqual(["360", "270"]);
  });

  it("is waited for in the wide box too (a caption strip keeps its height-180 rule and is marked wide from the first frame)", () => {
    previewStatus = "loading";
    render([photo("declared-wide", declared(2072, 110))]);
    expect(box(reserve())).toEqual(["1036", "55"]);
    expect(figure().hasAttribute("data-wide")).toBe(true);
    previewStatus = "ready";
    render([photo("declared-wide", declared(2072, 110))]);
    expect(box(picture())).toEqual(["1036", "55"]);
    decoded(picture(), 2072, 110);
    expect(box(picture())).toEqual(["1036", "55"]);
    expect(figure().hasAttribute("data-wide")).toBe(true);
  });

  it("is waited for in the box of every shape the rule has (tall, large, small)", () => {
    for (const [id, w, h, shown] of [
      ["declared-tall", 600, 2400, ["80", "320"]],
      ["declared-large", 3200, 2400, ["360", "270"]],
      ["declared-small", 240, 160, ["240", "160"]],
    ] as const) {
      previewStatus = "loading";
      render([photo(id, declared(w, h))]);
      expect(box(reserve()), id).toEqual(shown);
      previewStatus = "ready";
      render([photo(id, declared(w, h))]);
      expect(box(picture()), id).toEqual(shown);
      decoded(picture(), w, h);
      expect(box(picture()), id).toEqual(shown);
    }
  });

  it("shrinks in a narrow column the way the picture does, with the picture's corner and no inline style", () => {
    previewStatus = "loading";
    render([photo("declared-narrow", declared(1500, 600))]);
    const waiting = reserve() as HTMLCanvasElement;
    previewStatus = "ready";
    render([photo("declared-narrow", declared(1500, 600))]);
    const arrived = picture();
    for (const fit of ["h-auto", "max-w-full"]) {
      expect(waiting.className).toContain(fit);
      expect(arrived.className).toContain(fit);
    }
    // the box (a canvas) is not a picture of its own: hidden from assistive tech, no style attribute
    expect(waiting.getAttribute("aria-hidden")).toBe("true");
    expect(waiting.hasAttribute("style")).toBe(false);
    // the frame carries the picture's corner (a flat 10px radius would make a pill of a thin strip)
    previewStatus = "loading";
    render([photo("declared-narrow-2", declared(1200, 60))]);
    expect(clip().className).toContain("image-corner");
    expect(clip().className).not.toMatch(/\brounded-/);
  });

  it("says it is loading in the box, with the words the old frame used", () => {
    previewStatus = "loading";
    render([photo("declared-words", declared(640, 480))]);
    expect(clip().textContent).toBe(ATTACH_COPY.previewLoading);
    const label = q("span", clip()) as HTMLElement;
    expect(label.className).toContain("absolute");
    expect(label.className).toContain("inset-0");
  });

  it("takes the decoded size over the declaration when they differ, once, and remembers what it decoded", () => {
    render([photo("declared-wrong", declared(400, 300))]);
    // the first frame trusts the declaration (a landscape box) …
    expect(box(picture())).toEqual(["360", "270"]);
    // … the decode says the picture is portrait: the box is corrected to the real one
    decoded(picture(), 300, 400);
    expect(box(picture())).toEqual(["240", "320"]);
    expect(inlineImageBox({ width: 300, height: 400 })).toMatchObject({ width: 240, height: 320 });

    // a remounted row (the same picture) starts at the size that was decoded, declaration or not
    remount();
    previewStatus = "loading";
    render([photo("declared-wrong")]);
    expect(box(reserve())).toEqual(["240", "320"]);
    remount();
    render([photo("declared-wrong", declared(400, 300))]);
    expect(box(reserve())).toEqual(["240", "320"]);
  });

  it("is not remembered: a picture that only ever had a declaration has none the next time", () => {
    previewStatus = "loading";
    render([photo("declared-never-seen", declared(400, 300))]);
    expect(box(reserve())).toEqual(["360", "270"]);
    remount();
    // the same id comes back without a declaration (an old copy of the message): the frame is the old one
    render([photo("declared-never-seen")]);
    expect(reserve()).toBeNull();
    expect(clip().className).toContain("h-preview-frame");
  });

  it("gives way to a size that was decoded earlier, whatever the declaration says now", () => {
    render([photo("remembered-first", declared(400, 300))]);
    decoded(picture(), 1500, 600);
    expect(box(picture())).toEqual(["450", "180"]);
    remount();
    previewStatus = "loading";
    render([photo("remembered-first", declared(400, 300))]);
    expect(box(reserve())).toEqual(["450", "180"]);
    expect(figure().hasAttribute("data-wide")).toBe(true);
  });
});

describe("a picture with no usable declaration is waited for as it always was", () => {
  it("keeps the old 180-high frame and its words when nobody declared a size", () => {
    previewStatus = "loading";
    render([photo("undeclared")]);
    expect(reserve()).toBeNull();
    expect(clip().className).toContain("h-preview-frame");
    expect(clip().className).toContain("w-pane");
    expect(clip().textContent).toBe(ATTACH_COPY.previewLoading);
  });

  it("ignores a declaration outside the range the server holds, or that is not whole numbers", () => {
    previewStatus = "loading";
    for (const [index, media] of [
      declared(0, 300),
      declared(400, 0),
      declared(16_385, 300),
      declared(400, 16_385),
      declared(400.5, 300),
      declared(-4, 300),
      { kind: "image", width: 400 },
      { kind: "hologram", width: 400, height: 300 },
      { kind: "video", durationMs: 1000, width: 400, height: 300, hasPoster: false },
    ].entries()) {
      render([photo(`out-of-range-${index}`, media)]);
      expect(reserve(), JSON.stringify(media)).toBeNull();
      expect(clip().className, JSON.stringify(media)).toContain("h-preview-frame");
    }
  });

  it("takes a file that is not an image as a card, whatever summary it carries", () => {
    previewStatus = "loading";
    render([photo("pdf-with-a-size", declared(400, 300), "application/pdf")]);
    expect(reserve()).toBeNull();
    expect(q('[data-testid="attachment-image"]')).toBeNull();
    expect(q('[data-testid="attachment-card"]')).not.toBeNull();
  });
});

describe("what a declaration does not touch", () => {
  it("leaves grid tiles square, with no box waiting in them", () => {
    previewStatus = "loading";
    render([photo("grid-a", declared(2072, 110)), photo("grid-b", declared(400, 300))]);
    const frames = host.querySelectorAll<HTMLElement>('[data-testid="attachment-image"] button');
    expect(frames).toHaveLength(2);
    expect(reserve()).toBeNull();
    for (const frame of frames) expect(frame.className).toContain("size-full");
    previewStatus = "ready";
    render([photo("grid-a", declared(2072, 110)), photo("grid-b", declared(400, 300))]);
    for (const tile of host.querySelectorAll<HTMLImageElement>('[data-testid="attachment-image"] img')) {
      expect(tile.hasAttribute("width")).toBe(false);
      expect(tile.className).toContain("object-cover");
    }
  });

  it("goes back to the legible frame, and its words, when the picture could not be loaded", () => {
    previewStatus = "failed";
    render([photo("declared-failed", declared(640, 480))]);
    expect(reserve()).toBeNull();
    expect(clip().className).toContain("h-preview-frame");
    expect(clip().textContent).toBe(ATTACH_COPY.previewFailed);
  });
});

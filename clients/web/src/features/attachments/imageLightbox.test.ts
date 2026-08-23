import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  imageLightboxViewState,
  lightboxAttachments,
  nextImageLightboxIndex,
  updateAttachmentIdSet,
} from "./imageLightboxModel";

const COMPONENT = readFileSync(new URL("./ImageLightbox.tsx", import.meta.url), "utf8");
const LIST = readFileSync(
  new URL("../timeline/AttachmentList.tsx", import.meta.url),
  "utf8"
);

describe("image lightbox state", () => {
  it("distinguishes the four mandatory non-ready surfaces", () => {
    expect(
      imageLightboxViewState({
        hasImage: false,
        previewStatus: "loading",
        offline: false,
      })
    ).toBe("empty");
    expect(
      imageLightboxViewState({
        hasImage: true,
        previewStatus: "loading",
        offline: false,
      })
    ).toBe("loading");
    expect(
      imageLightboxViewState({
        hasImage: true,
        previewStatus: "failed",
        offline: false,
      })
    ).toBe("error");
    expect(
      imageLightboxViewState({
        hasImage: true,
        previewStatus: "failed",
        offline: true,
      })
    ).toBe("offline");
  });

  it("keeps a cached image visible while offline", () => {
    expect(
      imageLightboxViewState({
        hasImage: true,
        previewStatus: "ready",
        offline: true,
      })
    ).toBe("ready");
  });
});

describe("image lightbox navigation", () => {
  it("moves in both directions and wraps within one message", () => {
    expect(nextImageLightboxIndex(0, 3, "ArrowRight")).toBe(1);
    expect(nextImageLightboxIndex(2, 3, "ArrowRight")).toBe(0);
    expect(nextImageLightboxIndex(2, 3, "ArrowLeft")).toBe(1);
    expect(nextImageLightboxIndex(0, 3, "ArrowLeft")).toBe(2);
  });

  it("leaves unrelated keys and invalid selections alone", () => {
    expect(nextImageLightboxIndex(0, 3, "Escape")).toBeNull();
    expect(nextImageLightboxIndex(-1, 3, "ArrowRight")).toBeNull();
    expect(nextImageLightboxIndex(0, 0, "ArrowRight")).toBeNull();
  });

  it("keeps in-flight download state attached to its image while navigating", () => {
    let busy = new Set<string>();
    busy = updateAttachmentIdSet(busy, "image-a", true);
    expect(busy.has("image-a")).toBe(true);
    expect(busy.has("image-b")).toBe(false);

    busy = updateAttachmentIdSet(busy, "image-b", true);
    busy = updateAttachmentIdSet(busy, "image-a", false);
    expect(busy.has("image-a")).toBe(false);
    expect(busy.has("image-b")).toBe(true);
  });

  it("admits only the same safe images that the timeline previews", () => {
    const attachments = [
      { id: "a", name: "one.png", mime: "image/png", sizeBytes: 1024 },
      { id: "b", name: "vector.svg", mime: "image/svg+xml", sizeBytes: 1024 },
      { id: "c", name: "notes.txt", mime: "text/plain", sizeBytes: 1024 },
    ];
    expect(lightboxAttachments(attachments).map((item) => item.id)).toEqual(["a"]);
  });
});

describe("image lightbox integration contract", () => {
  it("uses the programmatic Dialog opener pattern and no DialogTrigger", () => {
    expect(COMPONENT).toContain("<Dialog open={open} onOpenChange={onOpenChange}>");
    expect(COMPONENT).toContain("opener={opener}");
    expect(COMPONENT).not.toContain("<DialogTrigger");
    expect(LIST).toContain("onClick={(event) => onOpen(event.currentTarget)}");
    expect(LIST).toContain("opener={lightboxOpener.current}");
  });

  it("publishes keyboard, aria, and all state seams", () => {
    for (const seam of [
      "image-lightbox-empty",
      "image-lightbox-loading",
      "image-lightbox-error",
      "image-lightbox-offline",
      "image-lightbox-ready",
    ]) {
      expect(COMPONENT).toContain(seam);
    }
    expect(COMPONENT).toContain("onKeyDown={(event) =>");
    expect(COMPONENT).toContain('move("ArrowLeft")');
    expect(COMPONENT).toContain('move("ArrowRight")');
    expect(COMPONENT).toContain('aria-label="이전 이미지"');
    expect(COMPONENT).toContain('aria-label="다음 이미지"');
    expect(COMPONENT).toContain("busy={downloadBusyIds.has(selected.id)}");
    expect(COMPONENT).toContain("tapTarget");
    expect(COMPONENT.match(/className="tap-target"/g)).toHaveLength(4);
    expect(COMPONENT).toContain('from "@/design/ui/button"');
    expect(LIST).toContain("focus-visible:focus-ring");
  });
});

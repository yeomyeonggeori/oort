import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  imageLightboxViewState,
  lightboxAttachments,
  lightboxInfoLines,
  lightboxPositionLabel,
  lightboxSentAtLabel,
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
    // 터치 타깃(`tap-target`)은 렌더된 버튼의 클래스로 attachmentBuzz.test.tsx가 잰다(#4751: 글자 버튼이 둥근 유리 아이콘
    // 버튼 한 벌 상수로 바뀌어, 리터럴 개수를 세던 이 줄은 더 이상 같은 일을 보지 않는다).
    expect(COMPONENT).toContain('from "@/design/ui/button"');
    expect(LIST).toContain("focus-visible:focus-ring");
  });
});

describe("image lightbox top-left chip and caption labels (#4751)", () => {
  // 2026-10-29 14:43 로컬 시각. 시험은 연도·월·일·시:분 구성요소로 만든 시각을 읽으므로 시간대에 기대지 않는다.
  const SENT = new Date(2026, 9, 29, 14, 43).getTime();
  const NOW_SAME_YEAR = new Date(2026, 11, 1, 9, 0).getTime();
  const NOW_NEXT_YEAR = new Date(2027, 0, 5, 9, 0).getTime();

  it("names the caption by how many pictures there are and which one is shown", () => {
    expect(lightboxPositionLabel(0, 3)).toBe("3장 중 1번");
    expect(lightboxPositionLabel(2, 3)).toBe("3장 중 3번");
  });

  it("prints the sent time as month, day and clock, and adds the year only when it is not this year", () => {
    const same = lightboxSentAtLabel(SENT, NOW_SAME_YEAR) ?? "";
    expect(same).toContain("10월 29일");
    expect(same).toContain("2:43");
    expect(same).not.toContain("2026");

    const other = lightboxSentAtLabel(SENT, NOW_NEXT_YEAR) ?? "";
    expect(other).toContain("2026");
    expect(other).toContain("10월 29일");
  });

  it("invents no time when the row has none yet", () => {
    expect(lightboxSentAtLabel(null)).toBeNull();
    expect(lightboxSentAtLabel(undefined)).toBeNull();
    expect(lightboxSentAtLabel(Number.NaN)).toBeNull();
  });

  it("puts the sender first and the file name aside, and falls back to the file name without a sender", () => {
    const withSender = lightboxInfoLines({
      senderName: " 이도현 ",
      sentAtMs: SENT,
      fileName: "시안.png",
      nowMs: NOW_SAME_YEAR,
    });
    expect(withSender.primary).toBe("이도현");
    expect(withSender.secondary).toContain("10월 29일");
    expect(withSender.fileName).toBe("시안.png");

    const without = lightboxInfoLines({ senderName: "  ", fileName: "시안.png" });
    expect(without.primary).toBe("시안.png");
    expect(without.secondary).toBeNull();
  });
});

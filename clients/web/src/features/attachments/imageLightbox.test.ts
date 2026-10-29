import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  LIGHTBOX_FIT_VIEW,
  LIGHTBOX_MAX_ZOOM,
  clampLightboxView,
  clampLightboxZoom,
  imageLightboxViewState,
  isLightboxFit,
  lightboxActualSizeZoom,
  lightboxAttachments,
  lightboxInfoLines,
  lightboxPositionLabel,
  lightboxSentAtLabel,
  lightboxWheelFactor,
  lightboxZoomKeyAction,
  lightboxZoomLabel,
  nextImageLightboxIndex,
  stepLightboxZoom,
  updateAttachmentIdSet,
  zoomLightboxViewAt,
  type LightboxGeometry,
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

// 확대의 계산 (#4770). 배율은 맞춤이 1이고, 이동은 사진 중심이 맞춤 자리에서 벗어난 화면 픽셀이다. DOM이 아니라 숫자만 본다:
// 커서 아래의 점이 그대로 있는지, 확대한 사진이 창 밖으로 사라지지 않는지, 맞춤이 늘 (0, 0)인지.
describe("image lightbox zoom math (#4770)", () => {
  // 뷰어 1000x700, 맞춤 사진 600x400이 한가운데(500, 350)에 선 모양. 위 칩 줄·썸네일 줄이 없는 단일 사진이다.
  const GEO: LightboxGeometry = {
    photoWidth: 600,
    photoHeight: 400,
    centerX: 500,
    centerY: 350,
    viewWidth: 1000,
    viewHeight: 700,
  };
  /** 뷰어 좌표 `at` 아래에 있는 사진의 점(사진 중심 기준, 맞춤 픽셀). 변환 `translate(t) scale(z)`의 역이다. */
  const pointUnder = (view: { zoom: number; x: number; y: number }, at: { x: number; y: number }, geo = GEO) => ({
    x: (at.x - geo.centerX - view.x) / view.zoom,
    y: (at.y - geo.centerY - view.y) / view.zoom,
  });

  it("keeps the zoom between fit and four times fit", () => {
    expect(clampLightboxZoom(0.4)).toBe(1);
    expect(clampLightboxZoom(2.5)).toBe(2.5);
    expect(clampLightboxZoom(9)).toBe(LIGHTBOX_MAX_ZOOM);
    expect(clampLightboxZoom(Number.POSITIVE_INFINITY)).toBe(LIGHTBOX_MAX_ZOOM);
    expect(clampLightboxZoom(Number.NaN)).toBe(1);
    expect(isLightboxFit(1)).toBe(true);
    expect(isLightboxFit(1.005)).toBe(true);
    expect(isLightboxFit(1.25)).toBe(false);
  });

  it("zooms in on a spread and out on a pinch, and never jumps from fit to the maximum on one wheel notch", () => {
    expect(lightboxWheelFactor(-8)).toBeGreaterThan(1);
    expect(lightboxWheelFactor(8)).toBeLessThan(1);
    expect(lightboxWheelFactor(0)).toBe(1);
    expect(lightboxWheelFactor(Number.NaN)).toBe(1);
    // ⌘를 누른 마우스 휠 한 칸(±100)도, 줄 단위로 오는 한 칸(±3줄)도 같은 상한에서 잘린다.
    for (const notch of [lightboxWheelFactor(-100), lightboxWheelFactor(-3, 1)]) {
      expect(notch).toBeGreaterThan(1);
      expect(notch).toBeLessThanOrEqual(1.25);
    }
    for (const notch of [lightboxWheelFactor(100), lightboxWheelFactor(3, 1)]) {
      expect(notch).toBeLessThan(1);
      expect(notch).toBeGreaterThanOrEqual(0.8);
    }
  });

  it("steps by a fixed ratio, stops at the ends and lands exactly on fit when stepping back", () => {
    expect(stepLightboxZoom(1, 1)).toBeCloseTo(1.25, 10);
    expect(stepLightboxZoom(3.9, 1)).toBe(LIGHTBOX_MAX_ZOOM);
    expect(stepLightboxZoom(LIGHTBOX_MAX_ZOOM, 1)).toBe(LIGHTBOX_MAX_ZOOM);
    expect(stepLightboxZoom(1.25, -1)).toBe(1);
    // 핀치가 1.1배에 두고 간 뒤의 ⌘-는 1.01배 어딘가가 아니라 맞춤이다.
    expect(stepLightboxZoom(1.1, -1)).toBe(1);
    expect(stepLightboxZoom(1, -1)).toBe(1);
  });

  it("goes to 100% of the picture's own size on a double click, or twice fit when fit is already 100% or more", () => {
    // 맞춤이 자연 크기의 25%인 큰 사진: 실제 크기는 맞춤의 4배.
    expect(lightboxActualSizeZoom(0.25)).toBe(4);
    // 맞춤이 80%인 사진: 실제 크기는 맞춤의 1.25배.
    expect(lightboxActualSizeZoom(0.8)).toBeCloseTo(1.25, 10);
    // 무대보다 작은 사진(맞춤 = 100%)과 크기를 모를 때는 2배.
    expect(lightboxActualSizeZoom(1)).toBe(2);
    expect(lightboxActualSizeZoom(null)).toBe(2);
    // 아주 큰 사진은 실제 크기가 4배를 넘어도 4배에서 멈춘다.
    expect(lightboxActualSizeZoom(0.1)).toBe(LIGHTBOX_MAX_ZOOM);
  });

  it("labels fit in words and anything else as a percentage of the picture's own size", () => {
    expect(lightboxZoomLabel(1, 0.5)).toBe("맞춤");
    expect(lightboxZoomLabel(1.004, 0.5)).toBe("맞춤");
    // 맞춤이 50%인 사진을 2배로 보면 실제 크기다.
    expect(lightboxZoomLabel(2, 0.5)).toBe("100%");
    expect(lightboxZoomLabel(4, 0.5)).toBe("200%");
    expect(lightboxZoomLabel(1.3333, 0.75)).toBe("100%");
    // 자연 크기를 모르면 맞춤 대비로 읽는다.
    expect(lightboxZoomLabel(2, null)).toBe("200%");
  });

  it("reads command or control with plus, minus and zero as zoom keys, by character or by physical key", () => {
    const key = (init: { key: string; code?: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean }) =>
      lightboxZoomKeyAction(init);
    expect(key({ key: "=", code: "Equal", metaKey: true })).toBe("in");
    expect(key({ key: "+", code: "Equal", metaKey: true })).toBe("in");
    expect(key({ key: "+", ctrlKey: true })).toBe("in");
    expect(key({ key: "+", code: "NumpadAdd", metaKey: true })).toBe("in");
    // 독일 배열의 ⌘+는 물리 키가 Equal이 아니지만 글자가 「+」다. 반대로 글자가 낯설어도 물리 키가 맞으면 받는다.
    expect(key({ key: "+", code: "BracketRight", metaKey: true })).toBe("in");
    expect(key({ key: "Dead", code: "Equal", metaKey: true })).toBe("in");
    expect(key({ key: "-", code: "Minus", metaKey: true })).toBe("out");
    expect(key({ key: "-", code: "NumpadSubtract", ctrlKey: true })).toBe("out");
    expect(key({ key: "0", code: "Digit0", metaKey: true })).toBe("fit");
    expect(key({ key: "0", code: "Numpad0", ctrlKey: true })).toBe("fit");
  });

  it("leaves a bare plus, minus or zero and option-modified combinations to the browser", () => {
    expect(lightboxZoomKeyAction({ key: "=", code: "Equal" })).toBeNull();
    expect(lightboxZoomKeyAction({ key: "0", code: "Digit0" })).toBeNull();
    expect(lightboxZoomKeyAction({ key: "_", code: "Minus" })).toBeNull();
    expect(lightboxZoomKeyAction({ key: "=", code: "Equal", metaKey: true, altKey: true })).toBeNull();
    expect(lightboxZoomKeyAction({ key: "k", code: "KeyK", metaKey: true })).toBeNull();
  });

  it("keeps the picture point under the cursor fixed while zooming in, from fit and from an already panned view", () => {
    const at = { x: 560, y: 380 };
    const first = zoomLightboxViewAt(LIGHTBOX_FIT_VIEW, 2, at, GEO);
    expect(first.zoom).toBe(2);
    expect(pointUnder(first, at).x).toBeCloseTo(pointUnder(LIGHTBOX_FIT_VIEW, at).x, 9);
    expect(pointUnder(first, at).y).toBeCloseTo(pointUnder(LIGHTBOX_FIT_VIEW, at).y, 9);

    const next = { x: 700, y: 400 };
    const second = zoomLightboxViewAt(first, 3, next, GEO);
    expect(second.zoom).toBe(3);
    expect(pointUnder(second, next).x).toBeCloseTo(pointUnder(first, next).x, 9);
    expect(pointUnder(second, next).y).toBeCloseTo(pointUnder(first, next).y, 9);
  });

  it("keeps a picture that is still smaller than the window centred while zooming, then follows the cursor once it outgrows the window", () => {
    const corner = { x: 900, y: 120 };
    // 1.2배: 720x480은 창(1000x700)보다 작다. 커서가 구석이어도 가운데에 머문다.
    expect(zoomLightboxViewAt(LIGHTBOX_FIT_VIEW, 1.2, corner, GEO)).toEqual({ zoom: 1.2, x: 0, y: 0 });
    // 2배: 1200x800이 창을 넘겨서 커서 쪽을 따라간다. 구석이면 사진의 오른쪽 위 가장자리가 창 가장자리에 닿는 데까지(왼쪽 아래로 100·50) 밀린다.
    expect(zoomLightboxViewAt(LIGHTBOX_FIT_VIEW, 2, corner, GEO)).toEqual({ zoom: 2, x: -100, y: 50 });
    // 커서가 창 안쪽이면 그 점이 정확히 그 자리에 남는다.
    const near = { x: 560, y: 380 };
    const grown = zoomLightboxViewAt(LIGHTBOX_FIT_VIEW, 2, near, GEO);
    expect(grown).toEqual({ zoom: 2, x: -60, y: -30 });
    expect(pointUnder(grown, near).x).toBeCloseTo(pointUnder(LIGHTBOX_FIT_VIEW, near).x, 9);
    expect(pointUnder(grown, near).y).toBeCloseTo(pointUnder(LIGHTBOX_FIT_VIEW, near).y, 9);
  });

  it("returns to exactly fit, with no leftover pan, when the zoom comes back down to one", () => {
    const zoomed = zoomLightboxViewAt(LIGHTBOX_FIT_VIEW, 3, { x: 700, y: 400 }, GEO);
    expect(zoomed.x === 0 && zoomed.y === 0).toBe(false);
    expect(zoomLightboxViewAt(zoomed, 1, { x: 700, y: 400 }, GEO)).toEqual(LIGHTBOX_FIT_VIEW);
    expect(zoomLightboxViewAt(zoomed, 0.2, { x: 10, y: 10 }, GEO)).toEqual(LIGHTBOX_FIT_VIEW);
    expect(clampLightboxView({ zoom: 1, x: 300, y: -300 }, GEO)).toEqual(LIGHTBOX_FIT_VIEW);
  });

  it("stops a zoomed picture at the window edge on the sides where it is larger than the window", () => {
    // 4배: 사진은 2400x1600이라 두 축 모두 창보다 크다. 왼쪽·위 가장자리가 창 가장자리에 닿는 데까지만 간다.
    const farRight = clampLightboxView({ zoom: 4, x: 9999, y: 9999 }, GEO);
    expect(GEO.centerX + farRight.x - (GEO.photoWidth * 4) / 2).toBe(0);
    expect(GEO.centerY + farRight.y - (GEO.photoHeight * 4) / 2).toBe(0);
    const farLeft = clampLightboxView({ zoom: 4, x: -9999, y: -9999 }, GEO);
    expect(GEO.centerX + farLeft.x + (GEO.photoWidth * 4) / 2).toBe(GEO.viewWidth);
    expect(GEO.centerY + farLeft.y + (GEO.photoHeight * 4) / 2).toBe(GEO.viewHeight);
    // 안쪽은 그대로 둔다.
    expect(clampLightboxView({ zoom: 4, x: 120, y: -80 }, GEO)).toEqual({ zoom: 4, x: 120, y: -80 });
  });

  it("does not let a picture that is still smaller than the window be dragged, on that axis only", () => {
    // 1.5배: 900x600. 너비도 높이도 창(1000x700)보다 작아 움직이지 못한다.
    expect(clampLightboxView({ zoom: 1.5, x: 40, y: -40 }, GEO)).toEqual({ zoom: 1.5, x: 0, y: 0 });
    // 가로로 긴 사진(맞춤 900x150)을 2배로: 너비 1800은 창(1000)보다 커서 움직이고, 높이 300은 창(700)보다 작아 맞춤 자리에 선다.
    const wide: LightboxGeometry = { ...GEO, photoWidth: 900, photoHeight: 150 };
    const view = clampLightboxView({ zoom: 2, x: 90, y: 90 }, wide);
    expect(view.x).toBe(90);
    expect(view.y).toBe(0);
  });

  it("measures the window edge from the real fit position, which a thumbnail strip moves off the window centre", () => {
    // 아래 썸네일 줄이 무대를 좁혀 맞춤 사진 중심이 창 중심(350)보다 30px 위(320)에 선 모양.
    const lifted: LightboxGeometry = { ...GEO, centerY: 320 };
    // 1.8배: 높이 720 > 창 700이 되어 창을 덮어야 한다. 맞춤 자리 그대로(0)면 아래가 20px 빈다 → 20 이상으로 밀린다.
    const covered = clampLightboxView({ zoom: 1.8, x: 0, y: 0 }, lifted);
    expect(lifted.centerY + covered.y + (lifted.photoHeight * 1.8) / 2).toBeGreaterThanOrEqual(lifted.viewHeight);
    expect(covered.y).toBe(20);
    // 아직 창보다 작은(1.6배, 640) 동안에는 맞춤 자리를 지킨다: 위 가장자리가 창 위에 닿았지만 넘지 않는다.
    expect(clampLightboxView({ zoom: 1.6, x: 0, y: 0 }, lifted).y).toBe(0);
  });
});

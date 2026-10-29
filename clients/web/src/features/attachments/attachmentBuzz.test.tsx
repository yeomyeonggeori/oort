// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 첨부 미리보기를 Buzz 처럼 (#3820).
//
// 재는 것 (되돌리면 실패해야 하는 것들):
//   1. 무작위 토큰 같은 파일명이 DOM 어디에도(텍스트·title·alt·aria) 찍히지 않는다.
//   2. 이미지에는 이름·타입·크기 캡션이 없다.
//   3. 내려받기·크게 보기는 호버(또는 포커스)에서만 서고, 떠나면 걷힌다.
//   4. 이미지를 누르면 라이트박스가 열리고 Esc 로 닫힌다. 여러 장은 격자다.
//   5. PDF 카드는 호버에서 미리보기(열기)와 내려받기를 낸다.

vi.mock("@/app/session", () => ({
  useSession: () => ({ workspaceId: "ws", connStatus: "connected" }),
}));
vi.mock("@/features/attachments/content", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/attachments/content")>();
  return {
    ...actual,
    useAttachmentPreview: () => ({
      status: "ready",
      dataUrl: "data:image/png;base64,AAAA",
      retry: () => {},
    }),
  };
});

const { AttachmentList } = await import("../timeline/AttachmentList");
const { lightboxPositionLabel, lightboxSentAtLabel, lightboxZoomLabel } = await import("./imageLightboxModel");
const { ZOOM_CHIP_LINGER_MS } = await import("@/design/motion");

const HASH = "geGngQxZ3pLmK9aVbT2wRq-pQ";
const img = (id: string, name = `${HASH}.webp`) => ({
  id,
  name,
  mime: "image/webp",
  sizeBytes: 9_400,
});
const PDF = {
  id: "pdf-1",
  name: "Q3-온보딩-리뷰.pdf",
  mime: "application/pdf",
  sizeBytes: 182_000,
};
const HASH_PDF = { ...PDF, id: "pdf-2", name: `${HASH}.pdf` };

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

function render(
  attachments: Parameters<typeof AttachmentList>[0]["attachments"],
  extra: Partial<Parameters<typeof AttachmentList>[0]> = {}
) {
  act(() => {
    root.render(<AttachmentList channelId="ch" attachments={attachments} {...extra} />);
  });
}
const q = (sel: string, from: ParentNode = host) => from.querySelector<HTMLElement>(sel);
const hover = (el: Element | null) =>
  act(() => {
    el?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  });
const leave = (el: Element | null) =>
  act(() => {
    el?.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
  });

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("timeline attachments, Buzz style", () => {
  it("never prints a random-token file name anywhere in the DOM", () => {
    render([img("i1"), HASH_PDF]);
    expect(host.innerHTML).not.toContain("geGngQ");
    expect(host.textContent).toContain("PDF 문서");
    expect(q('[data-testid="attachment-image"] img')?.getAttribute("alt")).toBe("이미지");
  });

  it("keeps a name a person wrote on a file card", () => {
    render([PDF]);
    expect(host.textContent).toContain("Q3-온보딩-리뷰.pdf");
  });

  it("gives an inline image no caption, no name, no size", () => {
    render([img("i1")]);
    expect(q('[data-testid="attachment-meta"]')).toBeNull();
    expect(host.querySelector("figcaption")).toBeNull();
    expect(host.textContent).not.toMatch(/KB|이미지 ·/);
    expect(q('[data-testid="attachment-image"] img')?.className).not.toMatch(/\bborder\b/);
  });

  it("reveals download and expand on hover and takes them away on leave", () => {
    render([img("i1")]);
    const figure = q('[data-testid="attachment-image"]');
    expect(q('[data-testid="attachment-download"]')).toBeNull();
    hover(figure);
    expect(q('[data-testid="attachment-download"]', figure!)).not.toBeNull();
    expect(q('[data-testid="attachment-expand"]', figure!)).not.toBeNull();
    leave(figure);
    expect(q('[data-testid="attachment-download"]')).toBeNull();
  });

  it("opens the lightbox on click and closes it with Escape", () => {
    render([img("i1")]);
    act(() => {
      q('[data-testid="attachment-image"] button')?.click();
    });
    expect(document.body.querySelector('[data-testid="image-lightbox"]')).not.toBeNull();
    // 라이트박스 머리에도 해시 이름이 없다.
    expect(document.body.innerHTML).not.toContain("geGngQ");
    act(() => {
      document.body
        .querySelector('[data-testid="image-lightbox"]')
        ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(document.body.querySelector('[data-testid="image-lightbox"]')).toBeNull();
  });

  it("groups several images into a grid and opens the tapped one", () => {
    render([img("i1"), img("i2"), img("i3")]);
    const grid = q('[data-testid="attachment-image-grid"]');
    expect(grid?.getAttribute("data-columns")).toBe("2");
    const tiles = grid!.querySelectorAll('[data-testid="attachment-image"] button');
    expect(tiles).toHaveLength(3);
    act(() => (tiles[1] as HTMLButtonElement).click());
    expect(
      document.body.querySelector('[data-testid="image-lightbox-position"]')?.textContent
    ).toBe(lightboxPositionLabel(1, 3));
  });

  it("offers preview and download on a PDF card only while hovered", () => {
    render([PDF]);
    const card = q('[data-testid="attachment-card"]');
    expect(q('[data-testid="attachment-open-pdf"]')).toBeNull();
    expect(q('[data-testid="attachment-download"]')).toBeNull();
    hover(card);
    expect(q('[data-testid="attachment-open-pdf"]', card!)).not.toBeNull();
    expect(q('[data-testid="attachment-download"]', card!)).not.toBeNull();
  });

  it("reaches a file card's actions by keyboard alone", () => {
    render([PDF]);
    const card = q('[data-testid="attachment-card"]')!;
    expect(card.tabIndex).toBe(0);
    expect(q('[data-testid="attachment-open-pdf"]')).toBeNull();
    act(() => card.focus());
    expect(q('[data-testid="attachment-open-pdf"]', card)).not.toBeNull();
    expect(q('[data-testid="attachment-download"]', card)).not.toBeNull();
  });

  it("reaches an image's actions by keyboard and tells repeated images apart", () => {
    render([img("i1"), img("i2")]);
    const figure = q('[data-testid="attachment-image"]')!;
    act(() => q("button", figure)!.focus());
    expect(q('[data-testid="attachment-download"]', figure)).not.toBeNull();
    expect(q("button", figure)!.getAttribute("aria-label")).toBe("이미지 1/2 크게 보기");
  });
});

// 이미지 미리보기: 블러 무대 위의 둥근 유리 아이콘 버튼 (#4751).
//
// 재는 것 (되돌리면 실패해야 하는 것들):
//   1. 위 왼쪽 칩은 보낸 사람(첫 줄)과 보낸 시각(둘째 줄)이고, 파일 이름은 툴팁과 대화상자 이름으로 내려가 있다.
//   2. 빈 무대를 누르면 닫히고, 사진·칩·버튼을 누르면 닫히지 않는다(바깥 클릭).
//   3. 이전·다음·썸네일 줄·「N장 중 n번」은 두 장 이상일 때만 선다.
//   4. 조작은 글자 없는 아이콘 버튼이고 접근성 이름과 터치 타깃 클래스를 든다. 닫기가 처음 포커스를 받는다.
describe("image lightbox, floating glass controls", () => {
  const SENT = new Date(2026, 9, 29, 14, 43).getTime();
  const lb = (sel: string) => document.body.querySelector<HTMLElement>(sel);
  const openFirst = () =>
    act(() => {
      q('[data-testid="attachment-image"] button')?.click();
    });
  const key = (name: string) =>
    act(() => {
      lb('[data-testid="image-lightbox"]')?.dispatchEvent(
        new KeyboardEvent("keydown", { key: name, bubbles: true })
      );
    });

  it("shows the sender and the sent time on the top-left chip and keeps the file name aside", () => {
    render([img("i1", "간판-시안.webp")], { senderName: "이도현", sentAtMs: SENT });
    openFirst();
    const info = lb('[data-testid="image-lightbox-info"]')!;
    expect(info.textContent).toContain("이도현");
    expect(info.textContent).toContain(lightboxSentAtLabel(SENT) ?? "(no label)");
    expect(info.textContent).not.toContain("간판-시안.webp");
    expect(info.getAttribute("title")).toBe("간판-시안.webp");
    // 둘째 줄도 주 글자색이다: 보조 글자색은 반투명 유리 칩이 어두운 사이드바 띠 위에 설 때 4.5:1 아래로 내려갔다(design-review #4751).
    expect(lb('[data-testid="image-lightbox-sent-at"]')!.className).not.toContain("text-ink-muted");
    const dialog = lb('[role="dialog"]')!;
    const title = document.getElementById(dialog.getAttribute("aria-labelledby") ?? "");
    expect(title?.textContent).toBe("간판-시안.webp");
  });

  it("uses the file name as the first line and prints no time when the row has no sender or time yet", () => {
    render([img("i1", "간판-시안.webp")]);
    openFirst();
    expect(lb('[data-testid="image-lightbox-info"]')?.textContent).toBe("간판-시안.webp");
    expect(lb('[data-testid="image-lightbox-sent-at"]')).toBeNull();
  });

  it("closes on a press of the empty stage but not on the picture, the chip or a control", () => {
    render([img("i1")], { senderName: "이도현", sentAtMs: SENT });
    openFirst();
    act(() => lb('[data-testid="image-lightbox-ready"] img')?.click());
    act(() => lb('[data-testid="image-lightbox-info"]')?.click());
    act(() => lb('[data-testid="attachment-download"]')?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    expect(lb('[data-testid="image-lightbox"]')).not.toBeNull();
    act(() => lb('[data-testid="image-lightbox-stage"]')?.click());
    expect(lb('[data-testid="image-lightbox"]')).toBeNull();
  });

  it("offers neighbours, the thumbnail strip and the N-of-M caption only for two or more pictures", () => {
    render([img("i1")]);
    openFirst();
    for (const id of ["previous", "next", "position", "thumbs"]) {
      expect(lb(`[data-testid="image-lightbox-${id}"]`), id).toBeNull();
    }
    act(() => lb('[data-testid="image-lightbox-close"]')?.click());

    render([img("i1"), img("i2"), img("i3")]);
    openFirst();
    expect(lb('[data-testid="image-lightbox-previous"]')).not.toBeNull();
    expect(lb('[data-testid="image-lightbox-next"]')).not.toBeNull();
    expect(lb('[data-testid="image-lightbox-position"]')?.textContent).toBe(lightboxPositionLabel(0, 3));
    const thumbs = () => [...document.body.querySelectorAll<HTMLElement>('[data-testid="image-lightbox-thumb"]')];
    expect(thumbs()).toHaveLength(3);
    expect(thumbs().map((t) => t.getAttribute("aria-current"))).toEqual(["true", null, null]);

    act(() => thumbs()[2].click());
    expect(lb('[data-testid="image-lightbox-position"]')?.textContent).toBe(lightboxPositionLabel(2, 3));
    expect(thumbs().map((t) => t.getAttribute("aria-current"))).toEqual([null, null, "true"]);

    key("ArrowRight");
    expect(lb('[data-testid="image-lightbox-position"]')?.textContent).toBe(lightboxPositionLabel(0, 3));
    act(() => lb('[data-testid="image-lightbox-previous"]')?.click());
    expect(lb('[data-testid="image-lightbox-position"]')?.textContent).toBe(lightboxPositionLabel(2, 3));
  });

  it("puts a failed download's banner in the stage on an opaque face, outside the top row of chips", async () => {
    // 위 줄(칩·버튼)에 끼우면 좁은 폭에서 폭이 눌리고, 유리 위에서는 위험 글자가 4.5:1 아래로 내려갔다(design-review #4751).
    render([img("i1")], { senderName: "이도현", sentAtMs: SENT });
    openFirst();
    act(() => lb('[data-testid="attachment-download"]')?.click());
    for (let turn = 0; turn < 50 && lb('[data-testid="image-lightbox-download-error"]') === null; turn += 1) {
      await act(async () => {
        await new Promise((done) => setTimeout(done, 0));
      });
    }
    const banner = lb('[data-testid="image-lightbox-download-error"]');
    expect(banner, "the failed download is told").not.toBeNull();
    expect(banner!.closest('[data-testid="image-lightbox-stage"]'), "in the stage flow").not.toBeNull();
    expect(banner!.closest(".lightbox-chrome"), "not squeezed into the top row").toBeNull();
    const face = banner!.parentElement!;
    expect(face.classList.contains("bg-surface-raised"), "opaque face").toBe(true);
    expect(face.classList.contains("glass"), "not translucent glass").toBe(false);
  });

  it("draws every control as a named icon button with a touch target and focuses close first", () => {
    render([img("i1"), img("i2")]);
    openFirst();
    for (const id of ["close", "previous", "next"]) {
      const button = lb(`[data-testid="image-lightbox-${id}"]`)!;
      expect(button.getAttribute("aria-label"), id).toBeTruthy();
      expect(button.textContent, `${id} has no text label`).toBe("");
      expect(button.classList.contains("tap-target"), id).toBe(true);
    }
    const download = lb('[data-testid="attachment-download"]')!;
    expect(download.getAttribute("aria-label")).toBeTruthy();
    expect(download.classList.contains("tap-target")).toBe(true);
    expect(document.activeElement).toBe(lb('[data-testid="image-lightbox-close"]'));
  });
});

// 이미지 미리보기 확대 (#4770).
//
// 재는 것 (되돌리면 실패해야 하는 것들):
//   1. 오므리기·벌리기(ctrl+휠)와 ⌘+스크롤은 커서 아래의 점을 지키며 확대하고, 브라우저의 쪽 확대를 막는다. 수식 키 없는 휠은 건드리지 않는다.
//   2. 두 번 클릭은 맞춤 ↔ 실제 크기(자연 크기의 100%, 무대보다 작은 사진은 2배)이고, 칩이 비율을 말한다.
//   3. 확대 중에는 빈 무대 클릭 닫기와 ←/→ 넘기기가 꺼지고, Esc는 맞춤으로, 맞춤에서의 Esc는 닫기다.
//   4. ⌘+ ⌘- ⌘0, 끌어서 이동(창 밖으로 못 나감), 다른 장으로 넘기거나 닫았다 열면 맞춤, 칩은 잠깐 머문다.
//   5. WebKit의 gesture* 핀치는 시작 대비 누적 배율이고, 같은 때 오는 ctrl 휠로 이중 확대하지 않는다.
describe("image lightbox zoom", () => {
  // jsdom에는 레이아웃이 없다(상자가 전부 0). 확대는 상자를 읽으므로 환경을 흉내 낸다: 뷰어 1000x700, 맞춤 사진이 한가운데에 서고,
  // 사진 상자의 현재 자리는 확대 코드가 꽂은 변환 변수에서 계산한다(브라우저가 하는 일). 시험 대상 코드는 건드리지 않는다.
  const VIEW = { w: 1000, h: 700 };
  const CENTER = { x: 500, y: 350 };
  const SENT = new Date(2026, 9, 29, 14, 43).getTime();
  let fit = { w: 600, h: 400 };
  let natural = { w: 1200, h: 800 };

  const rect = (left: number, top: number, width: number, height: number): DOMRect =>
    ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

  beforeEach(() => {
    fit = { w: 600, h: 400 };
    natural = { w: 1200, h: 800 };
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.matches('[data-testid="image-lightbox"]')) return rect(0, 0, VIEW.w, VIEW.h);
      if (this.matches('[data-testid="image-lightbox-ready"] img')) {
        const zoom = Number(this.style.getPropertyValue("--lightbox-zoom") || "1");
        const panX = parseFloat(this.style.getPropertyValue("--lightbox-pan-x") || "0");
        const panY = parseFloat(this.style.getPropertyValue("--lightbox-pan-y") || "0");
        const width = fit.w * zoom;
        const height = fit.h * zoom;
        return rect(CENTER.x + panX - width / 2, CENTER.y + panY - height / 2, width, height);
      }
      return rect(0, 0, 0, 0);
    });
    Object.defineProperty(HTMLImageElement.prototype, "offsetWidth", { configurable: true, get: () => fit.w });
    Object.defineProperty(HTMLImageElement.prototype, "offsetHeight", { configurable: true, get: () => fit.h });
    Object.defineProperty(HTMLImageElement.prototype, "naturalWidth", { configurable: true, get: () => natural.w });
    Object.defineProperty(HTMLImageElement.prototype, "naturalHeight", { configurable: true, get: () => natural.h });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    for (const name of ["offsetWidth", "offsetHeight", "naturalWidth", "naturalHeight"]) {
      Reflect.deleteProperty(HTMLImageElement.prototype, name);
    }
  });

  const lb = (sel: string) => document.body.querySelector<HTMLElement>(sel);
  const photo = () => lb('[data-testid="image-lightbox-ready"] img')!;
  const chip = () => lb('[data-testid="image-lightbox-zoom"]');
  const zoomOf = () => Number(photo().style.getPropertyValue("--lightbox-zoom"));
  const panOf = () => ({
    x: parseFloat(photo().style.getPropertyValue("--lightbox-pan-x")),
    y: parseFloat(photo().style.getPropertyValue("--lightbox-pan-y")),
  });
  const isZoomed = () => photo().hasAttribute("data-zoomed");
  const open = (count = 1) => {
    render(Array.from({ length: count }, (_, index) => img(`i${index + 1}`)), {
      senderName: "이도현",
      sentAtMs: SENT,
    });
    act(() => {
      q('[data-testid="attachment-image"] button')?.click();
    });
  };
  const fire = (target: Element | null, event: Event) => {
    act(() => {
      target?.dispatchEvent(event);
    });
    return event;
  };
  const wheel = (init: WheelEventInit) =>
    fire(photo(), new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init }));
  const doubleClick = (x = CENTER.x, y = CENTER.y) =>
    fire(photo(), new MouseEvent("dblclick", { bubbles: true, cancelable: true, clientX: x, clientY: y }));
  const press = (init: KeyboardEventInit) =>
    fire(lb('[data-testid="image-lightbox"]'), new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
  const pointer = (type: string, x: number, y: number) =>
    fire(photo(), new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }));
  /** 뷰어 좌표 `at` 아래에 있는 사진의 점(사진 중심 기준, 맞춤 픽셀). */
  const pointUnder = (at: { x: number; y: number }) => ({
    x: (at.x - CENTER.x - panOf().x) / zoomOf(),
    y: (at.y - CENTER.y - panOf().y) / zoomOf(),
  });
  const position = () => lb('[data-testid="image-lightbox-position"]')?.textContent;

  it("zooms around the cursor on a pinch (ctrl+wheel) and on command+scroll, and stops the browser from zooming the page", () => {
    open();
    expect(zoomOf()).toBe(1);
    // 사진이 창보다 작은 동안은 가운데에 머문다(아래 모델 시험). 창을 넘긴 뒤(2배)부터 커서가 중심이다.
    doubleClick();
    expect(zoomOf()).toBe(2);
    const at = { x: 620, y: 400 };
    const before = pointUnder(at);

    const pinch = wheel({ ctrlKey: true, deltaY: -10, clientX: at.x, clientY: at.y });
    expect(pinch.defaultPrevented, "the page must not zoom too").toBe(true);
    expect(zoomOf()).toBeGreaterThan(1);
    expect(isZoomed()).toBe(true);
    expect(pointUnder(at).x).toBeCloseTo(before.x, 6);
    expect(pointUnder(at).y).toBeCloseTo(before.y, 6);
    expect(chip()?.textContent).toBe(lightboxZoomLabel(zoomOf(), 0.5));

    const afterPinch = zoomOf();
    const scroll = wheel({ metaKey: true, deltaY: -10, clientX: at.x, clientY: at.y });
    expect(scroll.defaultPrevented).toBe(true);
    expect(zoomOf()).toBeGreaterThan(afterPinch);
    expect(pointUnder(at).x).toBeCloseTo(before.x, 6);
    expect(pointUnder(at).y).toBeCloseTo(before.y, 6);

    // 오므리면 줄고, 맞춤 아래로는 내려가지 않는다.
    for (let turn = 0; turn < 40; turn += 1) wheel({ ctrlKey: true, deltaY: 20, clientX: at.x, clientY: at.y });
    expect(zoomOf()).toBe(1);
    expect(isZoomed()).toBe(false);
    expect(panOf()).toEqual({ x: 0, y: 0 });
  });

  it("zooms no further than four times fit, and leaves a wheel with no modifier key alone", () => {
    open();
    // (수식 키 없는 휠이 `defaultPrevented`인 것은 Radix의 스크롤 잠금 때문이다: 뒤의 앱이 스크롤되지 않는다. 확대와는 무관하다.)
    wheel({ deltaY: -50, clientX: 500, clientY: 350 });
    expect(zoomOf()).toBe(1);
    expect(isZoomed()).toBe(false);
    expect(chip()).toBeNull();

    for (let turn = 0; turn < 80; turn += 1) wheel({ ctrlKey: true, deltaY: -30, clientX: 500, clientY: 350 });
    expect(zoomOf()).toBe(4);
    expect(chip()?.textContent).toBe(lightboxZoomLabel(4, 0.5));
  });

  it("toggles between fit and the picture's actual size on a double click, and names the ratio on the chip", () => {
    open();
    // 맞춤이 자연 크기의 50%(600/1200): 실제 크기는 맞춤의 2배, 커서(560, 380)가 중심이다.
    doubleClick(560, 380);
    expect(zoomOf()).toBe(2);
    expect(chip()?.textContent).toBe("100%");
    expect(panOf()).toEqual({ x: -60, y: -30 });
    expect(isZoomed()).toBe(true);

    doubleClick();
    expect(zoomOf()).toBe(1);
    expect(isZoomed()).toBe(false);
    expect(chip()?.textContent).toBe("맞춤");
    expect(panOf()).toEqual({ x: 0, y: 0 });
  });

  it("goes to twice fit on a double click when the picture is smaller than the stage", () => {
    fit = { w: 300, h: 200 };
    natural = { w: 300, h: 200 };
    open();
    doubleClick();
    expect(zoomOf()).toBe(2);
    expect(chip()?.textContent).toBe("200%");
  });

  it("turns off outside-click closing and the arrow keys while zoomed, and Escape steps back to fit before it closes", () => {
    open(3);
    expect(position()).toBe(lightboxPositionLabel(0, 3));
    doubleClick();
    expect(isZoomed()).toBe(true);

    press({ key: "ArrowRight" });
    expect(position(), "arrow keys do not turn the page while zoomed").toBe(lightboxPositionLabel(0, 3));
    act(() => lb('[data-testid="image-lightbox-stage"]')?.click());
    expect(lb('[data-testid="image-lightbox"]'), "an empty-stage click does not close while zoomed").not.toBeNull();

    press({ key: "Escape" });
    expect(lb('[data-testid="image-lightbox"]'), "Escape only steps back to fit").not.toBeNull();
    expect(isZoomed()).toBe(false);
    expect(chip()?.textContent).toBe("맞춤");

    press({ key: "ArrowRight" });
    expect(position(), "back at fit, the arrow keys turn the page again").toBe(lightboxPositionLabel(1, 3));
    press({ key: "Escape" });
    expect(lb('[data-testid="image-lightbox"]'), "Escape at fit closes").toBeNull();
  });

  it("closes on an empty-stage click again once back at fit", () => {
    open();
    doubleClick();
    doubleClick();
    expect(isZoomed()).toBe(false);
    act(() => lb('[data-testid="image-lightbox-stage"]')?.click());
    expect(lb('[data-testid="image-lightbox"]')).toBeNull();
  });

  it("zooms with command plus, minus and zero, keeping the browser from zooming the page", () => {
    open();
    const plus = press({ key: "=", code: "Equal", metaKey: true });
    expect(plus.defaultPrevented).toBe(true);
    expect(zoomOf()).toBeCloseTo(1.25, 6);
    press({ key: "+", code: "Equal", metaKey: true, shiftKey: true });
    expect(zoomOf()).toBeCloseTo(1.5625, 6);
    expect(chip()?.textContent).toBe(lightboxZoomLabel(zoomOf(), 0.5));
    press({ key: "-", code: "Minus", metaKey: true });
    expect(zoomOf()).toBeCloseTo(1.25, 6);
    const fitKey = press({ key: "0", code: "Digit0", metaKey: true });
    expect(fitKey.defaultPrevented).toBe(true);
    expect(zoomOf()).toBe(1);
    expect(isZoomed()).toBe(false);
    expect(chip()?.textContent).toBe("맞춤");

    // 수식 키 없는 「=」는 그냥 글자다.
    const bare = press({ key: "=", code: "Equal" });
    expect(bare.defaultPrevented).toBe(false);
    expect(zoomOf()).toBe(1);
  });

  it("drags the zoomed picture with the pointer and never past the window edge", () => {
    open();
    doubleClick();
    expect(zoomOf()).toBe(2);
    expect(photo().hasAttribute("data-dragging")).toBe(false);

    pointer("pointerdown", 500, 350);
    expect(photo().hasAttribute("data-dragging")).toBe(true);
    pointer("pointermove", 450, 330);
    expect(panOf()).toEqual({ x: -50, y: -20 });
    // 2배의 사진(1200x800)은 창(1000x700)을 가로 ±100, 세로 ±50만큼만 벗어날 수 있다.
    pointer("pointermove", -4000, -4000);
    expect(panOf()).toEqual({ x: -100, y: -50 });
    pointer("pointermove", 9000, 9000);
    expect(panOf()).toEqual({ x: 100, y: 50 });
    pointer("pointerup", 9000, 9000);
    expect(photo().hasAttribute("data-dragging")).toBe(false);
    pointer("pointermove", 0, 0);
    expect(panOf(), "no longer dragging after the pointer is up").toEqual({ x: 100, y: 50 });
    expect(zoomOf()).toBe(2);
  });

  it("does not start a drag from fit", () => {
    open();
    pointer("pointerdown", 500, 350);
    pointer("pointermove", 300, 300);
    expect(photo().hasAttribute("data-dragging")).toBe(false);
    expect(panOf()).toEqual({ x: 0, y: 0 });
  });

  it("returns to fit when another picture is opened, by thumbnail, by the next button, and on reopening", () => {
    open(3);
    doubleClick();
    expect(isZoomed()).toBe(true);
    const thumbs = [...document.body.querySelectorAll<HTMLElement>('[data-testid="image-lightbox-thumb"]')];
    act(() => thumbs[2].click());
    expect(position()).toBe(lightboxPositionLabel(2, 3));
    expect(isZoomed()).toBe(false);
    expect(zoomOf()).toBe(1);
    expect(chip()).toBeNull();

    doubleClick();
    expect(isZoomed()).toBe(true);
    act(() => lb('[data-testid="image-lightbox-next"]')?.click());
    expect(position()).toBe(lightboxPositionLabel(0, 3));
    expect(isZoomed()).toBe(false);

    doubleClick();
    act(() => lb('[data-testid="image-lightbox-close"]')?.click());
    expect(lb('[data-testid="image-lightbox"]')).toBeNull();
    act(() => {
      q('[data-testid="attachment-image"] button')?.click();
    });
    expect(isZoomed()).toBe(false);
    expect(zoomOf()).toBe(1);
  });

  it("shows the ratio chip for a moment after the last change and then takes it away", () => {
    open();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    doubleClick();
    expect(chip()).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(ZOOM_CHIP_LINGER_MS - 1);
    });
    expect(chip(), "still showing just before the linger runs out").not.toBeNull();
    // 새 확대가 머무는 시간을 다시 시작한다.
    wheel({ ctrlKey: true, deltaY: -10, clientX: 500, clientY: 350 });
    act(() => {
      vi.advanceTimersByTime(ZOOM_CHIP_LINGER_MS - 1);
    });
    expect(chip()).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(chip()).toBeNull();
    expect(isZoomed(), "the zoom itself stays").toBe(true);
  });

  it("follows a WebKit pinch by its cumulative scale and ignores the ctrl wheel that may arrive with it", () => {
    open();
    const gesture = (type: string, extra: Record<string, number> = {}) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.assign(event, extra);
      return fire(photo(), event);
    };
    expect(gesture("gesturestart").defaultPrevented).toBe(true);
    const at = { clientX: 560, clientY: 380 };
    const before = pointUnder({ x: at.clientX, y: at.clientY });
    expect(gesture("gesturechange", { scale: 2, ...at }).defaultPrevented).toBe(true);
    expect(zoomOf()).toBe(2);
    expect(pointUnder({ x: at.clientX, y: at.clientY }).x).toBeCloseTo(before.x, 6);
    // 누적값: 시작 대비 3배면 지금 2배의 3배(6)가 아니라 3이다.
    gesture("gesturechange", { scale: 3, ...at });
    expect(zoomOf()).toBe(3);
    const stray = wheel({ ctrlKey: true, deltaY: -20, clientX: 560, clientY: 380 });
    expect(stray.defaultPrevented).toBe(true);
    expect(zoomOf(), "no double zoom while a gesture is running").toBe(3);
    gesture("gestureend");
    wheel({ ctrlKey: true, deltaY: 20, clientX: 560, clientY: 380 });
    expect(zoomOf()).toBeLessThan(3);
  });
});

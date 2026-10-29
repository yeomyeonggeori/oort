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
const { lightboxPositionLabel, lightboxSentAtLabel } = await import("./imageLightboxModel");

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

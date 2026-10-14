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

function render(attachments: Parameters<typeof AttachmentList>[0]["attachments"]) {
  act(() => {
    root.render(<AttachmentList channelId="ch" attachments={attachments} />);
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
    ).toBe("2 / 3");
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
});

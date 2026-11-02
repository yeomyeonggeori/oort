// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 대화 안 이미지 카드의 배선 (#5189). 크기 규칙의 숫자는 `inlineImageModel.test.ts` 가 재고,
// 여기서는 그 규칙이 **화면에 닿는 길**을 잰다: 디코드된 자연 크기가 상자 속성이 되고, 모서리가
// 알약 반경(고정 `rounded-md`)이 아니라 `image-corner` 이며, 낮은 그림의 호버 줄이 가운데에
// 서고, 한 번 안 크기를 행이 다시 마운트돼도 기억한다. 실제 렌더 기하(반경이 몇 px 로 풀리는가,
// 열이 좁을 때 줄어드는가)는 jsdom 이 못 보므로 `gates/gate-image-card.mjs` 가 Chromium·WebKit
// 에서 잰다.

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

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const png = (id: string) => ({
  id,
  name: "terminal.png",
  mime: "image/png",
  sizeBytes: 9_400,
});

let host: HTMLDivElement;
let root: Root;

function render(attachments: ReturnType<typeof png>[]) {
  act(() => {
    root.render(<AttachmentList channelId="ch" attachments={attachments} />);
  });
}

const q = (selector: string, from: ParentNode = host) => from.querySelector<HTMLElement>(selector);
const figure = () => q('[data-testid="attachment-image"]') as HTMLElement;
const picture = () => q('[data-testid="attachment-image"] img') as HTMLImageElement;
const clip = () => q('[data-testid="attachment-image"] button') as HTMLButtonElement;

/** 브라우저가 디코드를 마친 순간: 자연 크기가 생기고 `load` 가 뜬다. */
function decoded(node: HTMLImageElement, width: number, height: number) {
  Object.defineProperty(node, "naturalWidth", { configurable: true, value: width });
  Object.defineProperty(node, "naturalHeight", { configurable: true, value: height });
  act(() => {
    node.dispatchEvent(new Event("load"));
  });
}

const hover = (el: Element | null) =>
  act(() => {
    el?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
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

describe("inline image card wiring", () => {
  it("draws the old standard box until the natural size is known, with the image corner", () => {
    render([png("wire-unknown")]);
    expect(figure().hasAttribute("data-wide")).toBe(false);
    expect(picture().hasAttribute("width")).toBe(false);
    expect(picture().hasAttribute("height")).toBe(false);
    expect(picture().className).toContain("max-h-inline-image-h");
    expect(picture().className).toContain("max-w-inline-image-w");
    // 모서리: 고정 반경이 아니라 높이를 따라가는 이미지 모서리다. 클립 틀도 같다.
    for (const node of [picture(), clip()]) {
      expect(node.className).toContain("image-corner");
      expect(node.className).not.toMatch(/\brounded-/);
    }
  });

  it("turns the decoded natural size into the rule's box (wide caption)", () => {
    render([png("wire-wide")]);
    decoded(picture(), 2072, 110);
    expect(figure().hasAttribute("data-wide")).toBe(true);
    expect(picture().getAttribute("width")).toBe("1036");
    expect(picture().getAttribute("height")).toBe("55");
    // 열이 좁으면 비율대로 줄어들어야 하므로 높이는 auto, 폭은 열을 넘지 않는다.
    expect(picture().className).toContain("h-auto");
    expect(picture().className).toContain("max-w-full");
    expect(picture().className).not.toContain("max-w-inline-image-w");
    expect(picture().className).toContain("image-corner");
    expect(figure().hasAttribute("data-compact")).toBe(false);
  });

  it("gives tall, large and small images the standard box numbers", () => {
    const cases: Array<[string, number, number, string, string]> = [
      ["wire-tall", 600, 2400, "80", "320"],
      ["wire-large", 3200, 2400, "360", "270"],
      ["wire-small", 240, 160, "240", "160"],
    ];
    for (const [id, w, h, shownW, shownH] of cases) {
      render([png(id)]);
      decoded(picture(), w, h);
      expect(figure().hasAttribute("data-wide"), id).toBe(false);
      expect(picture().getAttribute("width"), id).toBe(shownW);
      expect(picture().getAttribute("height"), id).toBe(shownH);
    }
  });

  it("keeps the hover actions inside a thin picture and at the top of a taller one", () => {
    render([png("wire-thin")]);
    decoded(picture(), 1200, 60);
    expect(picture().getAttribute("height")).toBe("30");
    expect(figure().hasAttribute("data-compact")).toBe(true);
    hover(figure());
    const thin = q('[data-testid="attachment-image-actions"]', figure());
    expect(thin?.className).toContain("top-1/2");
    expect(thin?.className).toContain("-translate-y-1/2");
    expect(thin?.className).not.toMatch(/\btop-2\b/);

    render([png("wire-strip")]);
    decoded(picture(), 2072, 110);
    hover(figure());
    const strip = q('[data-testid="attachment-image-actions"]', figure());
    expect(strip?.className).toMatch(/\btop-2\b/);
    expect(strip?.className).not.toContain("top-1/2");
  });

  it("remembers the natural size, so a remounted row starts at its final box", () => {
    render([png("wire-remember")]);
    decoded(picture(), 1500, 600);
    expect(picture().getAttribute("width")).toBe("450");
    act(() => root.unmount());
    root = createRoot(host);
    render([png("wire-remember")]);
    // 디코드(`load`)를 기다리지 않는다: 첫 렌더가 이미 제 크기다.
    expect(figure().hasAttribute("data-wide")).toBe(true);
    expect(picture().getAttribute("width")).toBe("450");
    expect(picture().getAttribute("height")).toBe("180");
  });

  it("does not trust a natural size of zero", () => {
    render([png("wire-zero")]);
    decoded(picture(), 0, 0);
    expect(figure().hasAttribute("data-wide")).toBe(false);
    expect(picture().hasAttribute("width")).toBe(false);
  });

  it("leaves grid tiles square and cropped, with the same corner", () => {
    render([png("wire-g1"), png("wire-g2")]);
    const tiles = host.querySelectorAll<HTMLImageElement>('[data-testid="attachment-image"] img');
    expect(tiles).toHaveLength(2);
    for (const tile of tiles) {
      decoded(tile, 2072, 110);
      expect(tile.hasAttribute("width")).toBe(false);
      expect(tile.className).toContain("object-cover");
      expect(tile.className).toContain("image-corner");
      expect(tile.className).not.toMatch(/\brounded-/);
    }
    expect(q('[data-testid="attachment-image"][data-wide]')).toBeNull();
  });
});

// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { CustomStatusMark } from "./CustomStatusMark";

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let mountedRoot: Root | null = null;
let mountedHost: HTMLElement | null = null;

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  mountedHost?.remove();
  mountedHost = null;
});

function mountMark(
  status: { emoji?: string; text?: string },
  extra: { emojiOnly?: boolean; wrap?: boolean } = {}
) {
  const host = document.createElement("div");
  document.body.append(host);
  mountedHost = host;
  mountedRoot = createRoot(host);
  act(() => {
    mountedRoot?.render(
      createElement(CustomStatusMark, { status, ...extra })
    );
  });
}

describe("CustomStatusMark a11y (#1889 M-2)", () => {
  it("hides the emoji when text is the accessible fact", () => {
    mountMark({ emoji: "📅", text: "회의 중" });
    const emoji = document.querySelector('[data-testid="custom-status-emoji"]');
    expect(emoji?.getAttribute("aria-hidden")).toBe("true");
  });

  it("leaves an emoji-only status in the accessibility tree", () => {
    mountMark({ emoji: "🤒" });
    const emoji = document.querySelector('[data-testid="custom-status-emoji"]');
    expect(emoji?.textContent).toBe("🤒");
    expect(emoji?.getAttribute("aria-hidden")).toBeNull();
  });

  it("draws a quiet bubble when the card has text and no emoji (#1889 R2-M2)", () => {
    mountMark({ text: "고객사 미팅" }, { emojiOnly: true });
    const glyph = document.querySelector('[data-testid="custom-status-glyph"]');
    expect(glyph).not.toBeNull();
    expect(glyph?.getAttribute("aria-hidden")).toBe("true");
    expect(document.querySelector('[data-testid="custom-status-emoji"]')).toBeNull();
    expect(document.querySelector('[data-testid="custom-status-text"]')).toBeNull();
  });
});

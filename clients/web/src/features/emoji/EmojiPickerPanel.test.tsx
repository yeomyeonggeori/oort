// @vitest-environment jsdom

import { act, createElement, useRef, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogEmoji } from "./catalog";
import { EmojiPickerPanel } from "./EmojiPickerPanel";
import { EMOJI_GRID_RENDER_LIMIT } from "./gridWindow";
import { resetEmojiFrequencyForTests } from "./frequencyStore";
import { resetEmojiSkinToneForTests } from "./skinToneStore";

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let mountedRoot: Root | null = null;
const memory = new Map<string, string>();

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  HTMLElement.prototype.scrollIntoView = () => undefined;
  if (typeof globalThis.PointerEvent === "undefined") {
    globalThis.PointerEvent = class PointerEvent extends MouseEvent {
      constructor(type: string, init?: MouseEventInit) {
        super(type, init);
      }
    } as unknown as typeof PointerEvent;
  }
});

beforeEach(() => {
  memory.clear();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => void memory.set(key, value),
    removeItem: (key: string) => void memory.delete(key),
  });
  resetEmojiFrequencyForTests();
  resetEmojiSkinToneForTests();
});

afterEach(() => {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

afterAll(() => {
  delete reactActEnvironment.IS_REACT_ACT_ENVIRONMENT;
});

function entry(index: number, name = `smile ${index}`): CatalogEmoji {
  return {
    glyph: String.fromCodePoint(0x1f600 + index),
    name,
    shortcodes: [`smile${index}`],
    keywords: ["smile"],
    category: "people",
  };
}

function mount(node: ReactElement): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  mountedRoot = createRoot(host);
  act(() => mountedRoot?.render(node));
  return host;
}

function PanelHarness({
  entries,
  seed = ["😀"],
  autoFocusSearch,
  error = false,
  skinStart = false,
  onShellEscape,
}: {
  entries: CatalogEmoji[];
  seed?: readonly string[];
  autoFocusSearch?: boolean;
  error?: boolean;
  skinStart?: boolean;
  onShellEscape?: () => void;
}) {
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [skinOpen, setSkinOpen] = useState(skinStart);
  const [shellOpen, setShellOpen] = useState(true);
  return createElement(
    "div",
    {
      "data-testid": "picker-shell",
      "data-shell-open": shellOpen ? "true" : "false",
      onKeyDown: (event: { key: string; preventDefault: () => void }) => {
        if (event.key !== "Escape") return;
        // Same contract as EmojiPickerDialog onEscapeKeyDown: preventDefault
        // keeps the Radix layer from dismissing, and only the skin list closes.
        if (skinOpen) {
          event.preventDefault();
          setSkinOpen(false);
          return;
        }
        onShellEscape?.();
        setShellOpen(false);
      },
    },
    shellOpen
      ? createElement(EmojiPickerPanel, {
          itemPrefix: "picker-test",
          entries,
          loading: false,
          error,
          onRetry: () => undefined,
          onPick: () => undefined,
          seed,
          searchRef,
          skinOpen,
          onSkinOpenChange: setSkinOpen,
          autoFocusSearch,
        })
      : null
  );
}

function setSearchValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  act(() => {
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("EmojiPickerPanel cursor (B-1 / H-1)", () => {
  const catalog = Array.from({ length: 20 }, (_, i) => entry(i));

  it("keeps the keyboard cursor when a stationary pointer sits on a cell", () => {
    const host = mount(createElement(PanelHarness, { entries: catalog }));
    const search = host.querySelector<HTMLInputElement>('[data-testid="emoji-search"]')!;
    setSearchValue(search, "smile");
    const options = [...host.querySelectorAll<HTMLElement>('[role="option"]')];
    expect(options.length).toBeGreaterThan(3);
    act(() => {
      options[5].dispatchEvent(
        new MouseEvent("mouseenter", { bubbles: true, clientX: 40, clientY: 40 })
      );
    });
    act(() => {
      search.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })
      );
    });
    expect(search.getAttribute("aria-activedescendant")).toMatch(/-1$/);
    const active = host.querySelector('[role="option"][aria-selected="true"]');
    expect(active?.className).toContain("bg-accent-soft");
  });

  it("moves the cursor only when the pointer actually moves", () => {
    const host = mount(createElement(PanelHarness, { entries: catalog }));
    const search = host.querySelector<HTMLInputElement>('[data-testid="emoji-search"]')!;
    setSearchValue(search, "smile");
    const options = [...host.querySelectorAll<HTMLElement>('[role="option"]')];
    act(() => {
      options[4].dispatchEvent(
        new PointerEvent("pointermove", { bubbles: true, clientX: 12, clientY: 24 })
      );
    });
    expect(search.getAttribute("aria-activedescendant")).toMatch(/-4$/);
  });
});

describe("EmojiPickerPanel windowing (H-2)", () => {
  it("does not mount the whole catalog for a long search", () => {
    const catalog = Array.from({ length: 200 }, (_, i) =>
      entry(i, `item ${i}`)
    );
    const host = mount(createElement(PanelHarness, { entries: catalog }));
    const search = host.querySelector<HTMLInputElement>('[data-testid="emoji-search"]')!;
    setSearchValue(search, "item");
    expect(host.querySelectorAll("[data-emoji-cell]").length).toBeLessThanOrEqual(
      EMOJI_GRID_RENDER_LIMIT
    );
    expect(host.querySelectorAll("[data-emoji-cell]").length).toBeGreaterThan(0);
  });

  it("keeps category tabs for a lone colon instead of dumping the catalog", () => {
    const catalog = Array.from({ length: 200 }, (_, i) => entry(i, `item ${i}`));
    const host = mount(
      createElement(PanelHarness, { entries: catalog, seed: [catalog[0].glyph] })
    );
    const search = host.querySelector<HTMLInputElement>('[data-testid="emoji-search"]')!;
    setSearchValue(search, ":");
    expect(host.querySelector('[role="tablist"]')).not.toBeNull();
    expect(host.querySelectorAll("[data-emoji-cell]").length).toBeLessThanOrEqual(
      EMOJI_GRID_RENDER_LIMIT
    );
    expect(host.querySelector('[role="listbox"]')).toBeNull();
  });
});

describe("EmojiPickerPanel Esc layer (H-3)", () => {
  it("closes only the skin list on the first Escape", () => {
    const onShellEscape = vi.fn();
    const host = mount(
      createElement(PanelHarness, {
        entries: [entry(0)],
        skinStart: true,
        onShellEscape,
      })
    );
    expect(host.querySelector('[data-testid="emoji-skin-0"]')).not.toBeNull();
    act(() => {
      host.querySelector('[data-testid="picker-shell"]')!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
      );
    });
    expect(host.querySelector('[data-testid="emoji-skin-0"]')).toBeNull();
    expect(host.querySelector('[data-testid="picker-shell"]')?.getAttribute("data-shell-open")).toBe(
      "true"
    );
    expect(onShellEscape).not.toHaveBeenCalled();
  });
});

describe("EmojiPickerPanel autofocus (H-5)", () => {
  const catalog = [entry(0)];

  it("focuses search on a fine pointer", () => {
    const host = mount(
      createElement(PanelHarness, { entries: catalog, autoFocusSearch: true })
    );
    expect(host.querySelector('[data-testid="emoji-search"]')).toBe(
      document.activeElement
    );
  });

  it("does not autofocus search on a coarse pointer sheet", () => {
    const host = mount(
      createElement(PanelHarness, { entries: catalog, autoFocusSearch: false })
    );
    expect(host.querySelector('[data-testid="emoji-search"]')).not.toBe(
      document.activeElement
    );
  });
});

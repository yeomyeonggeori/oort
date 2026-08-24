// @vitest-environment jsdom

import { act, createElement, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageActionAvailability } from "@momo/core/features/timeline/model";
import {
  frequentEmojis,
  recordEmojiUse,
  resetEmojiFrequencyForTests,
} from "@/features/emoji/frequencyStore";
import {
  MessageHoverToolbar,
  type MessageActionCallbacks,
} from "./MessageActions";
import {
  countToolbarTabStops,
  HOVER_TOOLBAR_REACTION_SEED,
  HOVER_TOOLBAR_SLOT_COUNT,
  shouldShowHoverToolbar,
} from "./hoverToolbarModel";
import { useRowRovingFocus } from "./rowFocus";

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let offsetParentDescriptor: PropertyDescriptor | undefined;
let mountedRoot: Root | null = null;
const memory = new Map<string, string>();

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  offsetParentDescriptor = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "offsetParent"
  );
  Object.defineProperty(HTMLElement.prototype, "offsetParent", {
    configurable: true,
    get() {
      return this.parentElement;
    },
  });
});

beforeEach(() => {
  memory.clear();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => void memory.set(key, value),
    removeItem: (key: string) => void memory.delete(key),
  });
  resetEmojiFrequencyForTests();
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
  if (offsetParentDescriptor) {
    Object.defineProperty(
      HTMLElement.prototype,
      "offsetParent",
      offsetParentDescriptor
    );
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, "offsetParent");
  }
  delete reactActEnvironment.IS_REACT_ACT_ENVIRONMENT;
});

const available: MessageActionAvailability = {
  reply: true,
  quote: true,
  react: true,
  pin: true,
  edit: true,
  delete: true,
};

const callbacks: MessageActionCallbacks = {
  onReply: () => undefined,
  onQuote: () => undefined,
  onCopy: () => undefined,
  onReact: () => undefined,
  onPin: () => undefined,
  onEdit: () => undefined,
  onDelete: () => undefined,
};

function mountToolbar(open = true): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  mountedRoot = createRoot(host);
  function Harness() {
    const [menuOpen, setMenuOpen] = useState(false);
    if (!open) return createElement("article", { "data-testid": "row" });
    return createElement(MessageHoverToolbar, {
      available,
      canCopy: true,
      copied: false,
      pinned: false,
      callbacks,
      onOpenPicker: () => undefined,
      menuOpen,
      onMenuOpenChange: setMenuOpen,
      mineEmojis: new Set<string>(),
    });
  }
  act(() => mountedRoot?.render(createElement(Harness)));
  return host;
}

function TimelineHarness({
  hovered,
  focused,
}: {
  hovered: number | null;
  focused: number | null;
}) {
  return createElement(
    "div",
    { "data-testid": "timeline" },
    Array.from({ length: 20 }, (_, index) =>
      createElement(Row, { key: index, index, hovered, focused })
    )
  );
}

function Row({
  index,
  hovered,
  focused,
}: {
  index: number;
  hovered: number | null;
  focused: number | null;
}) {
  const ref = useRef<HTMLElement | null>(null);
  const onKeyDown = useRowRovingFocus(ref);
  const show = shouldShowHoverToolbar({
    pointerCanHover: true,
    editing: false,
    rowHovered: hovered === index,
    rowFocused: focused === index,
    overlayOpen: false,
    selecting: false,
  });
  return createElement(
    "article",
    {
      ref,
      onKeyDown,
      "data-testid": "timeline-message",
      "data-seq": String(index),
    },
    createElement("button", {
      "data-row-action": "",
      "data-testid": `chip-${index}`,
    }),
    show
      ? createElement(MessageHoverToolbar, {
          available,
          canCopy: true,
          copied: false,
          pinned: false,
          callbacks,
          onOpenPicker: () => undefined,
          menuOpen: false,
          onMenuOpenChange: () => undefined,
          mineEmojis: new Set<string>(),
        })
      : null
  );
}

function mountTimeline(hovered: number | null, focused: number | null): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  mountedRoot = createRoot(host);
  act(() =>
    mountedRoot?.render(createElement(TimelineHarness, { hovered, focused }))
  );
  return host;
}

describe("MessageHoverToolbar", () => {
  it("시드 슬롯 3 + React + 답글 + ⋯ 를 그린다", () => {
    const host = mountToolbar();
    const bar = host.querySelector('[data-testid="message-hover-toolbar"]');
    expect(bar).not.toBeNull();
    expect(bar?.getAttribute("role")).toBe("toolbar");
    for (const emoji of HOVER_TOOLBAR_REACTION_SEED) {
      expect(
        host.querySelector(`[data-testid="toolbar-react-${emoji}"]`)
      ).not.toBeNull();
    }
    expect(host.querySelector('[data-testid="toolbar-react-more"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="toolbar-reply"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="message-actions-trigger"]')).not.toBeNull();
  });

  it("슬롯은 빈도 store 순서를 따른다", () => {
    recordEmojiUse("🎉");
    recordEmojiUse("🎉");
    recordEmojiUse("👀");
    const ranked = frequentEmojis(
      HOVER_TOOLBAR_SLOT_COUNT,
      HOVER_TOOLBAR_REACTION_SEED
    );
    expect(ranked[0]).toBe("🎉");
    const host = mountToolbar();
    const slots = Array.from(
      host.querySelectorAll<HTMLElement>('[data-testid^="toolbar-react-"]')
    ).filter((el) => el.dataset.testid !== "toolbar-react-more");
    expect(slots.map((el) => el.textContent)).toEqual(ranked);
  });

  it("호버로 마운트해도 포커스를 훔치지 않는다", () => {
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();
    expect(document.activeElement).toBe(outside);
    mountToolbar();
    expect(document.activeElement).toBe(outside);
  });
});

describe("가상화 타임라인 탭스톱 불변 (red proof)", () => {
  it("비호버 20행은 툴바 DOM 이 0 이고 행당 탭스톱은 칩 하나다", async () => {
    const host = mountTimeline(null, null);
    expect(host.querySelectorAll('[data-testid="message-hover-toolbar"]')).toHaveLength(
      0
    );
    await vi.waitFor(() => {
      const rows = host.querySelectorAll('[data-testid="timeline-message"]');
      expect(rows).toHaveLength(20);
      for (const row of rows) {
        const stops = Array.from(
          row.querySelectorAll<HTMLElement>("[data-row-action]")
        ).filter((el) => el.tabIndex >= 0);
        expect(stops).toHaveLength(1);
        expect(countToolbarTabStops(row)).toBe(0);
      }
    });
  });

  it("호버된 한 행만 툴바를 마운트하고 그 행의 탭스톱은 여전히 1이다", async () => {
    const host = mountTimeline(7, null);
    const toolbars = host.querySelectorAll('[data-testid="message-hover-toolbar"]');
    expect(toolbars).toHaveLength(1);
    const hovered = host.querySelector('[data-seq="7"]')!;
    expect(hovered.contains(toolbars[0])).toBe(true);
    await vi.waitFor(() => {
      const stops = Array.from(
        hovered.querySelectorAll<HTMLElement>("[data-row-action]")
      ).filter((el) => el.tabIndex >= 0);
      expect(stops).toHaveLength(1);
      expect(countToolbarTabStops(hovered)).toBeLessThanOrEqual(1);
    });
    const others = host.querySelectorAll(
      '[data-testid="timeline-message"]:not([data-seq="7"])'
    );
    for (const row of others) {
      expect(row.querySelector('[data-testid="message-hover-toolbar"]')).toBeNull();
    }
  });

  it("툴바 안에서 ←/→ 는 슬롯을 돌고 행 로빙으로 새지 않는다", async () => {
    const host = mountTimeline(0, 0);
    const row = host.querySelector('[data-seq="0"]') as HTMLElement;
    const firstSlot = row.querySelector<HTMLButtonElement>(
      `[data-testid="toolbar-react-${HOVER_TOOLBAR_REACTION_SEED[0]}"]`
    )!;
    const secondSlot = row.querySelector<HTMLButtonElement>(
      `[data-testid="toolbar-react-${HOVER_TOOLBAR_REACTION_SEED[1]}"]`
    )!;
    await vi.waitFor(() => expect(firstSlot.offsetParent).not.toBeNull());
    firstSlot.tabIndex = 0;
    secondSlot.tabIndex = -1;
    firstSlot.focus();
    act(() => {
      firstSlot.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowRight",
          bubbles: true,
          cancelable: true,
        })
      );
    });
    expect(document.activeElement).toBe(secondSlot);
    expect(secondSlot.tabIndex).toBe(0);
    expect(firstSlot.tabIndex).toBe(-1);
  });
});

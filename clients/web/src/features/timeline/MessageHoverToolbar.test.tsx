// @vitest-environment jsdom

import {
  act,
  createElement,
  useRef,
  useState,
  type FocusEvent,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageActionAvailability } from "@momo/core/features/timeline/model";
import {
  COPY_LINK_ACTION_LABEL,
  COPY_MESSAGE_ACTION_LABEL,
} from "@momo/core/features/timeline/copyLabels";
import {
  frequentEmojis,
  recordEmojiUse,
  resetEmojiFrequencyForTests,
  useFrequentEmojis,
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
import { useHoverToolbarFocusHandoff, useRowRovingFocus } from "./rowFocus";

function stubFocusVisible(el: HTMLElement, visible: boolean) {
  const proto = HTMLElement.prototype.matches;
  return vi.spyOn(el, "matches").mockImplementation(function (
    this: HTMLElement,
    selectors: string
  ) {
    if (selectors === ":focus-visible") {
      return visible && document.activeElement === this;
    }
    return proto.call(this, selectors);
  });
}

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
  onCopyLink: () => undefined,
  onReact: () => undefined,
  onPin: () => undefined,
  onEdit: () => undefined,
  onDelete: () => undefined,
};

const copyState = {
  canCopy: true,
  copied: false,
  canCopyLink: true,
  copiedLink: false,
  pinned: false,
};

function mountToolbar(open = true, menuOpenInit = false): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  mountedRoot = createRoot(host);
  function Harness() {
    const [menuOpen, setMenuOpen] = useState(menuOpenInit);
    if (!open) return createElement("article", { "data-testid": "row" });
    return createElement(MessageHoverToolbar, {
      available,
      copyState,
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
  withChip = true,
}: {
  hovered: number | null;
  focused: number | null;
  withChip?: boolean;
}) {
  return createElement(
    "div",
    { "data-testid": "timeline" },
    Array.from({ length: 20 }, (_, index) =>
      createElement(Row, { key: index, index, hovered, focused, withChip })
    )
  );
}

function rowStations(row: Element): HTMLElement[] {
  const members = Array.from(
    row.querySelectorAll<HTMLElement>("[data-row-action]")
  ).filter((el) => el.tabIndex >= 0);
  const host = row as HTMLElement;
  if (host.tabIndex >= 0) return [host, ...members];
  return members;
}

function Row({
  index,
  hovered,
  focused,
  withChip,
}: {
  index: number;
  hovered: number | null;
  focused: number | null;
  withChip: boolean;
}) {
  const ref = useRef<HTMLElement | null>(null);
  const onKeyDown = useRowRovingFocus(ref);
  const [rowFocused, setRowFocused] = useState(focused === index);
  const show = shouldShowHoverToolbar({
    pointerCanHover: true,
    editing: false,
    rowHovered: hovered === index,
    rowFocused,
    overlayOpen: false,
    selecting: false,
  });
  useHoverToolbarFocusHandoff(ref, show, rowFocused);
  return createElement(
    "article",
    {
      ref,
      onKeyDown,
      "data-testid": "timeline-message",
      "data-seq": String(index),
      "data-actionable": "true",
      onFocusCapture: () => setRowFocused(true),
      onBlurCapture: (event: FocusEvent) => {
        const next = event.relatedTarget;
        if (next instanceof Node && event.currentTarget.contains(next)) return;
        setRowFocused(false);
      },
    },
    withChip
      ? createElement("button", {
          "data-row-action": "",
          "data-testid": `chip-${index}`,
        })
      : null,
    show
      ? createElement(MessageHoverToolbar, {
          available,
          copyState,
          callbacks,
          onOpenPicker: () => undefined,
          menuOpen: false,
          onMenuOpenChange: () => undefined,
          mineEmojis: new Set<string>(),
        })
      : null
  );
}

function mountTimeline(
  hovered: number | null,
  focused: number | null,
  withChip = true
): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  mountedRoot = createRoot(host);
  act(() =>
    mountedRoot?.render(
      createElement(TimelineHarness, { hovered, focused, withChip })
    )
  );
  return host;
}

const DUAL_SEED = [
  "👍",
  "✅",
  "🙏",
  "🎉",
  "👀",
  "🔥",
  "💯",
  "✨",
] as const;

let dualLimitRenders = 0;

function DualLimitProbe() {
  dualLimitRenders += 1;
  const a = useFrequentEmojis(DUAL_SEED, 3);
  const b = useFrequentEmojis(DUAL_SEED, 32);
  return createElement("div", {
    "data-testid": "dual",
    "data-a": a.join(""),
    "data-b": b.join(""),
  });
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

  it("⋯ 메뉴가 메시지 복사와 링크 복사를 같은 인벤토리로 그린다", () => {
    mountToolbar(true, true);
    const copy = document.querySelector('[data-testid="menu-copy"]');
    const copyLink = document.querySelector('[data-testid="menu-copy-link"]');
    expect(copy).not.toBeNull();
    expect(copyLink).not.toBeNull();
    expect(copy?.textContent).toContain(COPY_MESSAGE_ACTION_LABEL);
    expect(copyLink?.textContent).toContain(COPY_LINK_ACTION_LABEL);
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
        expect(rowStations(row)).toHaveLength(1);
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
      expect(rowStations(hovered)).toHaveLength(1);
      expect(countToolbarTabStops(hovered)).toBeLessThanOrEqual(1);
    });
    const others = host.querySelectorAll(
      '[data-testid="timeline-message"]:not([data-seq="7"])'
    );
    for (const row of others) {
      expect(row.querySelector('[data-testid="message-hover-toolbar"]')).toBeNull();
    }
  });

  it("툴바 항목이 행 로빙에 편입되어 ←/→ 로 슬롯을 돈다", async () => {
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

describe("B-1 frequency 소비자 둘 (#1743)", () => {
  it("서로 다른 limit 훅 둘을 한 트리에 마운트해도 무한 렌더가 없다", () => {
    dualLimitRenders = 0;
    const host = document.createElement("div");
    document.body.append(host);
    mountedRoot = createRoot(host);
    act(() => mountedRoot?.render(createElement(DualLimitProbe)));
    const afterMount = dualLimitRenders;
    expect(afterMount).toBeGreaterThan(0);
    expect(afterMount).toBeLessThan(5);
    act(() => {
      recordEmojiUse("🎉");
    });
    expect(dualLimitRenders - afterMount).toBeGreaterThan(0);
    expect(dualLimitRenders).toBeLessThan(12);
    const dual = host.querySelector("[data-testid='dual']")!;
    expect(dual.getAttribute("data-a")?.length).toBeGreaterThan(0);
    expect((dual.getAttribute("data-b") ?? "").length).toBeGreaterThan(
      dual.getAttribute("data-a")?.length ?? 0
    );
  });
});

describe("B-2 rest 구성원 0인 actionable 행 (#1743)", () => {
  it("Tab이 행에 착지하고 BODY로 떨어지지 않으며 ⋯까지 핸드오프한다", async () => {
    const host = mountTimeline(null, null, false);
    const row = host.querySelector('[data-seq="3"]') as HTMLElement;
    await vi.waitFor(() => expect(row.tabIndex).toBe(0));
    expect(row.querySelectorAll("[data-row-action]")).toHaveLength(0);
    expect(rowStations(row)).toHaveLength(1);

    stubFocusVisible(row, true);
    act(() => {
      row.focus();
    });

    await vi.waitFor(() => {
      expect(document.activeElement).not.toBe(document.body);
      const primary = row.querySelector<HTMLElement>(
        '[data-testid="message-actions-trigger"]'
      );
      expect(primary).not.toBeNull();
      expect(document.activeElement).toBe(primary);
    });
    expect(rowStations(row)).toHaveLength(1);
    expect(row.querySelector('[data-testid="message-hover-toolbar"]')).not.toBeNull();
  });

  it("비-focus-visible 포커스 진입 시 핸드오프 미발동", async () => {
    const host = mountTimeline(null, null, false);
    const row = host.querySelector('[data-seq="3"]') as HTMLElement;
    await vi.waitFor(() => expect(row.tabIndex).toBe(0));

    stubFocusVisible(row, false);
    act(() => {
      row.focus();
    });

    await vi.waitFor(() =>
      expect(row.querySelector('[data-testid="message-hover-toolbar"]')).not.toBeNull()
    );
    expect(document.activeElement).toBe(row);
    expect(
      row.querySelector('[data-testid="message-actions-trigger"]')
    ).not.toBe(document.activeElement);
  });

  it("순회 중 normalize를 다시 돌려도 행당 정거장은 1이다", async () => {
    const host = mountTimeline(null, null, false);
    const row = host.querySelector('[data-seq="4"]') as HTMLElement;
    stubFocusVisible(row, true);
    act(() => {
      row.focus();
    });
    await vi.waitFor(() =>
      expect(
        row.querySelector('[data-testid="message-actions-trigger"]')
      ).not.toBeNull()
    );
    expect(rowStations(row)).toHaveLength(1);
    act(() => {
      row.focus();
    });
    await vi.waitFor(() => expect(rowStations(row)).toHaveLength(1));
  });
});

describe("H-2 슬롯 순위 마운트 고정 (#1743)", () => {
  it("슬롯 클릭 직후 같은 위치 같은 글리프다", () => {
    const host = mountToolbar();
    const slots = () =>
      Array.from(
        host.querySelectorAll<HTMLElement>('[data-testid^="toolbar-react-"]')
      )
        .filter((el) => el.dataset.testid !== "toolbar-react-more")
        .map((el) => el.textContent);
    const before = slots();
    const second = host.querySelector<HTMLButtonElement>(
      `[data-testid="toolbar-react-${before[1]}"]`
    )!;
    act(() => {
      second.click();
    });
    expect(slots()).toEqual(before);
    expect(slots()[1]).toBe(before[1]);
  });
});

describe("M-1 ⋯ 이름", () => {
  it("툴바는 메시지 액션, ⋯는 더 많은 액션이다", () => {
    const host = mountToolbar();
    const bar = host.querySelector('[data-testid="message-hover-toolbar"]');
    const overflow = host.querySelector(
      '[data-testid="message-actions-trigger"]'
    );
    expect(bar?.getAttribute("aria-label")).toBe("메시지 액션");
    expect(overflow?.getAttribute("aria-label")).toBe("더 많은 액션");
  });
});

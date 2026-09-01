// @vitest-environment jsdom

import {
  act,
  createElement,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Channel, RosterMember } from "@momo/core/lib/api";
import {
  composerKeyIntent,
  isComposingEvent,
} from "@momo/core/features/chat/composerKeys";
import { loadCatalog } from "@/features/emoji/catalog";
import { resetEmojiFrequencyForTests, getEmojiFrequency } from "@/features/emoji/frequencyStore";
import { resetEscapeLayers, useEscapeLayer } from "@/design/ui/escapeLayer";
import { ComposerAutocompleteList } from "./ComposerAutocompleteList";
import { useComposerAutocomplete } from "./useComposerAutocomplete";

// =============================================================================
// 자동완성 세 트리거를 **실 DOM 으로** 재는 자리 (#1930).
//
// keydown 만 쏘고 초록을 받는 시험은 이 표면에서 두 번 거짓말을 했다: Esc 가
// 목록을 닫았다고 적어 두고 실제로는 스레드 패널까지 닫았고(escapeLayer 이전),
// 삽입 뒤 포커스가 textarea 로 돌아온다고 적어 두고 body 에 떨어져 있었다.
// 그래서 여기서는 문서에 실제로 붙은 노드와 `document.activeElement` 를 본다.
// =============================================================================

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let mountedRoot: Root | null = null;
let host: HTMLElement | null = null;
let frames: FrameRequestCallback[] = [];

const LONG_NAME = "2026-하반기-릴리스-준비-회고-및-후속-작업";

const MEMBERS: RosterMember[] = [
  {
    id: "m1",
    workspaceId: "w1",
    kind: "human",
    status: "active",
    displayName: "헤르메스",
    handle: "hermes",
    channelCount: 1,
    channelIds: ["c1"],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  },
];

const CHANNELS: Channel[] = [
  { id: "c1", workspaceId: "w1", kind: "public", name: "general", muted: false },
  {
    id: "c2",
    workspaceId: "w1",
    kind: "public",
    name: "release-notes",
    topic: "릴리스 공지",
    muted: false,
  },
  {
    id: "c3",
    workspaceId: "w1",
    kind: "public",
    name: LONG_NAME,
    topic: "릴리스 회고 기록과 후속 작업",
    muted: false,
  },
  {
    id: "c4",
    workspaceId: "w1",
    kind: "private",
    name: "김인턴작업",
    muted: false,
  },
];

beforeAll(async () => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  await loadCatalog();
});

beforeEach(() => {
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    frames.push(cb);
    return frames.length;
  });
  resetEmojiFrequencyForTests();
});

afterEach(() => {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  host?.remove();
  host = null;
  resetEscapeLayers();
  vi.unstubAllGlobals();
});

function mount(node: ReactElement): HTMLElement {
  host = document.createElement("div");
  document.body.append(host);
  mountedRoot = createRoot(host);
  act(() => {
    mountedRoot?.render(node);
  });
  return host;
}

/**
 * 이 컴포저를 **덮고 있는** 층. 스레드 패널이 그 자리다.
 *
 * Probe 보다 먼저 선 형제라서 Esc 층 스택의 **아래**에 깔린다. 목록이 자기 층을
 * 잡지 않으면 Esc 한 번이 목록과 이 층을 함께 닫고, 그것이 #1930 이전 자동완성이
 * 겪던 사고다.
 */
function OuterLayer({ onEscape }: { onEscape: () => void }) {
  useEscapeLayer(true, onEscape);
  return null;
}

function Probe() {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const auto = useComposerAutocomplete({
    value,
    members: MEMBERS,
    channels: CHANNELS,
    inputRef,
    onValueChange: setValue,
  });
  return createElement(
    "div",
    null,
    createElement(ComposerAutocompleteList, {
      id: "probe-list",
      kind: auto.kind,
      candidates: auto.candidates,
      highlight: auto.highlight,
      onChoose: auto.choose,
      testId: "probe-list",
      optionTestId: "probe-option",
    }),
    createElement("textarea", {
      ref: inputRef,
      value,
      "data-testid": "probe-input",
      "aria-expanded": auto.visible,
      "aria-controls": auto.visible ? "probe-list" : undefined,
      "aria-activedescendant": auto.visible
        ? `probe-list-option-${auto.highlight}`
        : undefined,
      onChange: (event: { target: HTMLTextAreaElement }) =>
        auto.onTextChange(event.target.value, event.target.selectionStart ?? 0),
      onSelect: (event: { target: EventTarget }) =>
        auto.setCaret((event.target as HTMLTextAreaElement).selectionStart ?? 0),
      onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => {
        const intent = composerKeyIntent(
          {
            key: event.key,
            shiftKey: event.shiftKey,
            metaKey: event.metaKey,
            ctrlKey: event.ctrlKey,
            altKey: event.altKey,
            composing: isComposingEvent(event.nativeEvent),
          },
          { mentionsOpen: auto.visible, justComposed: false, enterSends: true }
        );
        if (auto.handleIntent(intent)) event.preventDefault();
      },
    })
  );
}

function input(): HTMLTextAreaElement {
  const node = document.querySelector<HTMLTextAreaElement>(
    "[data-testid='probe-input']"
  );
  if (!node) throw new Error("probe-input 이 없다");
  return node;
}

function list(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-testid='probe-list']");
}

function options(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>("[data-testid='probe-option']")];
}

const VALUE_SETTER = Object.getOwnPropertyDescriptor(
  HTMLTextAreaElement.prototype,
  "value"
)?.set;

/** 본문과 캐럿을 한 번에 놓는다. 문장 **가운데**에서 고르는 판을 만들 때 쓴다. */
function setValueAt(node: HTMLTextAreaElement, value: string, caret: number) {
  node.focus();
  act(() => {
    VALUE_SETTER?.call(node, value);
    node.setSelectionRange(caret, caret);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function typeAll(node: HTMLTextAreaElement, text: string) {
  node.focus();
  for (const char of text) {
    const next = node.value + char;
    act(() => {
      VALUE_SETTER?.call(node, next);
      node.setSelectionRange(next.length, next.length);
      node.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
}

function press(node: EventTarget, key: string) {
  act(() => {
    node.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })
    );
  });
}

function flushFrames() {
  act(() => {
    const queued = frames;
    frames = [];
    for (const frame of queued) frame(0);
  });
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("한 목록 기계가 세 트리거를 그린다 (#1930)", () => {
  it("`@` 는 이름과 접근 이름을 그대로 지킨다", () => {
    mount(createElement(Probe));
    typeAll(input(), "@her");
    expect(list()?.getAttribute("role")).toBe("listbox");
    expect(list()?.getAttribute("aria-label")).toBe("멘션 선택");
    expect(options().map((node) => node.textContent)).toEqual(["@hermes헤르메스"]);
    press(input(), "Enter");
    flushFrames();
    expect(input().value).toBe("@hermes ");
    expect(document.activeElement).toBe(input());
    expect(input().selectionStart).toBe("@hermes ".length);
    expect(list()).toBeNull();
  });

  it("`#` 는 채널 후보를 열고 이름을 평문으로 넣는다", () => {
    mount(createElement(Probe));
    typeAll(input(), "#rel");
    expect(list()?.getAttribute("aria-label")).toBe("채널 선택");
    expect(options()).toHaveLength(1);
    expect(options()[0].textContent).toContain("#release-notes");
    press(input(), "Enter");
    flushFrames();
    expect(input().value).toBe("#release-notes ");
    expect(document.activeElement).toBe(input());
    expect(list()).toBeNull();
  });

  it("`#` 는 긴 이름도 자르지 않고 넣는다", () => {
    mount(createElement(Probe));
    typeAll(input(), "#회고");
    expect(options()).toHaveLength(1);
    press(input(), "Enter");
    flushFrames();
    expect(input().value).toBe(`#${LONG_NAME} `);
  });

  it("긴 이름의 행은 이름을 감싸고 주제 칸을 0px 로 죽이지 않는다 (M-1)", () => {
    mount(createElement(Probe));
    typeAll(input(), "#회고");
    const [row] = options();
    const spans = [...row.querySelectorAll("span")];
    expect(spans).toHaveLength(2);
    const [lead, hint] = spans;
    expect(lead.textContent).toBe(`#${LONG_NAME}`);
    expect(hint.textContent).toBe("릴리스 회고 기록과 후속 작업");
    // 행이 감싼다: 이름은 한 줄에 갇히지 않고(두 줄까지), 주제는 자기 줄에서
    // 자른다. jsdom 은 폭을 재지 않으므로 그 기하는 캡처 레인이 잰다
    // (`capture-screens.mjs` 의 `#` 장면 — 두 줄 · 안 잘림 · 힌트 폭 > 0).
    expect(row.className).toContain("flex-wrap");
    expect(lead.className).toContain("line-clamp-2");
    expect(lead.className).toContain("break-words");
    expect(lead.className).not.toContain("truncate");
    expect(hint.className).toContain("truncate");
  });

  it("주제가 없는 방은 빈 칸을 만들지 않는다 (M-1)", () => {
    mount(createElement(Probe));
    typeAll(input(), "#gen");
    expect(options()[0].querySelectorAll("span")).toHaveLength(1);
  });

  it("비공개 방은 사이드바와 같은 자물쇠로 그려진다 (M-2)", () => {
    mount(createElement(Probe));
    typeAll(input(), "#김인턴");
    const [row] = options();
    expect(row.querySelector("svg")).not.toBeNull();
    expect(row.textContent).toBe("김인턴작업");
    // 삽입은 그대로 `#이름` 평문이다.
    press(input(), "Enter");
    flushFrames();
    expect(input().value).toBe("#김인턴작업 ");
  });

  it("↑↓ 는 강조와 aria-activedescendant 를 함께 옮긴다", () => {
    mount(createElement(Probe));
    typeAll(input(), "#e");
    expect(options().length).toBeGreaterThan(1);
    expect(options()[0].getAttribute("aria-selected")).toBe("true");
    expect(input().getAttribute("aria-activedescendant")).toBe("probe-list-option-0");
    press(input(), "ArrowDown");
    expect(options()[1].getAttribute("aria-selected")).toBe("true");
    expect(input().getAttribute("aria-activedescendant")).toBe("probe-list-option-1");
    press(input(), "ArrowUp");
    expect(options()[0].getAttribute("aria-selected")).toBe("true");
  });

  it("`:` 는 유니코드를 넣고 빈도를 가산한다", async () => {
    mount(createElement(Probe));
    typeAll(input(), ":thumbsup");
    await settle();
    expect(list()?.getAttribute("aria-label")).toBe("이모지 선택");
    expect(options()[0].textContent).toContain("👍");
    press(input(), "Enter");
    flushFrames();
    expect(input().value).toBe("👍️ ");
    expect(getEmojiFrequency("👍️")).toBe(1);
    expect(document.activeElement).toBe(input());
  });

  it("`:` 한 글자로는 목록이 열리지 않는다", async () => {
    mount(createElement(Probe));
    typeAll(input(), ":t");
    await settle();
    expect(list()).toBeNull();
  });

  it("문장 가운데에서 고르면 넣은 자리 바로 뒤에 캐럿이 선다", () => {
    mount(createElement(Probe));
    setValueAt(input(), "@her 확인", 4);
    expect(options()).toHaveLength(1);
    press(input(), "Enter");
    flushFrames();
    expect(input().value).toBe("@hermes  확인");
    expect(input().selectionStart).toBe("@hermes ".length);
    expect(input().selectionEnd).toBe("@hermes ".length);
  });

  it("포커스가 입력창을 떠나 있어도 삽입이 되돌린다", () => {
    mount(createElement(Probe));
    typeAll(input(), "#rel");
    act(() => input().blur());
    expect(document.activeElement).not.toBe(input());
    press(input(), "Enter");
    flushFrames();
    expect(input().value).toBe("#release-notes ");
    expect(document.activeElement).toBe(input());
  });

  it("Esc 는 목록만 닫고 덮인 층까지 닫지 않는다", () => {
    const outer = vi.fn();
    mount(
      createElement(
        "div",
        null,
        createElement(OuterLayer, { onEscape: outer, key: "outer" }),
        createElement(Probe, { key: "probe" })
      )
    );
    typeAll(input(), "#rel");
    expect(list()).not.toBeNull();
    press(input(), "Escape");
    expect(list()).toBeNull();
    expect(outer).not.toHaveBeenCalled();
    expect(input().value).toBe("#rel");
    expect(document.activeElement).toBe(input());
    // 목록이 물러난 뒤의 Esc 는 그 아래 층의 것이다.
    press(input(), "Escape");
    expect(outer).toHaveBeenCalledTimes(1);
  });

  it("코드 서식 안에서는 세 트리거 다 목록을 열지 않는다", async () => {
    mount(createElement(Probe));
    for (const typed of ["`@her", "`#rel", "`:thumbsup"]) {
      act(() => {
        VALUE_SETTER?.call(input(), "");
        input().dispatchEvent(new Event("input", { bubbles: true }));
      });
      typeAll(input(), typed);
      await settle();
      expect(list(), typed).toBeNull();
    }
  });
});

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
import { resetEscapeLayers } from "@/design/ui/escapeLayer";
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
  { id: "c3", workspaceId: "w1", kind: "public", name: LONG_NAME, muted: false },
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

  it("Esc 는 목록만 닫고 캐럿을 입력창에 남긴다", () => {
    mount(createElement(Probe));
    typeAll(input(), "#rel");
    expect(list()).not.toBeNull();
    press(input(), "Escape");
    expect(list()).toBeNull();
    expect(input().value).toBe("#rel");
    expect(document.activeElement).toBe(input());
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

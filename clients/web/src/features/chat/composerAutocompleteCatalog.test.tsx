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
import type { RosterMember } from "@momo/core/lib/api";
import {
  composerKeyIntent,
  isComposingEvent,
} from "@momo/core/features/chat/composerKeys";
import type { CatalogEmoji } from "@/features/emoji/catalog";
import { loadCatalog } from "@/features/emoji/catalog";
import { EMOJI_CATALOG_COPY } from "@/features/emoji/copy";
import { resetEscapeLayers, useEscapeLayer } from "@/design/ui/escapeLayer";
import { ComposerAutocompleteList } from "./ComposerAutocompleteList";
import { useComposerAutocomplete } from "./useComposerAutocomplete";

// =============================================================================
// `:` 만 비동기 소스다 (design-review #1930 H-2).
//
// 리뷰가 실브라우저에서 잰 세 시나리오를 여기에 그대로 세운다:
//
//   1. 카탈로그가 늦는 동안 친 `:thu` + Enter 가 **평문으로 전송**된다. 그 뜻은
//      유지하되(목록이 없으면 키는 컴포저의 것이다) 화면이 침묵하면 안 된다.
//   2. 영구 실패가 침묵으로 끝난다. 옆 버튼의 피커는 같은 상황에서 문장과
//      「다시 시도」를 낸다.
//   3. 한글 질의(`:웃음`)가 정확히 그 침묵으로 끝난다.
//
// 그래서 카탈로그를 시험이 쥔다. 실 카탈로그를 쓰는 시험은
// `composerAutocompleteList.test.tsx` 에 그대로 있다.
// =============================================================================

vi.mock("@/features/emoji/catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/emoji/catalog")>();
  return { ...actual, loadCatalog: vi.fn() };
});

const CATALOG: CatalogEmoji[] = [
  {
    glyph: "👍️",
    name: "thumbs up",
    shortcodes: ["+1", "thumbsup"],
    keywords: ["yes"],
    category: "people",
  },
  {
    glyph: "🎉",
    name: "party popper",
    shortcodes: ["tada"],
    keywords: ["celebrate"],
    category: "activity",
  },
];

const MEMBERS: RosterMember[] = [];

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let mountedRoot: Root | null = null;
let host: HTMLElement | null = null;
let sent: string[] = [];

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  sent = [];
  vi.mocked(loadCatalog).mockReset();
});

afterEach(() => {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  host?.remove();
  host = null;
  resetEscapeLayers();
});

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
    channels: [],
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
      status: auto.status,
      offline: auto.offline,
      onRetry: auto.retryCatalog,
    }),
    createElement("textarea", {
      ref: inputRef,
      value,
      "data-testid": "probe-input",
      "aria-expanded": auto.visible,
      onChange: (event: { target: HTMLTextAreaElement }) =>
        auto.onTextChange(event.target.value, event.target.selectionStart ?? 0),
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
        if (auto.handleIntent(intent)) {
          event.preventDefault();
          return;
        }
        // 컴포저의 그 자리다: 목록이 안 받으면 Enter 는 전송이다.
        if (intent === "send") {
          sent.push(value);
          event.preventDefault();
        }
      },
    })
  );
}

function mount(node: ReactElement): HTMLElement {
  host = document.createElement("div");
  document.body.append(host);
  mountedRoot = createRoot(host);
  act(() => {
    mountedRoot?.render(node);
  });
  return host;
}

const VALUE_SETTER = Object.getOwnPropertyDescriptor(
  HTMLTextAreaElement.prototype,
  "value"
)?.set;

function input(): HTMLTextAreaElement {
  const node = document.querySelector<HTMLTextAreaElement>(
    "[data-testid='probe-input']"
  );
  if (!node) throw new Error("probe-input 이 없다");
  return node;
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

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const statusBox = () =>
  document.querySelector<HTMLElement>("[data-testid='probe-list-status']");
const listBox = () =>
  document.querySelector<HTMLElement>("[data-testid='probe-list']");

describe("`:` 의 비동기 상태를 목록 기계가 그린다 (#1930 H-2)", () => {
  it("카탈로그가 늦는 동안 로딩을 세우고, 그동안의 Enter 는 여전히 평문 전송이다", () => {
    vi.mocked(loadCatalog).mockReturnValue(new Promise(() => {}));
    mount(createElement(Probe));
    typeAll(input(), ":thu");
    expect(statusBox()?.getAttribute("data-status")).toBe("loading");
    expect(statusBox()?.querySelectorAll("[data-testid='skeleton-row']").length)
      .toBeGreaterThan(0);
    // 로딩 상자는 listbox 가 아니다: 고를 것이 없으므로 입력창도 닫힌 채다.
    expect(listBox()).toBeNull();
    expect(input().getAttribute("aria-expanded")).toBe("false");
    press(input(), "Enter");
    expect(sent).toEqual([":thu"]);
  });

  it("영구 실패는 피커와 같은 문장과 「다시 시도」를 낸다", async () => {
    vi.mocked(loadCatalog).mockRejectedValue(new Error("chunk"));
    mount(createElement(Probe));
    typeAll(input(), ":thu");
    await settle();
    const box = statusBox();
    expect(box?.getAttribute("data-status")).toBe("error");
    expect(box?.textContent).toContain(EMOJI_CATALOG_COPY.error);
    expect(box?.textContent).toContain(EMOJI_CATALOG_COPY.retry);
    // 재시도는 말이 있어야 재시도다: 누르면 다시 싣고, 이번엔 후보가 선다.
    vi.mocked(loadCatalog).mockResolvedValue(CATALOG);
    const retry = [...(box?.querySelectorAll("button") ?? [])].find(
      (node) => node.textContent === EMOJI_CATALOG_COPY.retry
    );
    expect(retry).toBeDefined();
    act(() => retry?.click());
    await settle();
    expect(statusBox()).toBeNull();
    expect(listBox()?.getAttribute("aria-label")).toBe("이모지 선택");
    expect(loadCatalog).toHaveBeenCalledTimes(2);
  });

  it("한글 질의는 침묵이 아니라 무결과 문장으로 끝난다", async () => {
    vi.mocked(loadCatalog).mockResolvedValue(CATALOG);
    mount(createElement(Probe));
    typeAll(input(), ":웃음");
    await settle();
    const box = statusBox();
    expect(box?.getAttribute("data-status")).toBe("empty");
    expect(box?.textContent).toContain(EMOJI_CATALOG_COPY.emptyHeadline);
    expect(box?.textContent).toContain(EMOJI_CATALOG_COPY.emptyDetail);
    expect(listBox()).toBeNull();
  });

  it("Esc 는 사유 상자만 치우고 덮인 층까지 닫지 않는다", async () => {
    const outer = vi.fn();
    vi.mocked(loadCatalog).mockRejectedValue(new Error("chunk"));
    mount(
      createElement(
        "div",
        null,
        createElement(OuterLayer, { onEscape: outer, key: "outer" }),
        createElement(Probe, { key: "probe" })
      )
    );
    typeAll(input(), ":thu");
    await settle();
    expect(statusBox()).not.toBeNull();
    press(input(), "Escape");
    expect(statusBox()).toBeNull();
    expect(outer).not.toHaveBeenCalled();
    press(input(), "Escape");
    expect(outer).toHaveBeenCalledTimes(1);
  });

  it("`@` 는 비동기 소스가 아니므로 사유 상자를 만들지 않는다", () => {
    vi.mocked(loadCatalog).mockReturnValue(new Promise(() => {}));
    mount(createElement(Probe));
    typeAll(input(), "@nobody");
    expect(statusBox()).toBeNull();
    expect(listBox()).toBeNull();
  });
});

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
// `:` 만 비동기 소스다 (design-review #1930 H-2), 그리고 그 상태가 내미는 손이
// **실제 컨테이너 안에서** 무엇을 하는가 (R2 B-1·M-5).
//
// R2 가 이 파일의 하네스를 결함으로 세웠다. 앞 판 `Probe` 는 `div > (목록,
// textarea)` 였는데 진짜 채널 컴포저는 `form > (목록, …textarea)` 다. 목록의
// **자리 자체가 계약**이다 — 폼 안이라 그 안의 버튼은 기본값 `submit` 이 되고,
// 「다시 시도」 한 번이 쓰던 초안을 채널로 보냈다(실측). 하네스가 그 자리를
// 지우면 이 파일이 앞으로 어떤 상태를 더 그려도 같은 부류를 계속 통과시킨다.
// 그래서 지금 `Probe` 는 컨테이너를 데이터로 받고, 채널(폼)과 스레드(폼 없음)
// 두 판을 같은 시험이 함께 돈다.
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
let submitted: string[] = [];

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  sent = [];
  submitted = [];
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

/**
 * 두 컴포저의 컨테이너를 그대로 재현한다.
 *
 * `form` = 채널 컴포저(`Composer.tsx` 의 `<form onSubmit={onSubmit} className=
 * "relative p-3">` 안에 목록이 산다), `div` = 스레드 컴포저(폼이 없다). 같은
 * 컨트롤이 두 컨테이너에서 다른 일을 하면 계약 ⑥(동형)이 깨진 것이다.
 */
function Probe({ container = "form" }: { container?: "form" | "div" }) {
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
    container,
    container === "form"
      ? {
          "data-testid": "probe-form",
          onSubmit: (event: { preventDefault: () => void }) => {
            // 진짜 컴포저의 `onSubmit` 이 하는 일: 본문을 보내고 입력창을 비운다.
            event.preventDefault();
            submitted.push(value);
            setValue("");
          },
        }
      : null,
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

function statusButtons(): HTMLButtonElement[] {
  return [
    ...(statusBox()?.querySelectorAll<HTMLButtonElement>("button") ?? []),
  ];
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

  it("「다시 시도」는 폼 안에서도 제출이 아니다 — 초안이 그대로 산다 (R2 B-1)", async () => {
    vi.mocked(loadCatalog).mockRejectedValue(new Error("chunk"));
    mount(createElement(Probe, { container: "form" }));
    typeAll(input(), ":thu");
    await settle();
    const [retry] = statusButtons();
    expect(retry).toBeDefined();
    // 이 상자는 컴포저의 제출 경로 **위에** 산다. 그 사실이 계약이라 함께 잰다.
    expect(retry.form).toBe(
      document.querySelector("[data-testid='probe-form']")
    );
    // 격이 없으면 DOM 기본값은 `submit` 이고, 그 한 번의 클릭이 쓰던 글을 보낸다.
    expect(retry.type).toBe("button");
    vi.mocked(loadCatalog).mockResolvedValue(CATALOG);
    act(() => retry.click());
    await settle();
    expect(submitted).toEqual([]);
    expect(sent).toEqual([]);
    expect(input().value).toBe(":thu");
    expect(listBox()?.getAttribute("aria-label")).toBe("이모지 선택");
  });

  it("사유 상자 안의 컨트롤은 전부 제출 격이 아니다 (R2 B-1 일반형)", async () => {
    vi.mocked(loadCatalog).mockRejectedValue(new Error("chunk"));
    mount(createElement(Probe, { container: "form" }));
    typeAll(input(), ":thu");
    await settle();
    const buttons = statusButtons();
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) {
      expect(button.type, button.textContent ?? "").toBe("button");
    }
  });

  it("스레드(폼 없음)와 채널(폼)이 같은 클릭에 같은 답을 낸다 (계약 ⑥)", async () => {
    for (const container of ["form", "div"] as const) {
      vi.mocked(loadCatalog).mockReset();
      vi.mocked(loadCatalog).mockRejectedValue(new Error("chunk"));
      sent = [];
      submitted = [];
      mount(createElement(Probe, { container }));
      typeAll(input(), ":thu");
      await settle();
      vi.mocked(loadCatalog).mockResolvedValue(CATALOG);
      act(() => statusButtons()[0]?.click());
      await settle();
      expect(input().value, container).toBe(":thu");
      expect(submitted, container).toEqual([]);
      expect(listBox(), container).not.toBeNull();
      act(() => mountedRoot?.unmount());
      mountedRoot = null;
      host?.remove();
      host = null;
    }
  });

  it("`@` 는 비동기 소스가 아니므로 사유 상자를 만들지 않는다", () => {
    vi.mocked(loadCatalog).mockReturnValue(new Promise(() => {}));
    mount(createElement(Probe));
    typeAll(input(), "@nobody");
    expect(statusBox()).toBeNull();
    expect(listBox()).toBeNull();
  });
});

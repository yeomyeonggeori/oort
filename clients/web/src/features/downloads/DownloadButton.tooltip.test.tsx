// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TOOLTIP_DELAY_MS } from "@/design/motion";
import { TOOLTIP_END_CLASS } from "@/design/ui/tooltip";
import { DownloadButton } from "./DownloadButton";
import { createDownloadsStore, type DownloadsStore } from "./downloadsStore";
import { ATTACHMENT, fake, type Fake } from "./downloadsTestKit";

// =============================================================================
// 상단 오른쪽 다운로드 단추의 툴팁은 디자인 시스템 툴팁이고, 네이티브 `title`은 없다 (#4587, owner 요청 #4591).
//
// 머리 단추 시험(`channelHeaderControls.tooltip.test.tsx`)과 같은 모양으로 **진짜 컴포넌트를 렌더해** 잰다:
// (1) `title`이 없다(있으면 운영체제 툴팁과 알약이 같이 뜬다) (2) 툴팁 래퍼 안에 서고 래퍼는 끌기 속성이
// 없다 (3) 가리키면 지연(500ms) 뒤에 **아래 방향·오른쪽 끝 맞춤** 알약이 뜬다 (4) 문구는 접근성 이름과 같은 한 문자열이고
// 상태(받는 중)를 따른다 (5) 누르면 곧바로 닫힌다. 띠 안의 글자 대비는 `downloadTooltip.band.browser.test.ts`가 엔진으로 잰다.
// =============================================================================

const env = vi.hoisted(() => ({ tauri: true }));
vi.mock("@/lib/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/env")>();
  return {
    ...actual,
    get IS_TAURI() {
      return env.tauri;
    },
  };
});

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  // Radix Popover가 jsdom에서 서려면 필요한 최소한(다른 팝오버 시험과 같다).
  HTMLElement.prototype.hasPointerCapture = () => false;
  HTMLElement.prototype.setPointerCapture = () => undefined;
  HTMLElement.prototype.releasePointerCapture = () => undefined;
  HTMLElement.prototype.scrollIntoView = () => undefined;
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {
        return undefined;
      }
      unobserve() {
        return undefined;
      }
      disconnect() {
        return undefined;
      }
    };
  }
});

let host: HTMLDivElement;
let root: Root;
let f: Fake;
let store: DownloadsStore;

const button = () => document.body.querySelector<HTMLButtonElement>('[data-testid="download-button"]') as HTMLButtonElement;
const tooltip = () => button().parentElement?.querySelector<HTMLElement>('[data-testid="tooltip"]') ?? null;

function mount(): void {
  act(() => root.render(createElement(DownloadButton, { store })));
}

function hover(el: Element): void {
  const event = new MouseEvent("pointerover", { bubbles: true });
  Object.defineProperty(event, "pointerType", { value: "mouse" });
  act(() => {
    el.dispatchEvent(event);
  });
}

function press(el: Element): void {
  const event = new MouseEvent("pointerdown", { bubbles: true });
  Object.defineProperty(event, "pointerType", { value: "mouse" });
  act(() => {
    el.dispatchEvent(event);
  });
}

beforeEach(() => {
  env.tauri = true;
  vi.useFakeTimers();
  f = fake();
  store = createDownloadsStore(f.deps);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("다운로드 단추의 툴팁 (#4587)", () => {
  it("네이티브 title이 없다: 알약과 운영체제 툴팁이 같이 뜨지 않는다", () => {
    mount();
    expect(button().hasAttribute("title")).toBe(false);
    // 이름은 접근성 이름 하나가 진다.
    expect(button().getAttribute("aria-label")).toBe("다운로드");
  });

  it("툴팁 래퍼 안에 서고, 래퍼는 끌기 속성도 탭 정거장도 만들지 않는다", () => {
    mount();
    const wrapper = button().parentElement as HTMLElement;
    expect(wrapper.tagName).toBe("SPAN");
    expect(wrapper.className).toContain("relative");
    expect(wrapper.className).toContain("inline-flex");
    expect(wrapper.hasAttribute("data-tauri-drag-region")).toBe(false);
    expect(wrapper.hasAttribute("tabindex")).toBe(false);
    // 래퍼의 자식은 단추 하나다(알약은 뜰 때만 생긴다): 누름은 항상 단추가 받는다.
    expect([...wrapper.children]).toEqual([button()]);
    // 팝오버의 트리거는 래퍼가 아니라 단추 자신이다(툴팁이 트리거 안에 들어가면 래퍼가 트리거가 된다).
    expect(button().getAttribute("aria-haspopup")).toBe("dialog");
    expect(button().hasAttribute("aria-expanded")).toBe(true);
    expect(wrapper.hasAttribute("aria-haspopup")).toBe(false);
  });

  it("가리키면 지연 시간 정확히 뒤에 아래 방향 · 오른쪽 끝 맞춤 알약이 뜬다", () => {
    mount();
    hover(button());
    act(() => void vi.advanceTimersByTime(TOOLTIP_DELAY_MS - 1));
    expect(tooltip()).toBeNull();
    act(() => void vi.advanceTimersByTime(1));
    const tip = tooltip();
    expect(tip, "툴팁이 지연 뒤에도 뜨지 않았다").not.toBeNull();
    expect(tip?.getAttribute("data-side")).toBe("bottom");
    expect(tip?.getAttribute("aria-hidden")).toBe("true");
    for (const token of TOOLTIP_END_CLASS.split(/\s+/)) expect(tip?.className).toContain(token);
    // 눈으로 보는 문구 = 듣는 이름.
    expect(tip?.textContent).toBe(button().getAttribute("aria-label"));
  });

  it("문구는 상태를 따른다: 받는 중이면 같은 한 문자열이 바뀐다", async () => {
    mount();
    act(() => {
      void store.start({ workspaceId: "ws-dalmuri", channelId: "ch-design", attachment: ATTACHMENT });
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(button().getAttribute("aria-label")).toBe("다운로드, 받는 중 1개");
    hover(button());
    act(() => void vi.advanceTimersByTime(TOOLTIP_DELAY_MS));
    expect(tooltip()?.textContent).toBe("다운로드, 받는 중 1개");
  });

  it("누르면 곧바로 닫힌다(패널이 열리는 순간 알약이 남지 않는다)", () => {
    mount();
    hover(button());
    act(() => void vi.advanceTimersByTime(TOOLTIP_DELAY_MS));
    expect(tooltip()).not.toBeNull();
    press(button());
    expect(tooltip()).toBeNull();
  });

  it("웹(브라우저)에서는 단추와 함께 툴팁도 그리지 않는다", () => {
    env.tauri = false;
    mount();
    expect(host.innerHTML).toBe("");
  });
});

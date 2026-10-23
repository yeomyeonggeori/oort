// @vitest-environment jsdom

import { act, createElement, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useScrollBodyCues } from "./useScrollBodyCues";

// =============================================================================
// 스크롤 본문 단서 훅 (#4261 design-review B-1 · M-7). jsdom 은 레이아웃이 없으므로 높이를 직접 정하고 관찰자를 가짜로 둔다.
// 이 시험이 못 박는 것:
//   · 띠 높이를 CSS 변수로 넘긴다.
//   · 내용이 본문보다 길 때만 `data-scrollable` 이 선다(`+ 1` 의 여유까지), 단서가 스스로 만드는 끝 여백 때문에 켜졌다 꺼졌다 하지 않는다.
//   · 노드가 **늦게** 서도(Radix Portal 은 첫 렌더 뒤에 내용을 세운다) 측정한다.
//   · 언마운트하면 관찰자를 끊는다.
// =============================================================================

const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

const heights = { sticky: 166, inner: 600, body: 400 };

class FakeObserver {
  static instances: FakeObserver[] = [];
  observed = new Set<Element>();
  disconnected = false;
  constructor(readonly callback: () => void) {
    FakeObserver.instances.push(this);
  }
  observe(node: Element) {
    this.observed.add(node);
  }
  disconnect() {
    this.disconnected = true;
  }
  fire() {
    this.callback();
  }
}

let root: Root | null = null;
let host: HTMLElement | null = null;
const originals: Array<[PropertyKey, PropertyDescriptor | undefined]> = [];

function stubGetter(name: "offsetHeight" | "clientHeight") {
  originals.push([name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)]);
  Object.defineProperty(HTMLElement.prototype, name, {
    configurable: true,
    get(this: HTMLElement) {
      const role = this.dataset.role as keyof typeof heights | undefined;
      return role ? heights[role] : 0;
    },
  });
}

beforeAll(() => {
  env.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  heights.sticky = 166;
  heights.inner = 600;
  heights.body = 400;
  FakeObserver.instances = [];
  stubGetter("offsetHeight");
  stubGetter("clientHeight");
  // 알림은 한 프레임 미뤄진다: 시험에서는 즉시 돈다.
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  vi.stubGlobal("ResizeObserver", FakeObserver);
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  for (const [name, descriptor] of originals.splice(0)) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
  }
  vi.unstubAllGlobals();
});

function Probe({ lateNodes = false }: { lateNodes?: boolean }): ReactElement {
  const { bodyRef, innerRef, stickyRef } = useScrollBodyCues();
  const [show, setShow] = useState(!lateNodes);
  return createElement(
    "div",
    null,
    lateNodes ? createElement("button", { "data-testid": "show", onClick: () => setShow(true) }, "show") : null,
    show
      ? createElement(
          "div",
          { ref: bodyRef, "data-role": "body", "data-testid": "body" },
          createElement(
            "div",
            { ref: innerRef, "data-role": "inner" },
            createElement("div", { ref: stickyRef, "data-role": "sticky" })
          )
        )
      : null
  );
}

function mount(props: { lateNodes?: boolean } = {}) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(createElement(Probe, props));
  });
}

const body = () => document.querySelector<HTMLElement>('[data-testid="body"]');

describe("useScrollBodyCues", () => {
  it("띠의 높이를 CSS 변수로 넘긴다", () => {
    mount();
    expect(body()?.style.getPropertyValue("--avatar-editor-sticky-height")).toBe("166px");
  });

  it("내용이 본문보다 길 때만 data-scrollable 이 선다 (1px 여유까지)", () => {
    heights.inner = 600;
    heights.body = 400;
    mount();
    expect(body()?.hasAttribute("data-scrollable")).toBe(true);
  });

  it.each([
    ["내용이 본문과 같으면", 400, 400],
    ["내용이 1px 만 길어도(반올림 오차)", 401, 400],
    ["내용이 더 짧으면", 300, 400],
  ])("%s 서지 않는다", (_name, inner, bodyHeight) => {
    heights.inner = inner;
    heights.body = bodyHeight;
    mount();
    expect(body()?.hasAttribute("data-scrollable")).toBe(false);
  });

  it("크기가 바뀌면 다시 잰다: 늘면 서고 줄면 내려간다, 같은 크기를 거듭 재도 흔들리지 않는다", () => {
    heights.inner = 300;
    mount();
    expect(body()?.hasAttribute("data-scrollable")).toBe(false);
    const observer = FakeObserver.instances.at(-1);
    expect(observer).toBeDefined();
    heights.inner = 700;
    act(() => observer?.fire());
    expect(body()?.hasAttribute("data-scrollable")).toBe(true);
    // 단서가 켜지면 본문이 끝 여백을 얻어 clientHeight 는 그대로이고 inner 도 그대로다: 같은 답을 거듭 낸다.
    for (let i = 0; i < 3; i += 1) {
      act(() => observer?.fire());
      expect(body()?.hasAttribute("data-scrollable")).toBe(true);
    }
    heights.inner = 380;
    act(() => observer?.fire());
    expect(body()?.hasAttribute("data-scrollable")).toBe(false);
  });

  it("본문·안쪽·띠 셋을 모두 관찰하고, 언마운트하면 관찰자를 끊는다", () => {
    mount();
    const observer = FakeObserver.instances.at(-1);
    expect(observer?.observed.size).toBe(3);
    expect(observer?.disconnected).toBe(false);
    act(() => root?.unmount());
    root = null;
    expect(observer?.disconnected).toBe(true);
  });

  it("노드가 늦게 서도(Portal) 그때 잰다: 첫 렌더에 노드가 없어도 다시 돈다", () => {
    mount({ lateNodes: true });
    expect(body()).toBeNull();
    expect(FakeObserver.instances).toHaveLength(0);
    act(() => document.querySelector<HTMLElement>('[data-testid="show"]')?.click());
    expect(body()?.style.getPropertyValue("--avatar-editor-sticky-height")).toBe("166px");
    expect(body()?.hasAttribute("data-scrollable")).toBe(true);
    expect(FakeObserver.instances.length).toBeGreaterThan(0);
  });

  it("ResizeObserver 가 없는 환경에서도 한 번은 잰다", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    mount();
    expect(body()?.style.getPropertyValue("--avatar-editor-sticky-height")).toBe("166px");
    expect(body()?.hasAttribute("data-scrollable")).toBe(true);
  });
});

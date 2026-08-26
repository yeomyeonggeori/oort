// @vitest-environment jsdom

import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarSection } from "./SidebarRow";
import { countSectionActionTabStops } from "./sidebarSectionModel";

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let mountedRoot: Root | null = null;
let mountedHost: HTMLElement | null = null;

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
});

afterEach(() => {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  mountedHost?.remove();
  mountedHost = null;
  vi.unstubAllGlobals();
});

function actionButton(testId: string) {
  return createElement("button", {
    type: "button",
    "data-testid": testId,
    "data-section-action": "",
    tabIndex: 0,
  });
}

function mountSections(channelOpen: boolean) {
  const host = document.createElement("div");
  document.body.append(host);
  mountedHost = host;
  mountedRoot = createRoot(host);
  function Harness() {
    const [open, setOpen] = useState(channelOpen);
    return createElement("div", {
      "data-testid": "harness",
      "data-open": open ? "1" : "0",
      children: [
        createElement("button", {
          key: "toggle",
          type: "button",
          "data-testid": "toggle-overlay",
          onClick: () => setOpen((value) => !value),
        }),
        createElement(SidebarSection, {
          key: "channels",
          title: "채널",
          sectionId: "channels",
          collapsed: false,
          onCollapsedChange: () => undefined,
          overlayOpen: open,
          action: actionButton("new-channel"),
          children: createElement("li", { "data-testid": "channel-item" }, "general"),
        }),
        createElement(SidebarSection, {
          key: "dms",
          title: "다이렉트 메시지",
          sectionId: "dms",
          collapsed: false,
          onCollapsedChange: () => undefined,
          action: actionButton("new-dm"),
          children: createElement("li", { "data-testid": "dm-item" }, "김인턴"),
        }),
      ],
    });
  }
  act(() => mountedRoot?.render(createElement(Harness)));
  return host;
}

describe("countSectionActionTabStops (렌더된 헤더)", () => {
  it("포인터 rest 에서 섹션 액션 탭 스톱은 0 이다", () => {
    const host = mountSections(false);
    expect(host.querySelector('[data-testid="new-channel"]')).toBeNull();
    expect(host.querySelector('[data-testid="new-dm"]')).toBeNull();
    expect(countSectionActionTabStops(host)).toBe(0);
  });

  it("호버된 채널 헤더만 액션을 마운트하고 그 행의 탭 스톱은 1 이다", () => {
    const host = mountSections(false);
    const header = host.querySelector(
      '[data-testid="sidebar-section-channels-header"]'
    );
    act(() => {
      header?.dispatchEvent(
        new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body })
      );
    });
    expect(host.querySelector('[data-testid="new-channel"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="new-dm"]')).toBeNull();
    expect(countSectionActionTabStops(host)).toBe(1);
  });
});

describe("overlayHeld 닫힘 전이 (R2-1)", () => {
  it("채널 오버레이는 채널 섹션만 고정하고, 닫힌 다음 프레임에 rest 0 이다", async () => {
    const host = mountSections(true);
    expect(host.querySelector('[data-testid="new-channel"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="new-dm"]')).toBeNull();
    expect(countSectionActionTabStops(host)).toBe(1);

    act(() => {
      host.querySelector<HTMLButtonElement>('[data-testid="toggle-overlay"]')?.click();
    });
    expect(host.querySelector('[data-testid="new-channel"]')).not.toBeNull();

    await act(async () => {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
    });
    expect(host.querySelector('[data-testid="new-channel"]')).toBeNull();
    expect(host.querySelector('[data-testid="new-dm"]')).toBeNull();
    expect(countSectionActionTabStops(host)).toBe(0);
  });
});

// @vitest-environment jsdom

import { act, createElement, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  hasReducedMotionListener,
  prefersReducedMotion,
} from "motion-dom";
import { SidebarDrawerScrimLayer } from "./Sidebar";

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let mountedRoot: Root | null = null;
let mountedHost: HTMLElement | null = null;

function Host({ initialOpen }: { initialOpen: boolean }) {
  const [open, setOpen] = useState(initialOpen);
  return createElement(
    "div",
    null,
    createElement(
      "button",
      {
        type: "button",
        "data-testid": "close-drawer",
        onClick: () => setOpen(false),
      },
      "닫기"
    ),
    createElement(SidebarDrawerScrimLayer, {
      open,
      onClose: () => setOpen(false),
    })
  );
}

async function mount(open: boolean): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  mountedHost = host;
  mountedRoot = createRoot(host);
  const tree: ReactElement = createElement(Host, { initialOpen: open });
  await act(async () => {
    mountedRoot?.render(tree);
    await Promise.resolve();
  });
  return host;
}

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  hasReducedMotionListener.current = false;
  prefersReducedMotion.current = null;
  vi.useFakeTimers();
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("prefers-reduced-motion"),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
  vi.spyOn(window, "getComputedStyle").mockImplementation(
    () =>
      ({
        animationDuration: `${150}ms`,
        getPropertyValue: () => "",
      }) as unknown as CSSStyleDeclaration
  );
});

afterEach(() => {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  mountedHost?.remove();
  mountedHost = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("SidebarDrawerScrimLayer reduced-motion (#1997 H-1a)", () => {
  it("detaches within one frame even when computed duration is the CSS exit", async () => {
    const host = await mount(true);
    await act(async () => {
      (host.querySelector("[data-testid='close-drawer']") as HTMLButtonElement).click();
    });
    await act(async () => {
      vi.advanceTimersByTime(20);
    });
    expect(host.querySelector("[data-testid='sidebar-scrim']")).toBeNull();
  });
});

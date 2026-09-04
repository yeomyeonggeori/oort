// @vitest-environment jsdom

import { act, createElement, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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

describe("SidebarDrawerScrimLayer presence (#1997 H-1)", () => {
  it("keeps the scrim mounted with closed frames until the exit finishes", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false,
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
          animationDuration: `${180}ms`,
          getPropertyValue: () => "",
        }) as unknown as CSSStyleDeclaration
    );

    const host = await mount(true);
    expect(host.querySelector("[data-testid='sidebar-scrim']")).not.toBeNull();
    expect(
      host.querySelector("[data-testid='sidebar-scrim']")?.getAttribute("data-state")
    ).toBe("open");

    await act(async () => {
      (host.querySelector("[data-testid='close-drawer']") as HTMLButtonElement).click();
    });

    const closed = host.querySelector("[data-testid='sidebar-scrim']");
    expect(closed).not.toBeNull();
    expect(closed?.getAttribute("data-state")).toBe("closed");

    await act(async () => {
      vi.advanceTimersByTime(180);
    });
    expect(host.querySelector("[data-testid='sidebar-scrim']")).toBeNull();
  });
});

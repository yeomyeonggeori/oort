// @vitest-environment jsdom

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * UX-R1c — Skeleton wrapper. Geometry and transition counts live in
 * design/skel.test.ts (Playwright). This file is the React contract:
 * ready attribute, is-resetting on in-place ready true→false (not remount),
 * is-settled after the fade, children, and the call-site migration.
 *
 * jsdom cannot measure transitions. It does not skip those proofs — it
 * refuses those numbers to Playwright.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(HERE, "../..");

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

let mountedRoot: Root | null = null;
let mountedHost: HTMLElement | null = null;

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
  act(() => {
    mountedRoot?.unmount();
  });
  mountedHost?.remove();
  mountedRoot = null;
  mountedHost = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function loadSkeleton(): Promise<
  (props: {
    ready: boolean;
    rows?: number;
    className?: string;
    children?: React.ReactNode;
  }) => ReactElement
> {
  const mod = await import("./States");
  if (typeof mod.Skeleton !== "function") {
    throw new Error("States.tsx must export function Skeleton (UX-R1c)");
  }
  return mod.Skeleton as (props: {
    ready: boolean;
    rows?: number;
    className?: string;
    children?: React.ReactNode;
  }) => ReactElement;
}

async function mount(
  ready: boolean,
  children?: React.ReactNode
): Promise<HTMLElement> {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  const Skeleton = await loadSkeleton();
  const host = document.createElement("div");
  document.body.append(host);
  mountedHost = host;
  mountedRoot = createRoot(host);
  await act(async () => {
    mountedRoot!.render(
      createElement(
        Skeleton,
        { ready, rows: 4 },
        children ?? createElement("p", null, "채널 목록이 도착했습니다")
      )
    );
  });
  return host;
}

function walkTsx(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      walkTsx(path, acc);
      continue;
    }
    if (name.endsWith(".test.ts") || name.endsWith(".test.tsx")) continue;
    if (name.endsWith(".tsx") || name.endsWith(".ts")) acc.push(path);
  }
  return acc;
}

describe("Skeleton wrapper", () => {
  it("exports Skeleton and paints height-preserving bars while !ready", async () => {
    const host = await mount(false);
    const root = host.querySelector('[data-testid="skeleton"]');
    expect(root).toBeTruthy();
    expect(root?.getAttribute("data-ready")).toBe("false");
    expect(host.querySelectorAll('[data-testid="skeleton-row"]').length).toBe(4);
  });

  it("ready=true sets data-ready, keeps the bars mounted, and is-settled on first paint", async () => {
    const host = await mount(true);
    const root = host.querySelector('[data-testid="skeleton"]');
    expect(root?.getAttribute("data-ready")).toBe("true");
    expect(host.querySelectorAll('[data-testid="skeleton-row"]').length).toBe(4);
    expect(host.textContent).toContain("채널 목록이 도착했습니다");
    expect(root?.classList.contains("is-settled")).toBe(true);
    expect(root?.querySelector(".skel-content")).toBeTruthy();
    expect(root?.querySelector(".skel-bars")).toBeTruthy();
  });

  it("ready true→false adds is-resetting on the same tree (not a remount)", async () => {
    const Skeleton = await loadSkeleton();
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.createElement("div");
    document.body.append(host);
    mountedHost = host;
    mountedRoot = createRoot(host);
    await act(async () => {
      mountedRoot!.render(
        createElement(Skeleton, { ready: true, rows: 3 }, "settled")
      );
    });
    await act(async () => {
      mountedRoot!.render(
        createElement(Skeleton, { ready: false, rows: 3 }, "settled")
      );
    });
    const root = host.querySelector('[data-testid="skeleton"]');
    expect(root?.classList.contains("is-resetting")).toBe(true);
    expect(root?.classList.contains("is-settled")).toBe(false);
    expect(root?.getAttribute("data-ready")).toBe("false");
  });

  it("a remount after a ready paint does not get is-resetting", async () => {
    const first = await mount(true);
    expect(
      first.querySelector('[data-testid="skeleton"]')?.classList.contains(
        "is-resetting"
      )
    ).toBe(false);
    act(() => {
      mountedRoot?.unmount();
    });
    mountedHost?.remove();
    mountedRoot = null;
    mountedHost = null;
    const second = await mount(false);
    const root = second.querySelector('[data-testid="skeleton"]');
    expect(root?.classList.contains("is-resetting")).toBe(false);
    expect(root?.getAttribute("data-ready")).toBe("false");
  });

  function stubLayerHeights(barsHeight: number, contentHeight: number): void {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        const height = (() => {
          if (this.getAttribute("data-skel") === "bars") return barsHeight;
          if (this.getAttribute("data-skel") === "content") return contentHeight;
          if (this.getAttribute("data-testid") === "skeleton") {
            const inline = Number.parseFloat(this.style.height);
            return Number.isFinite(inline) ? inline : barsHeight;
          }
          return 0;
        })();
        return {
          x: 0,
          y: 0,
          width: 200,
          height,
          top: 0,
          left: 0,
          right: 200,
          bottom: height,
          toJSON: () => undefined,
        };
      }
    );
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
      function (this: HTMLElement) {
        return this.getBoundingClientRect().height;
      }
    );
  }

  it("opacity transitionend on the bars adds is-settled", async () => {
    const host = await mount(false);
    const root = host.querySelector('[data-testid="skeleton"]');
    expect(root?.classList.contains("is-settled")).toBe(false);
    const Skeleton = await loadSkeleton();
    await act(async () => {
      mountedRoot!.render(
        createElement(
          Skeleton,
          { ready: true, rows: 4 },
          createElement("p", null, "채널 목록이 도착했습니다")
        )
      );
    });
    const bars = host.querySelector('[data-skel="bars"]');
    expect(bars).toBeTruthy();
    await act(async () => {
      const event = new Event("transitionend", { bubbles: true });
      Object.defineProperty(event, "propertyName", { value: "opacity" });
      bars!.dispatchEvent(event);
    });
    expect(
      host.querySelector('[data-testid="skeleton"]')?.classList.contains(
        "is-settled"
      )
    ).toBe(true);
  });

  it("height transitionend on a real size change settles and releases the inline height", async () => {
    stubLayerHeights(136, 60);
    const host = await mount(false);
    const Skeleton = await loadSkeleton();
    await act(async () => {
      mountedRoot!.render(
        createElement(
          Skeleton,
          { ready: true, rows: 4 },
          createElement("p", null, "채널 목록이 도착했습니다")
        )
      );
    });
    const root = host.querySelector('[data-testid="skeleton"]') as HTMLElement | null;
    expect(root?.classList.contains("is-sizing")).toBe(true);
    expect(root?.classList.contains("is-settled")).toBe(false);
    expect(root?.style.height).toBe("60px");
    await act(async () => {
      const event = new Event("transitionend", { bubbles: true });
      Object.defineProperty(event, "propertyName", { value: "height" });
      root!.dispatchEvent(event);
    });
    expect(root?.classList.contains("is-settled")).toBe(true);
    expect(root?.classList.contains("is-sizing")).toBe(false);
    expect(root?.style.height).toBe("");
  });

  it("is-settled arrives via the 400 ms fallback when height transitionend never fires", async () => {
    vi.useFakeTimers();
    try {
      stubLayerHeights(136, 60);
      const host = await mount(false);
      const Skeleton = await loadSkeleton();
      await act(async () => {
        mountedRoot!.render(
          createElement(
            Skeleton,
            { ready: true, rows: 4 },
            createElement("p", null, "채널 목록이 도착했습니다")
          )
        );
      });
      const root = host.querySelector(
        '[data-testid="skeleton"]'
      ) as HTMLElement | null;
      expect(root?.classList.contains("is-sizing")).toBe(true);
      expect(root?.classList.contains("is-settled")).toBe(false);
      expect(
        vi.getTimerCount(),
        "400 ms fallback must be scheduled (deleting setTimeout turns this red)"
      ).toBeGreaterThan(0);
      await act(async () => {
        vi.advanceTimersByTime(399);
      });
      expect(root?.classList.contains("is-settled")).toBe(false);
      await act(async () => {
        vi.advanceTimersByTime(1);
      });
      expect(root?.classList.contains("is-settled")).toBe(true);
      expect(root?.classList.contains("is-sizing")).toBe(false);
      expect(root?.style.height).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("SkeletonRows call-site migration", () => {
  it("no shipped tsx still mounts <SkeletonRows", () => {
    const hits: string[] = [];
    for (const file of walkTsx(SRC_ROOT)) {
      const text = readFileSync(file, "utf8");
      if (/<SkeletonRows\b/.test(text)) hits.push(file);
    }
    expect(hits).toEqual([]);
  });
});

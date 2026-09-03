// @vitest-environment jsdom

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

/**
 * UX-R1c — Skeleton wrapper. Geometry and transition counts live in
 * design/skel.test.ts (Playwright). This file is the React contract:
 * ready attribute, is-resetting on remount, children, and the call-site
 * migration (no remaining <SkeletonRows).
 *
 * jsdom cannot measure transitions. It does not skip those proofs — it
 * refuses: see "jsdom does not measure motion" below.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(HERE, "../..");

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

let mountedRoot: Root | null = null;
let mountedHost: HTMLElement | null = null;

afterEach(() => {
  act(() => {
    mountedRoot?.unmount();
  });
  mountedHost?.remove();
  mountedRoot = null;
  mountedHost = null;
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

  it("ready=true sets data-ready and keeps the bars mounted (overlay)", async () => {
    const host = await mount(true);
    const root = host.querySelector('[data-testid="skeleton"]');
    expect(root?.getAttribute("data-ready")).toBe("true");
    expect(host.querySelectorAll('[data-testid="skeleton-row"]').length).toBe(4);
    expect(host.textContent).toContain("채널 목록이 도착했습니다");
  });

  it("ready true→false adds is-resetting on the same tree", async () => {
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
    expect(root?.getAttribute("data-ready")).toBe("false");
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

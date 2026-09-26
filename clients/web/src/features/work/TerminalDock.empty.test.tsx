// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// =============================================================================
// #2753: the dock's empty state, rendered rather than regex-read.
//
// Two things this pins that TerminalDock.test.ts (a source scan) cannot:
//   * the 「작업 콘솔 보기」 CTA exists only when `workConsole` is provided,
//     because `/work` is routed only under that flag (App.tsx). Dropping the
//     condition turns the provided:false case red.
//   * the copy is surface-neutral: the desktop app renders this same tree, so
//     the empty state never says 「웹」.
// =============================================================================

const consoleFlag = { provided: false };

vi.mock("@momo/core/features/capabilities/serverSurfaces", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@momo/core/features/capabilities/serverSurfaces")>();
  return {
    ...actual,
    isSurfaceProvided: (
      id: import("@momo/core/features/capabilities/serverSurfaces").SurfaceId
    ) => (id === "workConsole" ? consoleFlag.provided : actual.isSurfaceProvided(id)),
  };
});

vi.mock("./useWorkSessions", () => ({
  useWorkSessions: () => ({
    data: [],
    isPending: false,
    isError: false,
    refetch: () => undefined,
  }),
  useWorkHosts: () => ({ data: [] }),
}));

vi.mock("@/features/common/useOffline", () => ({
  useOffline: () => false,
}));

vi.mock("@/app/session", () => ({
  useSession: () => ({ workspaceId: "00000000-0000-7000-8000-000000000001" }),
}));

import { TerminalDock } from "./TerminalDock";

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let root: Root | null = null;
let host: HTMLElement | null = null;

async function mount(): Promise<HTMLElement> {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      createElement(
        MemoryRouter,
        null,
        createElement(TerminalDock, {
          channelId: "00000000-0000-7000-8000-000000000201",
          onClose: () => undefined,
        })
      )
    );
    await Promise.resolve();
  });
  return host;
}

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
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

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

describe("터미널 도크 빈 상태 (#2753)", () => {
  it("workConsole 이 없으면 작업 콘솔 CTA를 세우지 않는다", async () => {
    consoleFlag.provided = false;
    const el = await mount();
    const empty = el.querySelector('[data-testid="terminal-dock-empty"]');
    expect(empty).not.toBeNull();
    expect(el.querySelectorAll('[data-testid="terminal-dock-console"]')).toHaveLength(0);
  });

  it("workConsole 이 있으면 작업 콘솔 CTA가 하나 선다", async () => {
    consoleFlag.provided = true;
    const el = await mount();
    expect(el.querySelectorAll('[data-testid="terminal-dock-console"]')).toHaveLength(1);
  });

  it("빈 상태는 무엇을 하는 곳인지 말하고, 표면 이름(웹)을 말하지 않는다", async () => {
    consoleFlag.provided = false;
    const el = await mount();
    const text =
      el.querySelector('[data-testid="terminal-dock-empty"]')?.textContent ?? "";
    expect(text).toContain("터미널 출력을 관전하는 곳입니다");
    expect(text).not.toMatch(/웹/);
  });
});

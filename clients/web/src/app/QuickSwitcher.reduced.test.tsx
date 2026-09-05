// @vitest-environment jsdom

import { act, createElement, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Channel } from "@momo/core/lib/api";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { QuickSwitcher } from "./QuickSwitcher";

const WS = "00000000-0000-7000-8000-000000000001";
const MEMBER_ID = "00000000-0000-7000-8000-000000000101";
const channels: Channel[] = [
  { id: "00000000-0000-7000-8000-000000000211", workspaceId: WS, kind: "public", name: "abc-엔진", muted: false },
];

const reducedMotion = vi.hoisted(() => ({ current: true }));

vi.mock("motion/react", async (importOriginal) => {
  const actual = (await importOriginal()) as { [key: string]: unknown };
  return {
    ...actual,
    useReducedMotion: () => reducedMotion.current,
  };
});

vi.mock("@/features/channels/useCreateChannel", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/channels/useCreateChannel")>();
  return { ...actual, useOpenCreateChannel: () => () => undefined };
});

vi.mock("@/features/routing/useAgentProfile", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/routing/useAgentProfile")>();
  return { ...actual, useOpenAgentProfile: () => () => undefined };
});

vi.mock("@/features/workspace/useWorkspace", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/workspace/useWorkspace")>();
  return {
    ...actual,
    useChannels: () => ({
      isPending: false,
      isSuccess: true,
      isError: false,
      data: channels,
      groups: { channels, dms: [] },
      refetch: () => undefined,
    }),
    useDirectory: () => ({
      directory: actual.makeDirectory([]),
      isPending: false,
      refetch: () => undefined,
    }),
  };
});

vi.mock("@/features/drafts/useDraftsPanel", () => ({
  useDraftsPanel: () => ({ showNav: false }),
}));

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let mountedRoot: Root | null = null;
let mountedHost: HTMLElement | null = null;

function sessionValue(): SessionContextValue {
  return {
    session: {
      accessToken: "access",
      refreshToken: "refresh",
      member: {
        id: MEMBER_ID,
        workspaceId: WS,
        kind: "human",
        displayName: "곽성재",
        handle: "seongjae",
      },
      realtimeWebSocketUrl: "wss://example.test/connection/websocket",
    },
    workspaceId: WS,
    realtime: null,
    connStatus: "connected",
    logout: () => undefined,
    replaceSessionMember: () => undefined,
  };
}

function Host({ initialOpen }: { initialOpen: boolean }) {
  const [open, setOpen] = useState(initialOpen);
  return createElement(
    "div",
    null,
    createElement(
      "button",
      {
        type: "button",
        "data-testid": "close-palette",
        onClick: () => setOpen(false),
      },
      "닫기"
    ),
    createElement(QuickSwitcher, { open, onOpenChange: setOpen })
  );
}

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  HTMLElement.prototype.scrollIntoView = () => undefined;
  HTMLElement.prototype.hasPointerCapture = () => false;
  HTMLElement.prototype.setPointerCapture = () => undefined;
  HTMLElement.prototype.releasePointerCapture = () => undefined;
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

beforeEach(() => {
  reducedMotion.current = true;
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

async function mountOpenPalette(): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  mountedHost = host;
  mountedRoot = createRoot(host);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const tree: ReactElement = createElement(
    QueryClientProvider,
    { client },
    createElement(
      SessionProvider,
      { value: sessionValue() },
      createElement(MemoryRouter, null, createElement(Host, { initialOpen: true }))
    )
  );
  await act(async () => {
    mountedRoot?.render(tree);
    await Promise.resolve();
  });
  expect(document.querySelector("[data-testid='quick-switcher']")).not.toBeNull();
  return host;
}

async function closePalette(host: HTMLElement): Promise<void> {
  await act(async () => {
    (host.querySelector("[data-testid='close-palette']") as HTMLButtonElement).click();
  });
  await act(async () => {
    vi.advanceTimersByTime(20);
  });
}

describe("PaletteLayer reduced-motion (#1997 N-2)", () => {
  // Green when the reduceMotion branch runs; red when it is deleted
  // (palette still mounted at 20 ms). Portal forceMount keeps
  // DialogContent mounted after open flips false, so this assertion
  // can only become true through our safeToRemove(); without it Radix
  // Presence removes the content and the red-proof goes vacuous.
  it("detaches within one frame even when computed duration is the CSS exit", async () => {
    const host = await mountOpenPalette();
    await closePalette(host);
    expect(document.querySelector("[data-testid='quick-switcher']")).toBeNull();
  });

  // Product path (b): a user stylesheet / "animations off" zeroes computed
  // duration without flipping the reduce hook. Duration 0 must still
  // schedule safeToRemove (setTimeout(0)). The R6 `if (duration <= 0)
  // return` hunk never calls it — this case is red with that hunk (#1997 B-1).
  it("detaches when computed duration is 0 without the reduce hook", async () => {
    reducedMotion.current = false;
    vi.spyOn(window, "getComputedStyle").mockImplementation(
      () =>
        ({
          animationDuration: "0s",
          getPropertyValue: () => "",
        }) as unknown as CSSStyleDeclaration
    );
    const host = await mountOpenPalette();
    await closePalette(host);
    expect(document.querySelector("[data-testid='quick-switcher']")).toBeNull();
  });
});

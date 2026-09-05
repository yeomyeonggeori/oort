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
const CH = "00000000-0000-7000-8000-000000000201";

const channels: Channel[] = [
  { id: CH, workspaceId: WS, kind: "public", name: "abc-엔진", muted: false },
];

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

function Host() {
  const [open, setOpen] = useState(false);
  return createElement(
    "div",
    null,
    createElement(
      "button",
      {
        type: "button",
        "data-testid": "open-palette",
        onClick: () => setOpen(true),
      },
      "팔레트 열기"
    ),
    createElement(QuickSwitcher, { open, onOpenChange: setOpen })
  );
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mount(): Promise<HTMLElement> {
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
      createElement(MemoryRouter, null, createElement(Host))
    )
  );
  await act(async () => {
    mountedRoot?.render(tree);
    await Promise.resolve();
  });
  await settle();
  return host;
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

describe("QuickSwitcher restoreRef owns opener focus (#1997 H-2)", () => {
  it("returns focus to the opener on Escape", async () => {
    const host = await mount();
    const opener = host.querySelector(
      "[data-testid='open-palette']"
    ) as HTMLButtonElement;
    opener.focus();
    expect(document.activeElement).toBe(opener);

    await act(async () => {
      opener.click();
    });
    await settle();
    const palette = await vi.waitFor(() => {
      const node = document.querySelector("[data-testid='quick-switcher']");
      expect(node).not.toBeNull();
      return node as HTMLElement;
    });

    await act(async () => {
      palette.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      );
    });
    await settle();
    expect(document.activeElement).toBe(opener);
  });

  it("returns focus to the opener after selecting an item", async () => {
    const host = await mount();
    const opener = host.querySelector(
      "[data-testid='open-palette']"
    ) as HTMLButtonElement;
    opener.focus();
    await act(async () => {
      opener.click();
    });
    await settle();
    await vi.waitFor(() => {
      expect(document.querySelector("[data-testid='quick-switcher']")).not.toBeNull();
    });

    const inbox = Array.from(document.querySelectorAll("[cmdk-item]")).find(
      (node) => (node.textContent ?? "").includes("인박스")
    ) as HTMLElement | undefined;
    expect(inbox).toBeDefined();
    await act(async () => {
      inbox?.click();
    });
    await settle();
    expect(document.activeElement).toBe(opener);
  });
});

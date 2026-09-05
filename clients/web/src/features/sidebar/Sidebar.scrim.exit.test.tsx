// @vitest-environment jsdom

import { act, createElement, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Channel, RosterMember } from "@momo/core/lib/api";
import { emptySidebarPrefs } from "@momo/core/features/sidebar/sidebarSections";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { ShellNavProvider } from "@/app/shellNav";
import { Sidebar } from "./Sidebar";

const WS = "00000000-0000-7000-8000-000000000001";
const MEMBER_ID = "00000000-0000-7000-8000-000000000101";
const CH_ENGINE = "00000000-0000-7000-8000-000000000201";

vi.mock("@/features/workspace/useAddWorkspace", () => ({
  useOpenAddWorkspace: () => () => undefined,
}));

vi.mock("@/features/channels/useCreateChannel", () => ({
  useOpenCreateChannel: () => () => undefined,
  useCreateChannelOpen: () => false,
}));

vi.mock("@/features/emoji/useHoverNone", () => ({
  useHoverNone: () => false,
}));

vi.mock("./ProfileCard", () => ({
  ProfileCard: () => null,
}));

vi.mock("./WorkspaceRail", () => ({
  WorkspaceRail: () => null,
}));

vi.mock("@/app/ShortcutHelpDialog", () => ({
  ShortcutHelpDialog: () => null,
}));

vi.mock("@/features/drafts/DraftsNavItem", () => ({
  DraftsNavItem: () => null,
}));

const engine: Channel = {
  id: CH_ENGINE,
  workspaceId: WS,
  kind: "public",
  name: "엔진",
  muted: false,
};

const self: RosterMember = {
  id: MEMBER_ID,
  workspaceId: WS,
  kind: "human",
  status: "active",
  displayName: "곽성재",
  handle: "seongjae",
  role: "owner",
  channelCount: 1,
  channelIds: [CH_ENGINE],
  capabilities: [],
  createdAtMs: 1_800_000_000_000,
  updatedAtMs: 1_800_000_000_000,
};

vi.mock("@/features/workspace/useWorkspace", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/workspace/useWorkspace")>();
  return {
    ...actual,
    useChannels: () => ({
      isLoading: false,
      isPending: false,
      error: null,
      refetch: () => undefined,
      groups: { channels: [engine], dms: [] as Channel[] },
      data: [engine],
    }),
    useDirectory: () => ({
      directory: makeDirectory([self]),
      isPending: false,
      isLoading: false,
    }),
    useReadStates: () => ({
      byChannel: new Map(),
      isPending: false,
      error: null,
    }),
  };
});

vi.mock("@momo/core/features/sidebar/api", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@momo/core/features/sidebar/api")>();
  return {
    ...actual,
    fetchSidebarPrefs: async () => emptySidebarPrefs(),
    putSidebarPrefs: async (_ws: string, prefs: unknown) => prefs,
  };
});

vi.mock("@momo/core/features/settings/api", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@momo/core/features/settings/api")>();
  return {
    ...actual,
    fetchWorkspace: async () => ({
      id: WS,
      slug: "dawn",
      name: "새벽",
      updatedAtMs: 1_800_000_000_000,
      roleLabels: {},
    }),
  };
});

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
    QueryClientProvider,
    {
      client: new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
      }),
    },
    createElement(
      SessionProvider,
      { value: sessionValue() },
      createElement(
        ShellNavProvider,
        {
          value: {
            isMobile: true,
            drawerOpen: open,
            openDrawer: () => setOpen(true),
            closeDrawer: () => setOpen(false),
          },
        },
        createElement(
          MemoryRouter,
          { initialEntries: ["/"] },
          createElement(Sidebar, {
            onOpenQuickSwitcher: () => undefined,
            channelPaneCollapsed: false,
            treeHidden: false,
          })
        )
      )
    )
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

describe("Sidebar scrim presence (#1997 M-2)", () => {
  it("keeps the scrim mounted with data-state=closed until the exit finishes", async () => {
    const host = await mount(true);
    const scrim = host.querySelector("[data-testid='sidebar-scrim']");
    expect(scrim).not.toBeNull();
    expect(scrim?.getAttribute("data-state")).toBe("open");

    await act(async () => {
      (host.querySelector("[data-testid='close-sidebar-drawer']") as HTMLButtonElement).click();
    });

    const closed = host.querySelector("[data-testid='sidebar-scrim']");
    expect(closed).not.toBeNull();
    expect(closed?.getAttribute("data-state")).toBe("closed");

    await act(async () => {
      vi.advanceTimersByTime(179);
    });
    expect(host.querySelector("[data-testid='sidebar-scrim']")).not.toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(host.querySelector("[data-testid='sidebar-scrim']")).toBeNull();
  });
});

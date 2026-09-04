// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Channel, MessageSearchHit, RosterMember } from "@momo/core/lib/api";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { SearchRoute } from "./SearchRoute";

const WS = "00000000-0000-7000-8000-000000000001";
const MEMBER_ID = "00000000-0000-7000-8000-000000000101";
const CH_DEPLOY = "00000000-0000-7000-8000-000000000201";
const AUTHOR = "00000000-0000-7000-8000-000000000102";

const searchMessages = vi.hoisted(() => vi.fn());

vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return {
    ...actual,
    searchMessages: (...args: unknown[]) => searchMessages(...args),
  };
});

vi.mock("@/app/SidebarDrawerToggle", () => ({
  SidebarDrawerToggle: () => null,
}));

const channels: Channel[] = [
  {
    id: CH_DEPLOY,
    workspaceId: WS,
    kind: "public",
    name: "배포",
    muted: false,
  },
];

const author: RosterMember = {
  id: AUTHOR,
  workspaceId: WS,
  kind: "human",
  status: "active",
  displayName: "김인턴",
  handle: "intern",
  role: "member",
  channelCount: 1,
  channelIds: [CH_DEPLOY],
  capabilities: [],
  createdAtMs: 0,
  updatedAtMs: 0,
};

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
      directory: actual.makeDirectory([author]),
      isPending: false,
      refetch: () => undefined,
    }),
  };
});

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let mountedRoot: Root | null = null;
let mountedHost: HTMLElement | null = null;

function hit(): MessageSearchHit {
  return {
    channelId: CH_DEPLOY,
    messageId: "m-1",
    authorMemberId: AUTHOR,
    seq: 1,
    createdAtMs: 1_800_000_000_000,
    snippet: "배포 준비 끝났습니다",
    matchOffset: 0,
  };
}

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

async function mountAt(path: string): Promise<HTMLElement> {
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
      createElement(
        MemoryRouter,
        { initialEntries: [path] },
        createElement(
          Routes,
          null,
          createElement(Route, {
            path: "/search",
            element: createElement(SearchRoute),
          })
        )
      )
    )
  );
  await act(async () => {
    mountedRoot?.render(tree);
    await Promise.resolve();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return host;
}

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  searchMessages.mockReset();
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

describe("SearchRoute skeleton host", () => {
  it("wraps the result list inside Skeleton (moving the list out turns this red)", async () => {
    searchMessages.mockResolvedValue({ hits: [hit()] });
    const host = await mountAt("/search?q=배포");
    const list = await vi.waitFor(() => {
      const node = host.querySelector('[data-testid="search-results"]');
      expect(node).not.toBeNull();
      return node as HTMLElement;
    });
    const skel = host.querySelector(
      '[data-testid="search-route"] [data-testid="skeleton"]'
    );
    expect(skel).not.toBeNull();
    expect(skel?.contains(list)).toBe(true);
    expect(skel?.getAttribute("data-ready")).toBe("true");
    expect(skel?.querySelector(".skel-content")).toBeTruthy();
  });

  it("stays data-ready=false while searching (ready={true} turns this red)", async () => {
    searchMessages.mockImplementation(() => new Promise(() => {}));
    const host = await mountAt("/search?q=배포");
    const skel = await vi.waitFor(() => {
      const node = host.querySelector(
        '[data-testid="search-route"] [data-testid="skeleton"]'
      );
      expect(node).not.toBeNull();
      return node as HTMLElement;
    });
    expect(skel.getAttribute("data-ready")).toBe("false");
  });
});

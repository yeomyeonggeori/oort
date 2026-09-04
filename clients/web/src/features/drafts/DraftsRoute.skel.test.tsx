// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import type { DraftsPanelState } from "./useDraftsPanel";
import { DraftsRoute } from "./DraftsRoute";

const WS = "00000000-0000-7000-8000-000000000001";
const MEMBER_ID = "00000000-0000-7000-8000-000000000101";

vi.mock("@/app/SidebarDrawerToggle", () => ({
  SidebarDrawerToggle: () => null,
}));

const panel: DraftsPanelState = {
  items: [],
  showNav: false,
  isPending: false,
  isError: false,
  refetch: () => undefined,
};

vi.mock("./useDraftsPanel", () => ({
  useDraftsPanel: () => panel,
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

async function mount(): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  mountedHost = host;
  mountedRoot = createRoot(host);
  const tree: ReactElement = createElement(
    SessionProvider,
    { value: sessionValue() },
    createElement(
      MemoryRouter,
      { initialEntries: ["/drafts"] },
      createElement(DraftsRoute)
    )
  );
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
  panel.items = [];
  panel.isPending = false;
  panel.isError = false;
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

describe("DraftsRoute skeleton host", () => {
  it("wraps the empty state inside Skeleton (moving it out turns this red)", async () => {
    const host = await mount();
    const empty = host.querySelector('[data-testid="drafts-empty"]');
    const skel = host.querySelector(
      '[data-testid="drafts-route"] [data-testid="skeleton"]'
    );
    expect(empty).not.toBeNull();
    expect(skel).not.toBeNull();
    expect(skel?.contains(empty)).toBe(true);
    expect(skel?.getAttribute("data-ready")).toBe("true");
    expect(skel?.querySelector(".skel-content")).toBeTruthy();
  });

  it("stays data-ready=false while drafts are loading (ready={true} turns this red)", async () => {
    panel.isPending = true;
    const host = await mount();
    const skel = host.querySelector(
      '[data-testid="drafts-route"] [data-testid="skeleton"]'
    );
    expect(skel).not.toBeNull();
    expect(skel?.getAttribute("data-ready")).toBe("false");
  });
});

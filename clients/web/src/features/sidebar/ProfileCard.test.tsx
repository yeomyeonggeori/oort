// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { RosterMember } from "@momo/core/lib/api";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { AddWorkspaceOpenContext } from "@/features/workspace/useAddWorkspace";
import { ProfileCard } from "./ProfileCard";

const WS = "00000000-0000-7000-8000-000000000001";
const MEMBER_ID = "00000000-0000-7000-8000-000000000101";

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let mountedRoot: Root | null = null;
let mountedHost: HTMLElement | null = null;

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  HTMLElement.prototype.scrollIntoView = () => undefined;
  HTMLElement.prototype.hasPointerCapture = () => false;
  HTMLElement.prototype.setPointerCapture = () => undefined;
  HTMLElement.prototype.releasePointerCapture = () => undefined;
  if (typeof globalThis.PointerEvent === "undefined") {
    globalThis.PointerEvent = class PointerEvent extends MouseEvent {
      constructor(type: string, init?: MouseEventInit) {
        super(type, init);
      }
    } as unknown as typeof PointerEvent;
  }
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

function rosterMember(): RosterMember {
  return {
    id: MEMBER_ID,
    workspaceId: WS,
    kind: "human",
    status: "active",
    displayName: "곽성재",
    handle: "seongjae",
    role: "owner",
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    presenceStatus: "auto",
    createdAtMs: 0,
    updatedAtMs: 0,
  };
}

function sessionValue(logout: () => void): SessionContextValue {
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
    logout,
  };
}

function mountCard(logout: () => void = () => undefined): HTMLElement {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  const host = document.createElement("div");
  document.body.append(host);
  mountedHost = host;
  mountedRoot = createRoot(host);
  const tree: ReactElement = createElement(
    QueryClientProvider,
    { client },
    createElement(
      SessionProvider,
      { value: sessionValue(logout) },
      createElement(
        MemoryRouter,
        null,
        createElement(
          AddWorkspaceOpenContext.Provider,
          { value: () => undefined },
          createElement(ProfileCard, {
            workspaceId: WS,
            selfMemberId: MEMBER_ID,
            selfMember: rosterMember(),
            selfName: "곽성재",
            connected: true,
          })
        )
      )
    )
  );
  act(() => mountedRoot?.render(tree));
  return host;
}

async function openMenu(): Promise<HTMLElement> {
  const trigger = document.querySelector(
    '[data-testid="profile-card"]'
  ) as HTMLButtonElement | null;
  expect(trigger).not.toBeNull();
  await act(async () => {
    trigger!.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, cancelable: true })
    );
    trigger!.click();
  });
  return vi.waitFor(() => {
    const menu = document.querySelector('[data-testid="profile-card-menu"]');
    expect(menu).not.toBeNull();
    return menu as HTMLElement;
  });
}

function menuRowIds(): string[] {
  return [...document.querySelectorAll("[data-testid]")]
    .map((node) => node.getAttribute("data-testid"))
    .filter((id): id is string =>
      id === "presence-option-auto" ||
      id === "presence-option-away" ||
      id === "presence-option-dnd" ||
      id === "profile-add-workspace" ||
      id === "nav-settings" ||
      id === "profile-logout"
    );
}

async function pressKey(key: string) {
  const target = document.activeElement ?? document.body;
  await act(async () => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("ProfileCard 로그아웃 (#1858)", () => {
  it("메뉴를 열면 기존 항목 뒤에 profile-logout 이 선다", async () => {
    mountCard();
    const menu = await openMenu();
    expect(menu.querySelector('[data-testid="presence-option-auto"]')).not.toBeNull();
    expect(menu.querySelector('[data-testid="presence-option-away"]')).not.toBeNull();
    expect(menu.querySelector('[data-testid="presence-option-dnd"]')).not.toBeNull();
    expect(menu.querySelector('[data-testid="profile-add-workspace"]')).not.toBeNull();
    expect(menu.querySelector('[data-testid="nav-settings"]')).not.toBeNull();
    const logoutItem = menu.querySelector('[data-testid="profile-logout"]');
    expect(logoutItem).not.toBeNull();
    expect(logoutItem?.textContent).toContain("로그아웃");
    expect(menuRowIds()).toEqual([
      "presence-option-auto",
      "presence-option-away",
      "presence-option-dnd",
      "profile-add-workspace",
      "nav-settings",
      "profile-logout",
    ]);
  });

  it("로그아웃을 고르면 logout 을 한 번 부른다", async () => {
    const logout = vi.fn();
    mountCard(logout);
    await openMenu();
    const logoutItem = document.querySelector(
      '[data-testid="profile-logout"]'
    ) as HTMLElement | null;
    expect(logoutItem).not.toBeNull();
    await act(async () => {
      logoutItem!.click();
    });
    expect(logout).toHaveBeenCalledTimes(1);
  });

  it("Arrow 와 Enter 로 로그아웃에 도달해 발동한다", async () => {
    const logout = vi.fn();
    mountCard(logout);
    await openMenu();
    const seen: string[] = [];
    for (let step = 0; step < 12; step += 1) {
      const id = document.activeElement?.getAttribute("data-testid");
      if (id) seen.push(id);
      if (id === "profile-logout") break;
      await pressKey("ArrowDown");
    }
    expect(seen).toContain("presence-option-auto");
    expect(seen).toContain("nav-settings");
    expect(document.activeElement?.getAttribute("data-testid")).toBe(
      "profile-logout"
    );
    await pressKey("Enter");
    expect(logout).toHaveBeenCalledTimes(1);
  });
});

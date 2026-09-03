// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { LoginResponse } from "@momo/core/lib/api";
import { applyLogin, clearSession } from "@/lib/session";
import {
  dismissPhoneLinkFirstRun,
  markPhoneLinkFirstRunPending,
  PHONE_LINK_FIRST_RUN_KEY,
} from "@/features/auth/phoneLinkFirstRunStore";

const restoreSession = vi.hoisted(() => vi.fn());

vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return {
    ...actual,
    restoreSession: (...args: unknown[]) => restoreSession(...args),
  };
});

vi.mock("@/features/chat/ChatShell", () => ({
  ChatShell: () => createElement("div", { "data-testid": "channel-list" }, "shell"),
}));

vi.mock("@/app/AppShell", async () => {
  const { createElement: h } = await import("react");
  const { Outlet } = await import("react-router-dom");
  return {
    AppShell: () => h("div", { "data-testid": "app-shell" }, h(Outlet)),
  };
});

vi.mock("@/features/updates/store", () => ({
  startUpdateWatch: () => () => undefined,
}));

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

const session: LoginResponse = {
  accessToken: "access",
  refreshToken: "refresh",
  member: {
    id: "00000000-0000-7000-8000-000000000101",
    workspaceId: "00000000-0000-7000-8000-000000000001",
    kind: "human",
    displayName: "곽성재",
    handle: "seongjae",
  },
  realtimeWebSocketUrl: "wss://example.test/connection/websocket",
};

let mountedRoot: Root | null = null;
let mountedHost: HTMLElement | null = null;

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  sessionStorage.clear();
  clearSession();
  restoreSession.mockReset();
  restoreSession.mockResolvedValue(session);
  window.history.replaceState(null, "", "/");
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
  sessionStorage.clear();
  clearSession();
  vi.unstubAllGlobals();
});

async function mountApp(): Promise<HTMLElement> {
  const { App } = await import("./App");
  const host = document.createElement("div");
  document.body.append(host);
  mountedHost = host;
  mountedRoot = createRoot(host);
  await act(async () => {
    mountedRoot?.render(createElement(App));
    await Promise.resolve();
    await Promise.resolve();
  });
  await vi.waitFor(() => {
    expect(host.querySelector('[data-testid="session-restoring"]')).toBeNull();
  });
  return host;
}

function filledAccentButtons(root: ParentNode): HTMLButtonElement[] {
  return [...root.querySelectorAll("button")].filter((button) => {
    const cls = button.className;
    return /\bbg-accent\b/.test(cls) && /\btext-on-accent\b/.test(cls);
  });
}

describe("App post-login phone-link first-run (B2)", () => {
  it("renders the first-run card after join with the session store applied", async () => {
    applyLogin(session);
    markPhoneLinkFirstRunPending();
    const host = await mountApp();
    const card = host.querySelector('[data-testid="onboarding-phone-link"]');
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain("폰에서도 쓰기");
    expect(host.querySelector('[data-testid="onboarding-step-chrome"]')).not.toBeNull();
    expect(card?.className).toMatch(/\bmax-w-sm\b/);
    expect(card?.className).not.toMatch(/max-w-2xl/);
    expect(host.querySelector('[data-testid="onboarding-progress"]')).toBeNull();
    expect(filledAccentButtons(card as ParentNode).length).toBeLessThanOrEqual(1);
  });

  it("does not bring the card back after dismiss and remount", async () => {
    applyLogin(session);
    markPhoneLinkFirstRunPending();
    const host = await mountApp();
    expect(host.querySelector('[data-testid="onboarding-phone-link"]')).not.toBeNull();

    await act(async () => {
      host.querySelector<HTMLButtonElement>(
        '[data-testid="onboarding-enter-app"]'
      )?.click();
    });
    expect(host.querySelector('[data-testid="onboarding-phone-link"]')).toBeNull();
    expect(sessionStorage.getItem(PHONE_LINK_FIRST_RUN_KEY)).toBe("done");

    act(() => mountedRoot?.unmount());
    mountedRoot = null;
    mountedHost?.remove();
    mountedHost = null;

    applyLogin(session);
    const remounted = await mountApp();
    expect(remounted.querySelector('[data-testid="onboarding-phone-link"]')).toBeNull();
    expect(remounted.querySelector('[data-testid="channel-list"]')).not.toBeNull();
  });

  it("skips the card on a login restore that was never marked pending", async () => {
    applyLogin(session);
    dismissPhoneLinkFirstRun();
    const host = await mountApp();
    expect(host.querySelector('[data-testid="onboarding-phone-link"]')).toBeNull();
    expect(host.querySelector('[data-testid="channel-list"]')).not.toBeNull();
  });
});

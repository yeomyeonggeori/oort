// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { LoginResponse } from "@momo/core/lib/api";
import { applyLogin, clearSession } from "@/lib/session";
import { resetKickoffHoldForTests } from "@/features/welcome/firstRunGate";
import {
  clearOwnerOnboardingPending,
  ownerOnboardingIsPending,
  OWNER_ONBOARDING_KEY,
} from "@/features/onboarding/ownerOnboardingStore";
import { releaseSessionRestore } from "@/features/auth/onboardingSessionHold";

const restoreSession = vi.hoisted(() => vi.fn());
const claimOwnerPassword = vi.hoisted(() => vi.fn());
const fetchWorkspace = vi.hoisted(() => vi.fn());

vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return {
    ...actual,
    restoreSession: (...args: unknown[]) => restoreSession(...args),
    claimOwnerPassword: (...args: unknown[]) =>
      claimOwnerPassword(...args) as Promise<LoginResponse>,
  };
});

vi.mock("@momo/core/features/settings/api", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@momo/core/features/settings/api")>();
  return {
    ...actual,
    fetchWorkspace: (...args: unknown[]) => fetchWorkspace(...args),
  };
});

vi.mock("@momo/core/features/hostedAgents/api", () => ({
  listHostedConnections: vi.fn(async () => ({ connections: [] })),
  getHostedConnection: vi.fn(),
  createHostedConnection: vi.fn(),
  regenerateHostedPairing: vi.fn(),
  confirmHostedConnection: vi.fn(),
  disconnectHostedConnection: vi.fn(),
  acknowledgeHostedCleanupArtifact: vi.fn(),
  completeHostedDisconnect: vi.fn(),
  registerHostedDoorbell: vi.fn(),
  unregisterHostedDoorbell: vi.fn(),
}));

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

vi.mock("@/lib/realtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/realtime")>();
  return {
    ...actual,
    createRealtime: () => ({
      subscribeChannel: () => () => undefined,
      subscribeAgent: () => () => undefined,
      subscribeTyping: () => () => undefined,
      subscribeWorkSession: () => () => undefined,
      subscribeCascade: () => () => undefined,
      subscribeHuddle: () => () => undefined,
      reconnect: () => undefined,
      dispose: () => undefined,
    }),
  };
});

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

const TOKEN = "A".repeat(43);
const PASSWORD = "correct-horse-battery-staple";

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
let queryClient: QueryClient | null = null;

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  sessionStorage.clear();
  clearSession();
  resetKickoffHoldForTests();
  releaseSessionRestore();
  clearOwnerOnboardingPending();
  restoreSession.mockReset();
  claimOwnerPassword.mockReset();
  fetchWorkspace.mockReset();
  restoreSession.mockResolvedValue(session);
  claimOwnerPassword.mockImplementation(async () => {
    applyLogin(session);
    // Yield so App can enter `restoring` if the page has not held yet.
    // A same-turn applyLogin+hold is batched in jsdom and would hide B-1.
    await new Promise((resolve) => setTimeout(resolve, 0));
    return session;
  });
  fetchWorkspace.mockResolvedValue({
    id: session.member.workspaceId,
    slug: "dawn",
    name: "새벽",
    updatedAtMs: 1,
    roleLabels: {},
    welcomeAgentMemberId: null,
    welcomePrompt: "",
  });
  window.history.replaceState(null, "", `/claim/${TOKEN}`);
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
  queryClient?.clear();
  queryClient = null;
  sessionStorage.clear();
  clearSession();
  releaseSessionRestore();
  vi.unstubAllGlobals();
});

async function mountApp(): Promise<HTMLElement> {
  const { App } = await import("@/app/App");
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  queryClient = client;
  const host = document.createElement("div");
  document.body.append(host);
  mountedHost = host;
  mountedRoot = createRoot(host);
  await act(async () => {
    mountedRoot?.render(
      createElement(QueryClientProvider, { client }, createElement(App))
    );
    await Promise.resolve();
    await Promise.resolve();
  });
  return host;
}

function fill(testId: string, value: string) {
  const node = document.querySelector(
    `[data-testid="${testId}"]`
  ) as HTMLInputElement | null;
  expect(node, testId).not.toBeNull();
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value"
  )?.set;
  act(() => {
    setter?.call(node, value);
    node!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function click(testId: string) {
  const node = document.querySelector(`[data-testid="${testId}"]`);
  expect(node, testId).not.toBeNull();
  act(() => {
    (node as HTMLElement).click();
  });
}

describe("claim → S2 through App restore hold (B-1)", () => {
  it("renders S2 after claim applyLogin instead of the session-restoring skeleton", async () => {
    // A late hold cancels an in-flight restore and parks the skeleton.
    // Keep restore pending so that race cannot "win" and still paint S2.
    restoreSession.mockImplementation(() => new Promise(() => undefined));
    const host = await mountApp();
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="claim-submit"]')).not.toBeNull();
    });
    fill("claim-password", PASSWORD);
    fill("claim-confirm", PASSWORD);
    click("claim-submit");
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="onboarding-s2"]')).not.toBeNull();
    });
    expect(host.querySelector('[data-testid="session-restoring"]')).toBeNull();
    expect(restoreSession).not.toHaveBeenCalled();
    expect(ownerOnboardingIsPending()).toBe(true);
  });
});

describe("reload during S2 re-enters S2 (H-1)", () => {
  it("reload during S2 re-enters S2 then skip proceeds", async () => {
    const host = await mountApp();
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="claim-submit"]')).not.toBeNull();
    });
    fill("claim-password", PASSWORD);
    fill("claim-confirm", PASSWORD);
    click("claim-submit");
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="onboarding-s2"]')).not.toBeNull();
    });
    expect(sessionStorage.getItem(OWNER_ONBOARDING_KEY)).toBe("invite");

    act(() => {
      mountedRoot?.unmount();
      mountedRoot = null;
    });
    mountedHost?.remove();
    mountedHost = null;

    const reloaded = await mountApp();
    await vi.waitFor(() => {
      expect(reloaded.querySelector('[data-testid="session-restoring"]')).toBeNull();
    });
    expect(reloaded.querySelector('[data-testid="onboarding-s2"]')).not.toBeNull();
    expect(reloaded.querySelector('[data-testid="app-shell"]')).toBeNull();

    click("onboarding-s2-skip");
    await vi.waitFor(() => {
      expect(reloaded.querySelector('[data-testid="onboarding-s2"]')).toBeNull();
    });
    expect(ownerOnboardingIsPending()).toBe(false);
    expect(reloaded.querySelector('[data-testid="app-shell"]')).not.toBeNull();
  });
});

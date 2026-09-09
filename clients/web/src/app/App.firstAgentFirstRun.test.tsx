// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { LoginResponse } from "@momo/core/lib/api";
import { applyLogin, clearSession } from "@/lib/session";
import {
  markPhoneLinkFirstRunPending,
} from "@/features/auth/phoneLinkFirstRunStore";
import { markFirstAgentPending } from "@/features/welcome/firstAgentStore";
import { resetKickoffHoldForTests } from "@/features/welcome/firstRunGate";

const restoreSession = vi.hoisted(() => vi.fn());

vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return {
    ...actual,
    restoreSession: (...args: unknown[]) => restoreSession(...args),
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
  queryClient?.clear();
  queryClient = null;
  sessionStorage.clear();
  clearSession();
  vi.unstubAllGlobals();
});

async function mountApp(): Promise<HTMLElement> {
  const { App } = await import("./App");
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
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
  await vi.waitFor(() => {
    expect(host.querySelector('[data-testid="session-restoring"]')).toBeNull();
  });
  return host;
}

describe("App post-login first-agent then phone (#2216)", () => {
  it("둘 다 pending 이면 첫 에이전트가 폰보다 먼저 선다", async () => {
    applyLogin(session);
    markFirstAgentPending(session.member.workspaceId);
    markPhoneLinkFirstRunPending();
    const host = await mountApp();
    const appSrc = readFileSync(resolve(process.cwd(), "src/app/App.tsx"), "utf8");
    expect(appSrc).toContain("createRealtime(");
    expect(appSrc).toContain("resolveSpikeRealtimeUrl");
    expect(appSrc).not.toMatch(/connStatus:\s*"connected"/);
    expect(host.querySelector('[data-testid="first-agent-stage"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="onboarding-phone-link"]')).toBeNull();
    expect(host.querySelector('[data-testid="channel-list"]')).toBeNull();
  });
});

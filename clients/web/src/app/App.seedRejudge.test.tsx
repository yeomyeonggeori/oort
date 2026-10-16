// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { LoginResponse } from "@momo/core/lib/api";
import { applyLogin, clearSession } from "@/lib/session";
import { resetKickoffHoldForTests } from "@/features/welcome/firstRunGate";
import { clearOwnerOnboardingPending } from "@/features/onboarding/ownerOnboardingStore";

const restoreSession = vi.hoisted(() => vi.fn());
const fetchWorkspace = vi.hoisted(() => vi.fn());
const fetchRoster = vi.hoisted(() => vi.fn());

vi.mock("@momo/core/features/settings/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/features/settings/api")>();
  return { ...actual, fetchWorkspace: (...args: unknown[]) => fetchWorkspace(...args) };
});

vi.mock("@/features/onboarding/OwnerOnboarding", async () => {
  const { createElement: h } = await import("react");
  return { OwnerOnboarding: () => h("div", { "data-testid": "owner-onboarding" }, "S1") };
});

vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return {
    ...actual,
    restoreSession: (...args: unknown[]) => restoreSession(...args),
    fetchRoster: (...args: unknown[]) => fetchRoster(...args),
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

vi.mock("@/features/updates/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/updates/store")>()),
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
    handle: "demo",
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
  fetchWorkspace.mockReset();
  fetchRoster.mockReset();
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
  localStorage.clear();
  clearSession();
  vi.unstubAllGlobals();
  clearOwnerOnboardingPending();
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

describe("App: 시드 이름 그대로인 소유자는 저장소가 비어도 S1을 다시 받는다 (#3696)", () => {
  // 파일의 첫 마운트는 App 모듈 그래프 전체를 처음 읽어 와서 기본 5초 한도에 아슬아슬하다
  // (#3893 전 base 에서도 4.8~5.0초). 기능 회귀가 아니라 콜드 임포트 비용이라 한도만 넉넉히 둔다.
  it("서버 이름이 시드이고 내가 @demo 소유자면 S1이 선다", async () => {
    applyLogin(session);
    fetchWorkspace.mockResolvedValue({ name: "momo Demo Workspace" });
    fetchRoster.mockResolvedValue([{ id: session.member.id, role: "owner" }]);
    const host = await mountApp();
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="owner-onboarding"]')).not.toBeNull();
    });  }, 30_000);

  it("이미 이름을 정했으면 S1이 서지 않는다", async () => {
    applyLogin(session);
    fetchWorkspace.mockResolvedValue({ name: "새벽팀" });
    fetchRoster.mockResolvedValue([{ id: session.member.id, role: "owner" }]);
    const host = await mountApp();
    await vi.waitFor(() => expect(fetchWorkspace).toHaveBeenCalled());
    expect(fetchRoster).not.toHaveBeenCalled();
    await act(async () => {
      await Promise.resolve();
    });
    expect(host.querySelector('[data-testid="owner-onboarding"]')).toBeNull();
  });
});

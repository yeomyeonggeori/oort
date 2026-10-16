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

beforeAll(async () => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  // 이 파일의 첫 마운트는 `./App` 모듈 그래프 전체를 처음 읽어 온다(콜드 임포트). 그 값은 기능이
  // 아니라 그래프의 크기이고 부하에 비례한다 — 실측: 첫 시험 1.5~1.7s(유휴), 54개 CPU 소비자
  // 아래 2.5~3.2s, 병합 트리 게이트에서는 4.8~5.0s(#3893). 시험 안에서 읽으면 시험의 5s 가
  // 그 값을 지는데, 여기서 읽으면 시험은 마운트 이후의 동작만 잰다. 훅 한도 60s 는 성능 예산이
  // 아니라 멈춤 감지용(유휴 실측의 ~35배)이다.
  await import("./App");
}, 60_000);

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
  it("서버 이름이 시드이고 내가 @demo 소유자면 S1이 선다", async () => {
    applyLogin(session);
    fetchWorkspace.mockResolvedValue({ name: "momo Demo Workspace" });
    fetchRoster.mockResolvedValue([{ id: session.member.id, role: "owner" }]);
    const host = await mountApp();
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="owner-onboarding"]')).not.toBeNull();
    });
  });

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

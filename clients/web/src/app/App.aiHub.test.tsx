// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { LoginResponse } from "@momo/core/lib/api";
import { applyLogin, clearSession } from "@/lib/session";
import { clearPhoneLinkCardForTests } from "@/features/welcome/phoneLinkCardStore";

const restoreSession = vi.hoisted(() => vi.fn());
// 셸이 몇 번 마운트되었는가(#2893). 재진입을 열고 닫는 동안 셸이 내려가면 실시간
// 연결이 두 번 끊기고 도크·서랍 상태가 사라진다.
const shellMounts = vi.hoisted(() => ({ count: 0 }));

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
  const { createElement: h, useEffect } = await import("react");
  const { Outlet } = await import("react-router-dom");
  return {
    AppShell: () => {
      useEffect(() => {
        shellMounts.count += 1;
      }, []);
      return h("div", { "data-testid": "app-shell" }, h(Outlet));
    },
  };
});

// 허브 본문은 AiHubRoute.test 가 잰다. 여기서는 App 이 /ai/* 주소를 허브로 세우는지만 본다.
vi.mock("@/features/aiHub/AiHubRoute", async () => {
  const { createElement: h } = await import("react");
  const { useLocation } = await import("react-router-dom");
  return {
    AiHubRoute: () => h("div", { "data-testid": "ai-hub-route-stub" }, useLocation().pathname),
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
  shellMounts.count = 0;
  sessionStorage.clear();
  clearPhoneLinkCardForTests(session.member.workspaceId);
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
  clearPhoneLinkCardForTests(session.member.workspaceId);
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

// 첫 테스트가 App 모듈 그래프를 처음 불러와 몇 초가 걸린다.
describe("App: /ai 라우트 (AIH-3, #3393)", { timeout: 20_000 }, () => {
  it.each(["/ai", "/ai/accounts", "/ai/team-keys", "/ai/agents", "/ai/external"])(
    "#%s 는 허브를 세우고 대화(홈)로 튕기지 않는다",
    async (path) => {
      applyLogin(session);
      window.history.replaceState(null, "", `/#${path}`);
      const host = await mountApp();
      await vi.waitFor(() => {
        expect(host.querySelector('[data-testid="ai-hub-route-stub"]')?.textContent).toBe(path);
      });
      expect(host.querySelector('[data-testid="channel-list"]')).toBeNull();
    }
  );
});

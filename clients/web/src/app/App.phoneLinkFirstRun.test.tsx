// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { LoginResponse } from "@momo/core/lib/api";
import { applyLogin, clearSession } from "@/lib/session";
import {
  clearPhoneLinkCardForTests,
  markPhoneLinkCardPending,
  readPhoneLinkCard,
} from "@/features/welcome/phoneLinkCardStore";

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

// =============================================================================
// #2818 (ADR-0193 D7): 폰 연결은 로그인 뒤 전체 화면 단계가 아니다.
// 예전 App 은 phone pending 이면 `PhoneLinkFirstRun`(onboarding-phone-link)을
// 세워 셸을 막았다. 이제는 셸이 곧장 서고, pending 은 첫 대화 채널 카드가
// 읽도록 저장소에 그대로 남는다.
// =============================================================================
describe("App: 폰 연결은 게이트 단계가 아니다 (#2818)", () => {
  it("폰 카드가 pending 이어도 로그인 뒤 셸이 곧장 선다", async () => {
    applyLogin(session);
    markPhoneLinkCardPending(session.member.workspaceId);
    const host = await mountApp();
    expect(host.querySelector('[data-testid="onboarding-phone-link"]')).toBeNull();
    expect(host.querySelector('[data-testid="onboarding-step-chrome"]')).toBeNull();
    expect(host.querySelector('[data-testid="channel-list"]')).not.toBeNull();
    // 셸이 섰다고 카드 상태를 지우지 않는다. 카드는 채널이 그린다.
    expect(readPhoneLinkCard(session.member.workspaceId)).toBe("pending");
  });
});

// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { LoginResponse } from "@momo/core/lib/api";
import { applyLogin, clearSession } from "@/lib/session";
import { clearPhoneLinkCardForTests } from "@/features/welcome/phoneLinkCardStore";
import { readFirstAgentMarker } from "@/features/welcome/firstAgentStore";

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

// 화면 자체는 FirstAgentStage.test 가 잰다. 여기서는 App 이 어느 모드로 세우고
// 닫으면 셸로 돌아가는지만 본다.
vi.mock("@/features/welcome/FirstAgentStage", async () => {
  const { createElement: h } = await import("react");
  return {
    FirstAgentStage: (props: {
      mode?: string;
      reentryFrom?: string;
      onContinue: () => void;
    }) =>
      h(
        "div",
        {
          "data-testid": "first-agent-stage",
          "data-mode": props.mode,
          "data-from": props.reentryFrom,
        },
        h(
          "button",
          {
            type: "button",
            "data-testid": "stage-close",
            onClick: () => {
              window.location.hash = "#/";
              props.onContinue();
            },
          },
          "닫기"
        )
      ),
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
// #2870 (RCA 1-b): 온보딩이 끝난 뒤에도 AI 연결 화면을 다시 세운다.
// =============================================================================
// 첫 테스트가 App 모듈 그래프를 처음 불러와 몇 초가 걸린다.
describe("App: AI 연결 재진입 (#2870)", { timeout: 20_000 }, () => {
  it("#/ai-connect 는 온보딩이 끝난 세션에서도 재진입 모드로 화면을 세운다", async () => {
    applyLogin(session);
    window.history.replaceState(null, "", "/#/ai-connect?from=settings");
    const host = await mountApp();
    const stage = host.querySelector('[data-testid="first-agent-stage"]');
    expect(stage?.getAttribute("data-mode")).toBe("reentry");
    expect(stage?.getAttribute("data-from")).toBe("settings");
    expect(host.querySelector('[data-testid="channel-list"]')).toBeNull();
    expect(readFirstAgentMarker(session.member.workspaceId)).toBeNull();
  });

  it("닫으면 셸로 돌아가고, 셸에서 다시 열 수 있다", async () => {
    applyLogin(session);
    window.history.replaceState(null, "", "/#/ai-connect?from=agents");
    const host = await mountApp();
    await act(async () => {
      host.querySelector<HTMLElement>('[data-testid="stage-close"]')?.click();
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="app-shell"]')).not.toBeNull();
    });
    expect(host.querySelector('[data-testid="first-agent-stage"]')).toBeNull();
    await act(async () => {
      window.location.hash = "#/ai-connect?from=agents";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(
        host.querySelector('[data-testid="first-agent-stage"]')?.getAttribute("data-mode")
      ).toBe("reentry");
    });
  });

  it("다른 주소는 셸이다", async () => {
    applyLogin(session);
    window.history.replaceState(null, "", "/#/");
    const host = await mountApp();
    expect(host.querySelector('[data-testid="first-agent-stage"]')).toBeNull();
    expect(host.querySelector('[data-testid="app-shell"]')).not.toBeNull();
  });
});

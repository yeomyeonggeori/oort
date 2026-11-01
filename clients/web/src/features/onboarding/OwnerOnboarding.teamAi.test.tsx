// @vitest-environment jsdom
// #4945: 팀 AI 단계는 S2(초대) 다음의 세 번째 칸이다. 건너뛰어도 되고, 새로고침해도 그 자리로 돌아온다.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { LoginResponse } from "@momo/core/lib/api";
import { OwnerOnboarding } from "./OwnerOnboarding";
import {
  clearOwnerOnboardingPending,
  hasOwnerOnboardingFlag,
  markOwnerOnboardingPending,
  markOwnerOnboardingStage,
  readOwnerOnboardingStage,
} from "./ownerOnboardingStore";

const fetchLink = vi.hoisted(() => vi.fn());
const fetchWorkspace = vi.hoisted(() => vi.fn());
const writes = vi.hoisted(() => ({
  putLink: vi.fn(),
  testLink: vi.fn(),
  putDefaultAi: vi.fn(),
  setSwitch: vi.fn(),
}));

vi.mock("@momo/core/features/settings/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/features/settings/api")>();
  return {
    ...actual,
    fetchProviderLink: () => fetchLink() as Promise<unknown>,
    fetchWorkspace: (...args: unknown[]) => fetchWorkspace(...args) as Promise<unknown>,
    putProviderLink: (...args: unknown[]) => writes.putLink(...args) as Promise<unknown>,
    testProviderLink: () => writes.testLink() as Promise<unknown>,
  };
});
vi.mock("@momo/core/features/settings/defaultAi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/features/settings/defaultAi")>();
  return { ...actual, putProviderDefaultAi: (...args: unknown[]) => writes.putDefaultAi(...args) as Promise<unknown> };
});
vi.mock("@momo/core/features/settings/teamAiSwitch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/features/settings/teamAiSwitch")>();
  return { ...actual, setTeamAiSwitch: (...args: unknown[]) => writes.setSwitch(...args) as Promise<unknown> };
});

const WS = "00000000-0000-7000-8000-000000000001";
const session: LoginResponse = {
  accessToken: "access",
  refreshToken: "refresh",
  member: {
    id: "00000000-0000-7000-8000-000000000101",
    workspaceId: WS,
    kind: "human",
    displayName: "곽성재",
    handle: "seongjae",
  },
  realtimeWebSocketUrl: "wss://example.test/connection/websocket",
};

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root | null = null;
let host: HTMLElement | null = null;

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  clearOwnerOnboardingPending();
  for (const fn of [fetchLink, fetchWorkspace, ...Object.values(writes)]) fn.mockReset();
  fetchLink.mockResolvedValue({
    configured: false,
    keyConfigured: false,
    availability: "mock",
    baseUrl: "",
    endpointLabel: "",
    presets: [],
  });
  fetchWorkspace.mockResolvedValue({
    id: WS,
    slug: "dawn",
    name: "새벽",
    updatedAtMs: 1,
    roleLabels: {},
    welcomeAgentMemberId: null,
    welcomePrompt: "",
  });
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
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  clearOwnerOnboardingPending();
  vi.unstubAllGlobals();
});

function mount(onFinished: () => void): HTMLElement {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    root?.render(
      createElement(QueryClientProvider, {
        client,
        children: createElement(OwnerOnboarding, {
          session,
          replaceSessionMember: vi.fn(),
          onFinished,
        }),
      })
    );
  });
  return host;
}

async function settle() {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function q(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`);
}

async function click(testId: string) {
  const node = q(testId);
  expect(node, testId).not.toBeNull();
  await act(async () => {
    (node as HTMLElement).click();
  });
  await settle();
}

function writeCount(): number {
  return Object.values(writes).reduce((sum, fn) => sum + fn.mock.calls.length, 0);
}

describe("팀 AI 단계는 초대 다음 세 번째 칸이다 (#4945)", () => {
  it("초대를 마치면 팀 AI 단계(5단계 중 4단계)가 서고, 건너뛰면 쓰기 0회로 온보딩이 끝난다", async () => {
    markOwnerOnboardingPending();
    markOwnerOnboardingStage("invite");
    const onFinished = vi.fn();
    mount(onFinished);
    await settle();
    expect(q("onboarding-s2")).not.toBeNull();
    expect(q("onboarding-team-ai")).toBeNull();

    await click("onboarding-s2-skip");
    expect(q("onboarding-team-ai")).not.toBeNull();
    expect(q("onboarding-s2")).toBeNull();
    expect(onFinished).not.toHaveBeenCalled();
    expect(readOwnerOnboardingStage()).toBe("team-ai");
    expect(hasOwnerOnboardingFlag("invite")).toBe(false);
    expect(q("onboarding-dots-label")?.textContent).toBe("5단계 중 4단계");

    await click("onboarding-team-ai-skip");
    expect(onFinished).toHaveBeenCalledTimes(1);
    expect(writeCount()).toBe(0);
  });

  it("팀 AI 단계에서 새로고침해도 그 자리로 돌아오고, 이전 단계는 다시 묻지 않는다", async () => {
    markOwnerOnboardingPending();
    markOwnerOnboardingStage("team-ai");
    expect(readOwnerOnboardingStage()).toBe("team-ai");
    mount(vi.fn());
    await settle();
    expect(q("onboarding-team-ai")).not.toBeNull();
    expect(q("onboarding-s1")).toBeNull();
    expect(q("onboarding-s2")).toBeNull();
  });
});

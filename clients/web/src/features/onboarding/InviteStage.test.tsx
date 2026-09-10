// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CreatedInvite } from "@momo/core/features/settings/api";
import { InviteStage } from "./InviteStage";
import { OwnerOnboarding } from "./OwnerOnboarding";
import { S2_REENTRY } from "./s2Copy";
import type { LoginResponse } from "@momo/core/lib/api";

const createInvite = vi.hoisted(() => vi.fn());

vi.mock("@momo/core/features/settings/api", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@momo/core/features/settings/api")>();
  return {
    ...actual,
    createInvite: (...args: unknown[]) =>
      createInvite(...args) as Promise<CreatedInvite>,
    resolveServerBaseUrl: () => "https://team.example.com",
  };
});

const WS = "00000000-0000-7000-8000-000000000001";
const CODE = "Ab3-_inviteCode99";

const issued: CreatedInvite = {
  code: CODE,
  invite: {
    id: "00000000-0000-7000-8000-000000000201",
    workspaceId: WS,
    codePreview: CODE.slice(-6),
    role: "member",
    maxUses: 1,
    usedCount: 0,
    expiresAtMs: 1_700_000_000_000,
    createdBy: "00000000-0000-7000-8000-000000000101",
    createdAtMs: 1_700_000_000_000,
    updatedAtMs: 1_700_000_000_000,
  },
};

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

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

let mountedRoot: Root | null = null;
let mountedHost: HTMLElement | null = null;

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  createInvite.mockReset();
  createInvite.mockResolvedValue(issued);
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
  vi.stubGlobal("navigator", {
    ...navigator,
    onLine: true,
    clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
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

function wrap(node: ReactElement): ReactElement {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return createElement(QueryClientProvider, { client }, node);
}

function mount(node: ReactElement): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  mountedHost = host;
  mountedRoot = createRoot(host);
  act(() => {
    mountedRoot?.render(wrap(node));
  });
  return host;
}

function click(testId: string) {
  const node = document.querySelector(`[data-testid="${testId}"]`);
  expect(node, testId).not.toBeNull();
  act(() => {
    (node as HTMLElement).click();
  });
}

describe("onboarding S2 팀원 초대 (#2333)", () => {
  it("skip 은 invites POST 를 0회 부른다", async () => {
    const onSkip = vi.fn();
    mount(
      createElement(InviteStage, {
        workspaceId: WS,
        onSkip,
        onContinue: vi.fn(),
      })
    );
    click("onboarding-s2-skip");
    await act(async () => {
      await Promise.resolve();
    });
    expect(createInvite).not.toHaveBeenCalled();
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it("발급은 POST 1회이고 링크를 화면에만 그린다", async () => {
    const onSkip = vi.fn();
    const host = mount(
      createElement(InviteStage, {
        workspaceId: WS,
        onSkip,
        onContinue: vi.fn(),
      })
    );
    await act(async () => {
      click("onboarding-s2-issue");
    });
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="invite-issued"]')).not.toBeNull();
    });
    expect(createInvite).toHaveBeenCalledTimes(1);
    expect(createInvite).toHaveBeenCalledWith(
      WS,
      expect.objectContaining({
        role: "member",
        maxUses: 1,
      })
    );
    const input = createInvite.mock.calls[0]?.[1] as { expiresAtMs: number };
    expect(input.expiresAtMs).toBeGreaterThan(Date.now());
    expect(input.expiresAtMs).toBeLessThanOrEqual(Date.now() + 86_400_000 + 50);
    expect(host.textContent).toContain(CODE);
    expect(host.textContent).toContain("oort://join");
    expect(onSkip).not.toHaveBeenCalled();
  });

  it("카운터는 표에서 온 2/2 이다", () => {
    const host = mount(
      createElement(OwnerOnboarding, {
        session,
        onFinished: vi.fn(),
      })
    );
    const counter = host.querySelector('[data-testid="onboarding-progress"]');
    expect(counter, "progress").not.toBeNull();
    expect(counter?.textContent).toBe("2/2");
  });

  it("탈출구 문장이 재진입 위치를 말한다", () => {
    const host = mount(
      createElement(InviteStage, {
        workspaceId: WS,
        onSkip: vi.fn(),
        onContinue: vi.fn(),
      })
    );
    expect(host.textContent).toContain(S2_REENTRY);
    expect(host.querySelector('[data-testid="onboarding-s2-skip"]')?.textContent).toBe(
      "나중에"
    );
  });
});

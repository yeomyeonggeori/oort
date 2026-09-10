// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type LoginResponse, type Member } from "@momo/core/lib/api";
import type { WorkspaceIdentity } from "@momo/core/features/settings/api";
import { applyLogin, clearSession, getPersistedSession } from "@/lib/session";
import { resetKickoffHoldForTests } from "@/features/welcome/firstRunGate";
import { peekFreshSignup } from "@/features/welcome/freshSignup";
import {
  clearOwnerOnboardingPending,
  hasOwnerOnboardingFlag,
  ownerOnboardingIsPending,
  OWNER_ONBOARDING_KEY,
  resetOwnerOnboardingLoadState,
} from "@/features/onboarding/ownerOnboardingStore";
import { releaseSessionRestore } from "@/features/auth/onboardingSessionHold";

const restoreSession = vi.hoisted(() => vi.fn());
const claimOwnerPassword = vi.hoisted(() => vi.fn());
const fetchWorkspace = vi.hoisted(() => vi.fn());
const renameWorkspace = vi.hoisted(() => vi.fn());
const changeMyProfile = vi.hoisted(() => vi.fn());

vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return {
    ...actual,
    restoreSession: (...args: unknown[]) => restoreSession(...args),
    claimOwnerPassword: (...args: unknown[]) =>
      claimOwnerPassword(...args) as Promise<LoginResponse>,
    changeMyProfile: (...args: unknown[]) =>
      changeMyProfile(...args) as Promise<Member>,
  };
});

vi.mock("@momo/core/features/settings/api", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@momo/core/features/settings/api")>();
  return {
    ...actual,
    fetchWorkspace: (...args: unknown[]) => fetchWorkspace(...args),
    renameWorkspace: (...args: unknown[]) =>
      renameWorkspace(...args) as Promise<WorkspaceIdentity>,
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
    AppShell: (props: { session: LoginResponse }) =>
      h(
        "div",
        { "data-testid": "app-shell" },
        h("span", { "data-testid": "self-name" }, props.session.member.displayName),
        h("span", { "data-testid": "self-handle" }, props.session.member.handle),
        h(Outlet)
      ),
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
  renameWorkspace.mockReset();
  changeMyProfile.mockReset();
  restoreSession.mockImplementation(async () => {
    const persisted = getPersistedSession();
    if (!persisted) return session;
    return {
      ...session,
      member: persisted.member,
      refreshToken: persisted.refreshToken,
      realtimeWebSocketUrl: persisted.realtimeWebSocketUrl,
    };
  });
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
  renameWorkspace.mockResolvedValue({
    id: session.member.workspaceId,
    slug: "dawn",
    name: "새벽",
    updatedAtMs: 2,
    roleLabels: {},
    welcomeAgentMemberId: null,
    welcomePrompt: "",
  });
  changeMyProfile.mockResolvedValue({
    ...session.member,
    displayName: "성재",
    handle: "seongjae",
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

async function submitClaimFrom(host: HTMLElement) {
  await vi.waitFor(() => {
    expect(host.querySelector('[data-testid="claim-submit"]')).not.toBeNull();
  });
  fill("claim-password", PASSWORD);
  fill("claim-confirm", PASSWORD);
  click("claim-submit");
  await vi.waitFor(() => {
    expect(host.querySelector('[data-testid="onboarding-s1"]')).not.toBeNull();
  });
}

async function submitS1() {
  await vi.waitFor(() => {
    expect(
      document.querySelector('[data-testid="onboarding-s1-workspace-name"]')
    ).not.toBeNull();
  });
  fill("onboarding-s1-workspace-name", "새벽");
  fill("onboarding-s1-display-name", "성재");
  fill("onboarding-s1-handle", "seongjae");
  await act(async () => {
    click("onboarding-s1-submit");
  });
  await vi.waitFor(() => {
    expect(document.querySelector('[data-testid="onboarding-s2"]')).not.toBeNull();
  });
}

function unmountApp() {
  act(() => {
    mountedRoot?.unmount();
    mountedRoot = null;
  });
  mountedHost?.remove();
  mountedHost = null;
  resetOwnerOnboardingLoadState();
}

describe("claim → S1 through App restore hold (B-1)", () => {
  it("renders S1 after claim applyLogin instead of the session-restoring skeleton", async () => {
    // A late hold cancels an in-flight restore and parks the skeleton.
    // Keep restore pending so that race cannot "win" and still paint S1.
    restoreSession.mockImplementation(() => new Promise(() => undefined));
    const host = await mountApp();
    await submitClaimFrom(host);
    expect(host.querySelector('[data-testid="onboarding-s1"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="onboarding-progress"]')?.textContent).toBe(
      "1/2"
    );
    expect(host.querySelector('[data-testid="onboarding-s2"]')).toBeNull();
    expect(host.querySelector('[data-testid="session-restoring"]')).toBeNull();
    expect(restoreSession).not.toHaveBeenCalled();
    expect(ownerOnboardingIsPending()).toBe(true);
    expect(hasOwnerOnboardingFlag("workspace-profile")).toBe(true);
  });
});

describe("claim → S1 submit → S2", () => {
  it("calls E1 and E2 once then renders S2 at 2/2", async () => {
    const host = await mountApp();
    await submitClaimFrom(host);
    await vi.waitFor(() => {
      expect(fetchWorkspace).toHaveBeenCalled();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await submitS1();
    expect(renameWorkspace).toHaveBeenCalledTimes(1);
    expect(renameWorkspace).toHaveBeenCalledWith(
      session.member.workspaceId,
      "새벽",
      1
    );
    expect(changeMyProfile).toHaveBeenCalledTimes(1);
    expect(changeMyProfile).toHaveBeenCalledWith(session.member.workspaceId, {
      handle: "seongjae",
      displayName: "성재",
    });
    expect(host.querySelector('[data-testid="onboarding-progress"]')?.textContent).toBe(
      "2/2"
    );
    expect(sessionStorage.getItem(OWNER_ONBOARDING_KEY)).toBe(
      JSON.stringify({ invite: true })
    );
    expect(peekFreshSignup()).toEqual({
      workspaceId: session.member.workspaceId,
      memberId: session.member.id,
    });
  });
});

describe("reload during S1 re-enters S1", () => {
  it("reload during S1 re-enters S1; after S1 a reload re-enters S2", async () => {
    const host = await mountApp();
    await submitClaimFrom(host);
    expect(hasOwnerOnboardingFlag("workspace-profile")).toBe(true);

    unmountApp();

    const reloaded = await mountApp();
    await vi.waitFor(() => {
      expect(reloaded.querySelector('[data-testid="session-restoring"]')).toBeNull();
    });
    expect(reloaded.querySelector('[data-testid="onboarding-s1"]')).not.toBeNull();
    expect(reloaded.querySelector('[data-testid="onboarding-s2"]')).toBeNull();
    expect(reloaded.querySelector('[data-testid="app-shell"]')).toBeNull();

    await vi.waitFor(() => {
      expect(fetchWorkspace).toHaveBeenCalled();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await submitS1();
    expect(reloaded.querySelector('[data-testid="onboarding-s2"]')).not.toBeNull();
    expect(sessionStorage.getItem(OWNER_ONBOARDING_KEY)).toBe(
      JSON.stringify({ invite: true })
    );

    unmountApp();

    const afterS1 = await mountApp();
    await vi.waitFor(() => {
      expect(afterS1.querySelector('[data-testid="session-restoring"]')).toBeNull();
    });
    expect(afterS1.querySelector('[data-testid="onboarding-s2"]')).not.toBeNull();
    expect(afterS1.querySelector('[data-testid="onboarding-s1"]')).toBeNull();

    click("onboarding-s2-skip");
    await vi.waitFor(() => {
      expect(afterS1.querySelector('[data-testid="onboarding-s2"]')).toBeNull();
    });
    expect(ownerOnboardingIsPending()).toBe(false);
    expect(afterS1.querySelector('[data-testid="app-shell"]')).not.toBeNull();
    expect(afterS1.querySelector('[data-testid="self-name"]')?.textContent).toBe(
      "성재"
    );
    expect(afterS1.querySelector('[data-testid="self-handle"]')?.textContent).toBe(
      "seongjae"
    );
    expect(getPersistedSession()?.member.displayName).toBe("성재");
    expect(getPersistedSession()?.member.handle).toBe("seongjae");
  });
});

describe("S1 identity survives into the shell (H-2)", () => {
  it("updates the persisted member so a reload keeps the new name and handle", async () => {
    const host = await mountApp();
    await submitClaimFrom(host);
    await vi.waitFor(() => {
      expect(fetchWorkspace).toHaveBeenCalled();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await submitS1();
    expect(getPersistedSession()?.member.displayName).toBe("성재");
    expect(getPersistedSession()?.member.handle).toBe("seongjae");
    click("onboarding-s2-skip");
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="self-name"]')?.textContent).toBe(
        "성재"
      );
    });
    expect(host.querySelector('[data-testid="self-handle"]')?.textContent).toBe(
      "seongjae"
    );

    unmountApp();
    const reloaded = await mountApp();
    await vi.waitFor(() => {
      expect(reloaded.querySelector('[data-testid="session-restoring"]')).toBeNull();
    });
    expect(reloaded.querySelector('[data-testid="self-name"]')?.textContent).toBe(
      "성재"
    );
    expect(reloaded.querySelector('[data-testid="self-handle"]')?.textContent).toBe(
      "seongjae"
    );
    expect(reloaded.querySelector('[data-testid="onboarding-s1"]')).toBeNull();
  });
});

describe("S1 pending survives S2 skip (H-R2-1)", () => {
  it("non-field failure → skip → S2 skip → remount offers S1 again", async () => {
    renameWorkspace.mockRejectedValue(new ApiError(500, "engine boom"));
    const host = await mountApp();
    await submitClaimFrom(host);
    await vi.waitFor(() => {
      expect(fetchWorkspace).toHaveBeenCalled();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    fill("onboarding-s1-workspace-name", "새벽");
    fill("onboarding-s1-display-name", "성재");
    fill("onboarding-s1-handle", "seongjae");
    await act(async () => {
      click("onboarding-s1-submit");
    });
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="onboarding-s1-skip"]')).not.toBeNull();
    });
    click("onboarding-s1-skip");
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="onboarding-s2"]')).not.toBeNull();
    });
    expect(hasOwnerOnboardingFlag("workspace-profile")).toBe(true);
    click("onboarding-s2-skip");
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="app-shell"]')).not.toBeNull();
    });
    expect(hasOwnerOnboardingFlag("workspace-profile")).toBe(true);
    expect(hasOwnerOnboardingFlag("invite")).toBe(false);

    unmountApp();
    const reloaded = await mountApp();
    await vi.waitFor(() => {
      expect(reloaded.querySelector('[data-testid="session-restoring"]')).toBeNull();
    });
    expect(reloaded.querySelector('[data-testid="onboarding-s1"]')).not.toBeNull();
    expect(reloaded.querySelector('[data-testid="app-shell"]')).toBeNull();
  });
});

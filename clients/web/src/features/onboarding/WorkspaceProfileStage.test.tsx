// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type LoginResponse, type Member } from "@momo/core/lib/api";
import type { WorkspaceIdentity } from "@momo/core/features/settings/api";
import { OwnerOnboarding } from "./OwnerOnboarding";
import { WorkspaceProfileStage } from "./WorkspaceProfileStage";
import { clearFreshSignup, peekFreshSignup } from "@/features/welcome/freshSignup";
import {
  clearOwnerOnboardingPending,
  markOwnerOnboardingPending,
  OWNER_ONBOARDING_KEY,
} from "./ownerOnboardingStore";
import { S1_FAILURE, S1_REENTRY, S1_STALE_RETRY, S1_TITLE } from "./s1Copy";

const renameWorkspace = vi.hoisted(() => vi.fn());
const fetchWorkspace = vi.hoisted(() => vi.fn());
const changeMyHandle = vi.hoisted(() => vi.fn());
const changeMyDisplayName = vi.hoisted(() => vi.fn());

vi.mock("@momo/core/features/settings/api", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@momo/core/features/settings/api")>();
  return {
    ...actual,
    renameWorkspace: (...args: unknown[]) =>
      renameWorkspace(...args) as Promise<WorkspaceIdentity>,
    fetchWorkspace: (...args: unknown[]) => fetchWorkspace(...args),
  };
});

vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return {
    ...actual,
    changeMyHandle: (...args: unknown[]) =>
      changeMyHandle(...args) as Promise<Member>,
    changeMyDisplayName: (...args: unknown[]) =>
      changeMyDisplayName(...args) as Promise<Member>,
  };
});

const WS = "00000000-0000-7000-8000-000000000001";
const UPDATED_AT = 1_700_000_000_123;

const workspace: WorkspaceIdentity = {
  id: WS,
  slug: "dawn",
  name: "새벽",
  updatedAtMs: UPDATED_AT,
  roleLabels: {},
  welcomeAgentMemberId: null,
  welcomePrompt: "",
};

const member: Member = {
  id: "00000000-0000-7000-8000-000000000101",
  workspaceId: WS,
  kind: "human",
  displayName: "데모 사용자",
  handle: "seongjae",
};

const session: LoginResponse = {
  accessToken: "access",
  refreshToken: "refresh",
  member,
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
  clearFreshSignup();
  clearOwnerOnboardingPending();
  markOwnerOnboardingPending();
  renameWorkspace.mockReset();
  fetchWorkspace.mockReset();
  changeMyHandle.mockReset();
  changeMyDisplayName.mockReset();
  fetchWorkspace.mockResolvedValue(workspace);
  renameWorkspace.mockResolvedValue({
    ...workspace,
    name: "새벽",
    updatedAtMs: UPDATED_AT + 1,
  });
  changeMyHandle.mockResolvedValue({ ...member, handle: "seongjae" });
  changeMyDisplayName.mockResolvedValue({ ...member, displayName: "성재" });
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
  });
});

afterEach(() => {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  mountedHost?.remove();
  mountedHost = null;
  clearOwnerOnboardingPending();
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

async function submitFilled(host: HTMLElement) {
  fill("onboarding-s1-workspace-name", "새벽");
  fill("onboarding-s1-display-name", "성재");
  fill("onboarding-s1-handle", "seongjae");
  await act(async () => {
    click("onboarding-s1-submit");
  });
  return host;
}

describe("onboarding S1 내 워크스페이스·내 이름 (#2332)", () => {
  it("renders 1/2 and has no skip", async () => {
    const host = mount(
      createElement(OwnerOnboarding, { session, onFinished: vi.fn() })
    );
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="onboarding-s1"]')).not.toBeNull();
    });
    expect(host.querySelector('[data-testid="onboarding-progress"]')?.textContent).toBe(
      "1/2"
    );
    expect(host.querySelector('[data-testid="onboarding-s1-title"]')?.textContent).toBe(
      S1_TITLE
    );
    expect(host.querySelector('[data-testid="onboarding-s2"]')).toBeNull();
    expect(host.querySelector('[data-testid="onboarding-s1-skip"]')).toBeNull();
    expect(host.textContent).toContain(S1_REENTRY);
    expect(host.textContent).not.toMatch(/팀 규모/);
  });

  it("focuses the stage heading on mount", async () => {
    const host = mount(
      createElement(OwnerOnboarding, { session, onFinished: vi.fn() })
    );
    const heading = host.querySelector('[data-testid="onboarding-s1-title"]');
    expect(heading).not.toBeNull();
    await act(async () => {
      await Promise.resolve();
    });
    expect(document.activeElement).toBe(heading);
  });

  it("submits E1 once with {name, updatedAtMs} and E2 once with handle, then S2", async () => {
    const host = mount(
      createElement(OwnerOnboarding, { session, onFinished: vi.fn() })
    );
    await vi.waitFor(() => {
      expect(fetchWorkspace).toHaveBeenCalled();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await submitFilled(host);
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="onboarding-s2"]')).not.toBeNull();
    });
    expect(renameWorkspace).toHaveBeenCalledTimes(1);
    expect(renameWorkspace).toHaveBeenCalledWith(WS, "새벽", UPDATED_AT);
    expect(changeMyHandle).toHaveBeenCalledTimes(1);
    expect(changeMyHandle).toHaveBeenCalledWith(WS, "seongjae");
    expect(changeMyDisplayName).toHaveBeenCalledTimes(1);
    expect(changeMyDisplayName).toHaveBeenCalledWith(WS, "성재");
    expect(host.querySelector('[data-testid="onboarding-progress"]')?.textContent).toBe(
      "2/2"
    );
    expect(sessionStorage.getItem(OWNER_ONBOARDING_KEY)).toBe("invite");
    expect(peekFreshSignup()).toBeNull();
  });

  it("shows handle 409 inline and does not leave S1", async () => {
    changeMyHandle.mockRejectedValue(new ApiError(409, "handle is already in use"));
    const host = mount(
      createElement(OwnerOnboarding, { session, onFinished: vi.fn() })
    );
    await vi.waitFor(() => {
      expect(fetchWorkspace).toHaveBeenCalled();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await submitFilled(host);
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="onboarding-s1-handle-error"]')).not.toBeNull();
    });
    expect(host.querySelector('[data-testid="onboarding-s1-handle-error"]')?.textContent).toBe(
      "handle is already in use"
    );
    expect(host.querySelector('[data-testid="onboarding-s2"]')).toBeNull();
    expect(sessionStorage.getItem(OWNER_ONBOARDING_KEY)).toBe("workspace-profile");
  });

  it("shows stale 409 retry text after refetch", async () => {
    renameWorkspace.mockRejectedValue(
      new ApiError(409, "workspace has been updated; refetch and retry")
    );
    const host = mount(
      createElement(OwnerOnboarding, { session, onFinished: vi.fn() })
    );
    await vi.waitFor(() => {
      expect(fetchWorkspace).toHaveBeenCalled();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await submitFilled(host);
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="onboarding-s1-stale"]')).not.toBeNull();
    });
    expect(host.textContent).toContain(S1_STALE_RETRY);
    expect(changeMyHandle).not.toHaveBeenCalled();
    expect(host.querySelector('[data-testid="onboarding-s2"]')).toBeNull();
  });

  it("surfaces a 400 as the server sentence", async () => {
    renameWorkspace.mockRejectedValue(
      new ApiError(400, "name must be 1-80 characters")
    );
    const host = mount(
      createElement(WorkspaceProfileStage, {
        workspaceId: WS,
        memberHandle: "seongjae",
        workspaceName: "새벽",
        workspaceUpdatedAtMs: UPDATED_AT,
        onComplete: vi.fn(),
      })
    );
    await submitFilled(host);
    await vi.waitFor(() => {
      expect(
        host.querySelector('[data-testid="onboarding-s1-workspace-error"]')
      ).not.toBeNull();
    });
    expect(
      host.querySelector('[data-testid="onboarding-s1-workspace-error"]')?.textContent
    ).toBe("name must be 1-80 characters");
  });

  it("names the later redo surface on a generic failure", async () => {
    renameWorkspace.mockRejectedValue(new ApiError(500, "engine boom"));
    const host = mount(
      createElement(WorkspaceProfileStage, {
        workspaceId: WS,
        memberHandle: "seongjae",
        workspaceName: "새벽",
        workspaceUpdatedAtMs: UPDATED_AT,
        onComplete: vi.fn(),
      })
    );
    await submitFilled(host);
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="onboarding-s1-error"]')).not.toBeNull();
    });
    expect(host.textContent).toContain(S1_FAILURE);
    expect(host.textContent).toContain("설정 › 워크스페이스 / 프로필");
  });

  it("matches S2 card chrome classes", () => {
    const host = mount(
      createElement(OwnerOnboarding, { session, onFinished: vi.fn() })
    );
    const card = host.querySelector(".max-w-sm");
    expect(card).not.toBeNull();
    expect(card?.className).toMatch(/\bmax-w-sm\b/);
    const heading = host.querySelector('[data-testid="onboarding-s1-title"]');
    expect(heading?.className).toContain("text-title");
    expect(heading?.className).toContain("font-semibold");
    expect(heading?.className).toContain("text-ink");
    expect(heading?.className).toContain("focus-visible:focus-ring");
    const lead = host.querySelector('[data-testid="onboarding-s1"] p');
    expect(lead?.className).toContain("break-keep");
    expect(lead?.className).toContain("text-body");
    expect(lead?.className).toContain("text-ink-muted");
  });

  it("starts the seed workspace name empty", () => {
    const host = mount(
      createElement(WorkspaceProfileStage, {
        workspaceId: WS,
        memberHandle: "demo",
        workspaceName: "momo Demo Workspace",
        workspaceUpdatedAtMs: UPDATED_AT,
        onComplete: vi.fn(),
      })
    );
    const input = host.querySelector(
      '[data-testid="onboarding-s1-workspace-name"]'
    ) as HTMLInputElement | null;
    expect(input?.value).toBe("");
    const handle = host.querySelector(
      '[data-testid="onboarding-s1-handle"]'
    ) as HTMLInputElement | null;
    expect(handle?.value).toBe("demo");
    const display = host.querySelector(
      '[data-testid="onboarding-s1-display-name"]'
    ) as HTMLInputElement | null;
    expect(display?.value).toBe("");
  });
});

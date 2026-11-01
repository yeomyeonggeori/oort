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
import { clearDurableForCurrentAccount, readDurable } from "@/features/onboarding/durableSlot";
import {
  clearOwnerOnboardingPending,
  hasAcceptedSeedWorkspace,
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

// #3100: `vi.waitFor` defaults to a 1000ms ceiling. These are "the UI reaches
// state X" conditions, not "X within N ms" contracts, so under CPU contention
// the ceiling measured the machine. The condition still fails loudly (with its
// own assertion message) if X never happens.
function waitForUi(assertion: () => void) {
  return vi.waitFor(assertion, { timeout: 20_000, interval: 20 });
}
// Keep the per-test ceiling above the waitFor ceiling, otherwise the default
// 5000ms test timeout silently becomes the wall-clock bound again. A test that
// never reaches its state still fails: at waitFor's 20s, with its assertion.
vi.setConfig({ testTimeout: 30_000 });

beforeAll(async () => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  // #3100: the lazy `@/app/App` import graph is the single biggest cost of the
  // file. Charged to the first test it exhausted that test's 5000ms budget
  // under load and cascaded. Pay it in the hook (own 120s budget) instead; the
  // tests still assert the same behaviour with the default per-test timeout.
  await import("@/app/App");
}, 120_000);

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
  await waitForUi(() => {
    expect(host.querySelector('[data-testid="claim-submit"]')).not.toBeNull();
  });
  fill("claim-password", PASSWORD);
  fill("claim-confirm", PASSWORD);
  click("claim-submit");
  await waitForUi(() => {
    expect(host.querySelector('[data-testid="onboarding-s1"]')).not.toBeNull();
  });
}

/** S2 다음은 건너뛸 수 있는 팀 AI 단계다(#4945). 건너뛰면 서버에 쓰지 않고 셸로 간다. */
async function skipTeamAiStage() {
  await waitForUi(() => {
    expect(document.querySelector('[data-testid="onboarding-team-ai-skip"]')).not.toBeNull();
  });
  click("onboarding-team-ai-skip");
}

async function submitS1() {
  await waitForUi(() => {
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
  await waitForUi(() => {
    expect(document.querySelector('[data-testid="onboarding-s2"]')).not.toBeNull();
  });
}

/**
 * claim 직후 서버는 아직 시드 이름이다(S1이 이름을 저장하기 전). 재시작 시험은 그 사실을
 * 서버 값으로 세운다: 서버 이름이 이미 시드가 아니면 이전 실행의 S1 표지는 낡은 것으로
 * 걷힌다(#3714, 성재 결정 2026-10-11).
 */
function serverStillHasSeedName() {
  fetchWorkspace.mockResolvedValue({
    id: session.member.workspaceId,
    slug: "dawn",
    name: "momo Demo Workspace",
    updatedAtMs: 1,
    roleLabels: {},
    welcomeAgentMemberId: null,
    welcomePrompt: "",
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

describe("claim D1″ on the onboarding 2.0 frame (#2811)", () => {
  it("says the question through 코메토 and shows the first of four dots", async () => {
    const host = await mountApp();
    await waitForUi(() => {
      expect(host.querySelector('[data-testid="claim-submit"]')).not.toBeNull();
    });
    expect(host.querySelector('[data-testid="onboarding-frame"]')).not.toBeNull();
    expect(host.querySelector(".brand-lockup")).toBeNull();
    const title = host.querySelector('[data-testid="claim-title"]');
    expect(title?.tagName).toBe("H1");
    expect(title?.textContent).toBe("이 서버의 첫 주인이에요.");
    expect(host.querySelector('[data-testid="kometto-guide-detail"]')?.textContent).toBe(
      "비밀번호를 정해요."
    );
    expect(
      host.querySelector('[data-testid="kometto-guide"]')?.getAttribute("data-expression")
    ).toBe("idle");
    const dots = host.querySelector('[data-testid="onboarding-dots"]');
    expect(dots?.getAttribute("data-total")).toBe("5");
    expect(dots?.getAttribute("data-current")).toBe("1");
    for (const id of ["claim-password", "claim-confirm"]) {
      expect(host.querySelector(`[data-testid="${id}"]`)?.className, id).toContain(
        "onboarding-field"
      );
    }
    expect(host.querySelector('[data-testid="claim-submit"]')?.className).toContain(
      "onboarding-action"
    );
  });
});

describe("claim → S1 through App restore hold (B-1)", () => {
  it("renders S1 after claim applyLogin instead of the session-restoring skeleton", async () => {
    // A late hold cancels an in-flight restore and parks the skeleton.
    // Keep restore pending so that race cannot "win" and still paint S1.
    restoreSession.mockImplementation(() => new Promise(() => undefined));
    const host = await mountApp();
    await submitClaimFrom(host);
    expect(host.querySelector('[data-testid="onboarding-s1"]')).not.toBeNull();
    expect(
      host.querySelector('[data-testid="onboarding-dots"]')?.getAttribute("data-current")
    ).toBe("2");
    expect(
      host.querySelector('[data-testid="onboarding-dots-label"]')?.textContent
    ).toBe("5단계 중 2단계");
    expect(host.querySelector('[data-testid="onboarding-progress"]')).toBeNull();
    expect(host.querySelector('[data-testid="onboarding-s2"]')).toBeNull();
    expect(host.querySelector('[data-testid="session-restoring"]')).toBeNull();
    expect(restoreSession).not.toHaveBeenCalled();
    expect(ownerOnboardingIsPending()).toBe(true);
    expect(hasOwnerOnboardingFlag("workspace-profile")).toBe(true);
  });
});

describe("claim → S1 submit → S2", () => {
  it("calls E1 and E2 once then renders S2 at dot 3 of 5", async () => {
    const host = await mountApp();
    await submitClaimFrom(host);
    await waitForUi(() => {
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
    expect(
      host.querySelector('[data-testid="onboarding-dots"]')?.getAttribute("data-current")
    ).toBe("3");
    expect(
      host.querySelector('[data-testid="onboarding-dots-label"]')?.textContent
    ).toBe("5단계 중 3단계");
    expect(host.querySelector('[data-testid="onboarding-progress"]')).toBeNull();
    expect(readDurable(OWNER_ONBOARDING_KEY)).toBe(
      JSON.stringify({ invite: true, "team-ai": true })
    );
    expect(peekFreshSignup()).toEqual({
      workspaceId: session.member.workspaceId,
      memberId: session.member.id,
    });
  });
});

describe("reload during S1 re-enters S1", () => {
  it("reload during S1 re-enters S1; after S1 a reload re-enters S2", async () => {
    serverStillHasSeedName();
    const host = await mountApp();
    await submitClaimFrom(host);
    expect(hasOwnerOnboardingFlag("workspace-profile")).toBe(true);
    // 첫 질문(claim 직후)에는 「이대로 쓸게요」가 없다: 이름을 정하는 것이 이 화면의 일이다(#3714).
    expect(host.querySelector('[data-testid="onboarding-s1-accept-default"]')).toBeNull();

    serverStillHasSeedName();
    unmountApp();

    const reloaded = await mountApp();
    await waitForUi(() => {
      expect(reloaded.querySelector('[data-testid="session-restoring"]')).toBeNull();
    });
    expect(reloaded.querySelector('[data-testid="onboarding-s1"]')).not.toBeNull();
    expect(reloaded.querySelector('[data-testid="onboarding-s2"]')).toBeNull();
    expect(reloaded.querySelector('[data-testid="app-shell"]')).toBeNull();
    // 재질문(앱을 껐다 켠 뒤)에는 「이대로 쓸게요」가 선다(#3714).
    expect(
      reloaded.querySelector('[data-testid="onboarding-s1-accept-default"]')?.textContent
    ).toBe("이대로 쓸게요");

    await waitForUi(() => {
      expect(fetchWorkspace).toHaveBeenCalled();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await submitS1();
    expect(reloaded.querySelector('[data-testid="onboarding-s2"]')).not.toBeNull();
    expect(readDurable(OWNER_ONBOARDING_KEY)).toBe(
      JSON.stringify({ invite: true, "team-ai": true })
    );

    unmountApp();

    const afterS1 = await mountApp();
    await waitForUi(() => {
      expect(afterS1.querySelector('[data-testid="session-restoring"]')).toBeNull();
    });
    expect(afterS1.querySelector('[data-testid="onboarding-s2"]')).not.toBeNull();
    expect(afterS1.querySelector('[data-testid="onboarding-s1"]')).toBeNull();

    click("onboarding-s2-skip");
    await skipTeamAiStage();
    await waitForUi(() => {
      expect(afterS1.querySelector('[data-testid="onboarding-s2"]')).toBeNull();
    });
    expect(ownerOnboardingIsPending()).toBe(false);
    expect(afterS1.querySelector('[data-testid="app-shell"]')).not.toBeNull();
    expect(afterS1.querySelector('[data-testid="self-name"]')?.textContent).toBe(
      "성재"
    );
    expect(getPersistedSession()?.member.displayName).toBe("성재");
    expect(getPersistedSession()?.member.handle).toBe("seongjae");
  });
});

describe("재질문 S1의 「이대로 쓸게요」 (#3714)", () => {
  it("누르면 셸로 가고, 이 계정·서버에서 다시 묻지 않는다(재시작 뒤에도, 로그아웃해도)", async () => {
    serverStillHasSeedName();
    const host = await mountApp();
    await submitClaimFrom(host);
    serverStillHasSeedName();
    unmountApp();
    const reloaded = await mountApp();
    await waitForUi(() => {
      expect(reloaded.querySelector('[data-testid="onboarding-s1-accept-default"]')).not.toBeNull();
    });
    // 무엇이 그대로 남는지를 이름으로 말한다(H1).
    await waitForUi(() => {
      expect(
        reloaded.querySelector('[data-testid="onboarding-s1-accept"]')?.textContent
      ).toContain("「momo Demo Workspace」 그대로예요");
    });
    // 이름 칸에 글을 쓰기 시작하면 「이대로」가 그 글을 뜻하는 것처럼 읽히므로 숨긴다.
    fill("onboarding-s1-workspace-name", "새벽팀");
    await waitForUi(() => {
      expect(reloaded.querySelector('[data-testid="onboarding-s1-accept-default"]')).toBeNull();
    });
    fill("onboarding-s1-workspace-name", "");
    await waitForUi(() => {
      expect(reloaded.querySelector('[data-testid="onboarding-s1-accept-default"]')).not.toBeNull();
    });
    click("onboarding-s1-accept-default");
    // S2(초대)는 아직 남아 있다: 이름만 이대로 두고 다음 단계로 간다.
    await waitForUi(() => {
      expect(reloaded.querySelector('[data-testid="onboarding-s2"]')).not.toBeNull();
    });
    click("onboarding-s2-skip");
    await skipTeamAiStage();
    await waitForUi(() => {
      expect(reloaded.querySelector('[data-testid="app-shell"]')).not.toBeNull();
    });
    expect(hasOwnerOnboardingFlag("workspace-profile")).toBe(false);
    expect(hasAcceptedSeedWorkspace()).toBe(true);
    // 로그아웃 정리도 이 선택은 지우지 않는다.
    clearDurableForCurrentAccount();
    expect(hasAcceptedSeedWorkspace()).toBe(true);
  });
});

describe("S1 identity survives into the shell (H-2)", () => {
  it("updates the persisted member so a reload keeps the new name and handle", async () => {
    const host = await mountApp();
    await submitClaimFrom(host);
    await waitForUi(() => {
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
    await skipTeamAiStage();
    await waitForUi(() => {
      expect(host.querySelector('[data-testid="self-name"]')?.textContent).toBe(
        "성재"
      );
    });
    expect(getPersistedSession()?.member.handle).toBe("seongjae");

    unmountApp();
    const reloaded = await mountApp();
    await waitForUi(() => {
      expect(reloaded.querySelector('[data-testid="session-restoring"]')).toBeNull();
    });
    expect(reloaded.querySelector('[data-testid="self-name"]')?.textContent).toBe(
      "성재"
    );
    expect(getPersistedSession()?.member.handle).toBe("seongjae");
    expect(reloaded.querySelector('[data-testid="onboarding-s1"]')).toBeNull();
  });
});

describe("S1 pending survives S2 skip (H-R2-1)", () => {
  it("non-field failure → skip → S2 skip → remount offers S1 again", async () => {
    renameWorkspace.mockRejectedValue(new ApiError(500, "engine boom"));
    const host = await mountApp();
    await submitClaimFrom(host);
    await waitForUi(() => {
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
    await waitForUi(() => {
      expect(host.querySelector('[data-testid="onboarding-s1-skip"]')).not.toBeNull();
    });
    click("onboarding-s1-skip");
    await waitForUi(() => {
      expect(host.querySelector('[data-testid="onboarding-s2"]')).not.toBeNull();
    });
    expect(hasOwnerOnboardingFlag("workspace-profile")).toBe(true);
    click("onboarding-s2-skip");
    await skipTeamAiStage();
    await waitForUi(() => {
      expect(host.querySelector('[data-testid="app-shell"]')).not.toBeNull();
    });
    expect(hasOwnerOnboardingFlag("workspace-profile")).toBe(true);
    expect(hasOwnerOnboardingFlag("invite")).toBe(false);

    serverStillHasSeedName();
    unmountApp();
    const reloaded = await mountApp();
    await waitForUi(() => {
      expect(reloaded.querySelector('[data-testid="session-restoring"]')).toBeNull();
    });
    expect(reloaded.querySelector('[data-testid="onboarding-s1"]')).not.toBeNull();
    expect(reloaded.querySelector('[data-testid="app-shell"]')).toBeNull();
  });
});

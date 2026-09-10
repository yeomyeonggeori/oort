// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type LoginResponse, type Member } from "@momo/core/lib/api";
import type { WorkspaceIdentity } from "@momo/core/features/settings/api";
import { OwnerOnboarding } from "./OwnerOnboarding";
import { WorkspaceProfileStage } from "./WorkspaceProfileStage";
import { clearFreshSignup } from "@/features/welcome/freshSignup";
import {
  clearOwnerOnboardingPending,
  hasOwnerOnboardingFlag,
  markOwnerOnboardingPending,
  OWNER_ONBOARDING_KEY,
  readOwnerOnboardingStage,
} from "./ownerOnboardingStore";
import { clearS1Draft, readS1Draft } from "./s1Draft";
import {
  HANDLE_TAKEN_SENTENCE,
  handleFieldError,
  handleSaveMessage,
} from "./identityCopy";
import {
  S1_FAILURE,
  S1_KEEP_MINE,
  S1_KEEP_THEIRS,
  S1_PRIMARY_RETRY,
  S1_REENTRY,
  S1_SKIP_LABEL,
  S1_TITLE,
  s1StaleRetry,
} from "./s1Copy";

const renameWorkspace = vi.hoisted(() => vi.fn());
const fetchWorkspace = vi.hoisted(() => vi.fn());
const changeMyProfile = vi.hoisted(() => vi.fn());
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
    changeMyProfile: (...args: unknown[]) =>
      changeMyProfile(...args) as Promise<Member>,
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
const replaceSessionMember = vi.fn();

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  clearFreshSignup();
  clearOwnerOnboardingPending();
  clearS1Draft();
  markOwnerOnboardingPending();
  replaceSessionMember.mockReset();
  renameWorkspace.mockReset();
  fetchWorkspace.mockReset();
  changeMyProfile.mockReset();
  changeMyHandle.mockReset();
  changeMyDisplayName.mockReset();
  fetchWorkspace.mockResolvedValue(workspace);
  renameWorkspace.mockResolvedValue({
    ...workspace,
    name: "새벽",
    updatedAtMs: UPDATED_AT + 1,
  });
  changeMyProfile.mockResolvedValue({
    ...member,
    handle: "seongjae",
    displayName: "성재",
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
  clearS1Draft();
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

function mountStage(props?: {
  memberHandle?: string;
  onComplete?: () => void;
  onSkip?: () => void;
}) {
  return mount(
    createElement(WorkspaceProfileStage, {
      workspaceId: WS,
      memberHandle: props?.memberHandle ?? "seongjae",
      workspaceName: "새벽",
      workspaceUpdatedAtMs: UPDATED_AT,
      replaceSessionMember,
      onComplete: props?.onComplete ?? vi.fn(),
      onSkip: props?.onSkip,
    })
  );
}

function mountOwner() {
  return mount(
    createElement(OwnerOnboarding, {
      session,
      replaceSessionMember,
      onFinished: vi.fn(),
    })
  );
}

describe("onboarding S1 내 워크스페이스·내 이름 (#2332)", () => {
  it("renders 1/2 and has no skip until a non-field failure", async () => {
    const host = mountOwner();
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
    const host = mountOwner();
    const heading = host.querySelector('[data-testid="onboarding-s1-title"]');
    expect(heading).not.toBeNull();
    await act(async () => {
      await Promise.resolve();
    });
    expect(document.activeElement).toBe(heading);
  });

  it("submits E1 once and E2/E0 as one PATCH, then S2", async () => {
    const host = mountOwner();
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
    expect(changeMyProfile).toHaveBeenCalledTimes(1);
    expect(changeMyProfile).toHaveBeenCalledWith(WS, {
      handle: "seongjae",
      displayName: "성재",
    });
    expect(changeMyHandle).not.toHaveBeenCalled();
    expect(changeMyDisplayName).not.toHaveBeenCalled();
    expect(replaceSessionMember).toHaveBeenCalledTimes(1);
    expect(replaceSessionMember).toHaveBeenCalledWith({
      ...member,
      handle: "seongjae",
      displayName: "성재",
    });
    expect(host.querySelector('[data-testid="onboarding-progress"]')?.textContent).toBe(
      "2/2"
    );
    expect(sessionStorage.getItem(OWNER_ONBOARDING_KEY)).toBe(
      JSON.stringify({ invite: true })
    );
  });

  it("answers a handle 409 in product Korean with the next move", async () => {
    changeMyProfile.mockRejectedValue(new ApiError(409, HANDLE_TAKEN_SENTENCE));
    const host = mountOwner();
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
    const text =
      host.querySelector('[data-testid="onboarding-s1-handle-error"]')?.textContent ??
      "";
    expect(text).toBe("이미 쓰는 핸들이에요. 다른 핸들을 골라주세요.");
    expect(text).toMatch(/다른 핸들/);
    expect(text).not.toMatch(/[A-Za-z]{3,}|HTTP \d+/);
    expect(text).not.toContain(HANDLE_TAKEN_SENTENCE);
    expect(host.querySelector('[data-testid="onboarding-s2"]')).toBeNull();
    expect(hasOwnerOnboardingFlag("workspace-profile")).toBe(true);
    await act(async () => {
      await Promise.resolve();
    });
    expect(document.activeElement).toBe(
      host.querySelector('[data-testid="onboarding-s1-handle"]')
    );
  });

  it("does not re-send E1 after a handle 409 retry", async () => {
    changeMyProfile
      .mockRejectedValueOnce(new ApiError(409, HANDLE_TAKEN_SENTENCE))
      .mockResolvedValueOnce({
        ...member,
        handle: "seongjae2",
        displayName: "성재",
      });
    const host = mountStage({ onComplete: vi.fn() });
    await submitFilled(host);
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="onboarding-s1-handle-error"]')).not.toBeNull();
    });
    expect(renameWorkspace).toHaveBeenCalledTimes(1);
    fill("onboarding-s1-handle", "seongjae2");
    await act(async () => {
      click("onboarding-s1-submit");
    });
    await vi.waitFor(() => {
      expect(changeMyProfile).toHaveBeenCalledTimes(2);
    });
    expect(renameWorkspace).toHaveBeenCalledTimes(1);
  });

  it("shows the other name on a stale 409 and offers keep/save", async () => {
    renameWorkspace.mockRejectedValue(
      new ApiError(409, "workspace has been updated; refetch and retry")
    );
    fetchWorkspace.mockResolvedValue({
      ...workspace,
      name: "다른 기기에서 바꾼 이름",
      updatedAtMs: UPDATED_AT + 9,
    });
    const host = mountOwner();
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
    expect(host.textContent).toContain("다른 기기에서 바꾼 이름");
    expect(host.textContent).toContain(s1StaleRetry("다른 기기에서 바꾼 이름"));
    expect(host.querySelector('[data-testid="onboarding-s1-keep-theirs"]')?.textContent).toBe(
      S1_KEEP_THEIRS
    );
    expect(host.querySelector('[data-testid="onboarding-s1-keep-mine"]')?.textContent).toBe(
      S1_KEEP_MINE
    );
    const filled = [...host.querySelectorAll("button")].filter((button) =>
      button.className.includes("bg-accent")
    );
    expect(filled).toHaveLength(1);
    expect(filled[0]?.textContent).toBe(S1_KEEP_MINE);
    expect(host.querySelector('[data-testid="onboarding-s1-submit"]')).toBeNull();
    expect(host.querySelector('[data-testid="onboarding-s1-keep-theirs"]')?.className).not.toContain(
      "bg-accent"
    );
    expect(
      (host.querySelector(
        '[data-testid="onboarding-s1-workspace-name"]'
      ) as HTMLInputElement).value
    ).toBe("새벽");
    expect(host.querySelector(".whitespace-nowrap")?.className).toContain("break-keep");
    expect(host.querySelector(".whitespace-nowrap")?.textContent).toBe(
      "「다른 기기에서 바꾼 이름」으로"
    );
    expect(changeMyProfile).not.toHaveBeenCalled();
    expect(host.querySelector('[data-testid="onboarding-s2"]')).toBeNull();
    click("onboarding-s1-keep-theirs");
    expect(
      (host.querySelector(
        '[data-testid="onboarding-s1-workspace-name"]'
      ) as HTMLInputElement).value
    ).toBe("다른 기기에서 바꾼 이름");
    expect(document.activeElement).toBe(
      host.querySelector('[data-testid="onboarding-s1-workspace-name"]')
    );
  });

  it("keep-mine retries with the refreshed token and does not drop focus to body", async () => {
    renameWorkspace
      .mockRejectedValueOnce(
        new ApiError(409, "workspace has been updated; refetch and retry")
      )
      .mockResolvedValueOnce({
        ...workspace,
        name: "새벽",
        updatedAtMs: UPDATED_AT + 10,
      });
    fetchWorkspace.mockResolvedValue({
      ...workspace,
      name: "다른 기기에서 바꾼 이름",
      updatedAtMs: UPDATED_AT + 9,
    });
    const host = mountOwner();
    await vi.waitFor(() => {
      expect(fetchWorkspace).toHaveBeenCalled();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await submitFilled(host);
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="onboarding-s1-keep-mine"]')).not.toBeNull();
    });
    await act(async () => {
      click("onboarding-s1-keep-mine");
    });
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="onboarding-s2"]')).not.toBeNull();
    });
    expect(renameWorkspace).toHaveBeenLastCalledWith(WS, "새벽", UPDATED_AT + 9);
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(
      host.querySelector('[data-testid="onboarding-s2-title"]')
    );
  });

  it("maps a workspace 400 to Korean and does not render the wire sentence", async () => {
    renameWorkspace.mockRejectedValue(
      new ApiError(400, "workspace name must be 1-80 characters")
    );
    const host = mountStage();
    await submitFilled(host);
    await vi.waitFor(() => {
      expect(
        host.querySelector('[data-testid="onboarding-s1-workspace-error"]')
      ).not.toBeNull();
    });
    const text =
      host.querySelector('[data-testid="onboarding-s1-workspace-error"]')
        ?.textContent ?? "";
    expect(text).toBe("이름은 1~80자예요. 다시 입력해 주세요.");
    expect(text).not.toContain("workspace name must be 1-80 characters");
    expect(text).not.toMatch(/[A-Za-z]{3,}/);
  });

  it("shows retry and skip on a generic failure and keeps the S1 marker", async () => {
    renameWorkspace.mockRejectedValue(new ApiError(500, "engine boom"));
    const host = mount(
      createElement(WorkspaceProfileStage, {
        workspaceId: WS,
        memberHandle: "seongjae",
        workspaceName: "새벽",
        workspaceUpdatedAtMs: UPDATED_AT,
        replaceSessionMember,
        onComplete: vi.fn(),
        onSkip: vi.fn(),
      })
    );
    await submitFilled(host);
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="onboarding-s1-error"]')).not.toBeNull();
    });
    expect(host.textContent).toContain(S1_FAILURE);
    expect(host.textContent).not.toContain("engine boom");
    expect(host.querySelector('[data-testid="onboarding-s1-submit"]')?.textContent).toBe(
      S1_PRIMARY_RETRY
    );
    expect(host.querySelector('[data-testid="onboarding-s1-skip"]')?.textContent).toBe(
      S1_SKIP_LABEL
    );
  });

  it("skip after a non-field failure proceeds to S2 without advancing the marker", async () => {
    renameWorkspace.mockRejectedValue(new ApiError(500, "engine boom"));
    const host = mountOwner();
    await vi.waitFor(() => {
      expect(fetchWorkspace).toHaveBeenCalled();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await submitFilled(host);
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="onboarding-s1-skip"]')).not.toBeNull();
    });
    click("onboarding-s1-skip");
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="onboarding-s2"]')).not.toBeNull();
    });
    expect(readOwnerOnboardingStage()).toBe("workspace-profile");
    expect(hasOwnerOnboardingFlag("workspace-profile")).toBe(true);
    expect(hasOwnerOnboardingFlag("invite")).toBe(true);
  });

  it("keeps aria-busy on the form and does not disable fields while submitting", async () => {
    let resolveRename: ((value: WorkspaceIdentity) => void) | undefined;
    renameWorkspace.mockReturnValue(
      new Promise<WorkspaceIdentity>((resolve) => {
        resolveRename = resolve;
      })
    );
    const host = mountStage();
    fill("onboarding-s1-workspace-name", "새벽");
    fill("onboarding-s1-display-name", "성재");
    fill("onboarding-s1-handle", "seongjae");
    act(() => {
      click("onboarding-s1-submit");
    });
    const form = host.querySelector('[data-testid="onboarding-s1"]');
    expect(form?.getAttribute("aria-busy")).toBe("true");
    const handle = host.querySelector(
      '[data-testid="onboarding-s1-handle"]'
    ) as HTMLInputElement;
    expect(handle.disabled).toBe(false);
    await act(async () => {
      resolveRename?.({ ...workspace, name: "새벽", updatedAtMs: UPDATED_AT + 1 });
    });
  });

  it("matches S2 card chrome classes", () => {
    const host = mountOwner();
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

  it("starts the seed workspace name and seed handle empty", () => {
    const host = mount(
      createElement(WorkspaceProfileStage, {
        workspaceId: WS,
        memberHandle: "demo",
        workspaceName: "momo Demo Workspace",
        workspaceUpdatedAtMs: UPDATED_AT,
        replaceSessionMember,
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
    expect(handle?.value).toBe("");
    const display = host.querySelector(
      '[data-testid="onboarding-s1-display-name"]'
    ) as HTMLInputElement | null;
    expect(display?.value).toBe("");
  });

  it("keeps the typed draft across a remount", () => {
    mountStage();
    fill("onboarding-s1-workspace-name", "여명거리");
    fill("onboarding-s1-display-name", "성재");
    fill("onboarding-s1-handle", "SeongJae");
    expect(readS1Draft()).toEqual({
      workspaceName: "여명거리",
      displayName: "성재",
      handle: "SeongJae",
    });
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
    const remounted = mountStage();
    expect(
      (remounted.querySelector(
        '[data-testid="onboarding-s1-workspace-name"]'
      ) as HTMLInputElement).value
    ).toBe("여명거리");
    expect(
      (remounted.querySelector(
        '[data-testid="onboarding-s1-display-name"]'
      ) as HTMLInputElement).value
    ).toBe("성재");
    expect(
      (remounted.querySelector('[data-testid="onboarding-s1-handle"]') as HTMLInputElement)
        .value
    ).toBe("SeongJae");
    expect(remounted.querySelector('[data-testid="onboarding-s1-handle-preview"]')?.textContent).toBe(
      "저장되는 핸들 @seongjae"
    );
  });

  it("focuses the first invalid field in DOM order", async () => {
    const host = mountStage();
    fill("onboarding-s1-workspace-name", "");
    fill("onboarding-s1-display-name", "");
    fill("onboarding-s1-handle", "");
    await act(async () => {
      click("onboarding-s1-submit");
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(document.activeElement).toBe(
      host.querySelector('[data-testid="onboarding-s1-workspace-name"]')
    );
  });
});

describe("S1 handle copy (H-1)", () => {
  it("uses product Korean for a bad handle and never the wire sentence", () => {
    expect(handleFieldError("!")).toBe(
      "핸들은 영문 소문자·숫자·하이픈 2~32자예요."
    );
    expect(handleFieldError("!")).not.toMatch(/handle must|a-z/);
    expect(handleFieldError("seongjae")).toBeNull();
    expect(handleSaveMessage(new ApiError(409, HANDLE_TAKEN_SENTENCE))).toBe(
      "이미 쓰는 핸들이에요. 다른 핸들을 골라주세요."
    );
    expect(
      handleSaveMessage(new ApiError(409, HANDLE_TAKEN_SENTENCE))
    ).not.toContain(HANDLE_TAKEN_SENTENCE);
  });

  it("attaches 로/으로 from directionParticle and does not hard-code 으로", () => {
    expect(s1StaleRetry("여명거리 스튜디오")).toBe(
      "워크스페이스 이름이 「여명거리 스튜디오」로 바뀌었습니다."
    );
    expect(s1StaleRetry("다른 기기에서 바꾼 이름")).toBe(
      "워크스페이스 이름이 「다른 기기에서 바꾼 이름」으로 바뀌었습니다."
    );
  });
});

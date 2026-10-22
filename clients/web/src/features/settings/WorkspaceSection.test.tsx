// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type RosterMember } from "@momo/core/lib/api";
import type { RoleLabels } from "@momo/core/features/directory/model";
import { DEFAULT_ROLE_LABELS } from "@momo/core/features/directory/model";
import { roleLabelsSaveMessage } from "@momo/core/features/settings/model";
import type { WorkspaceIdentity } from "@momo/core/features/settings/api";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { workspaceIdentityKey } from "@/features/workspace/useWorkspace";
import {
  NEW_WORKSPACE_ENTRY_GUIDE,
  NEW_WORKSPACE_ENTRY_TEXT,
  NEW_WORKSPACE_ID_ONCE_NOTICE,
} from "@/features/auth/loginWorkspaceEntry";
import { escapeIsClaimed } from "@/design/ui/escapeLayer";
import { WorkspaceSection } from "./WorkspaceSection";
import {
  clearOwnerOnboardingPending,
  hasOwnerOnboardingSettingsDoor,
  markOwnerOnboardingPending,
} from "@/features/onboarding/ownerOnboardingStore";
import { chooseListbox } from "@/design/ui/listboxTestKit";

const WS = "00000000-0000-7000-8000-000000000001";
const MEMBER_ID = "00000000-0000-7000-8000-000000000101";
const AGENT_ID = "00000000-0000-7000-8000-000000000201";
const WS_TOKEN = 1_700_000_000_123;

const patchWorkspaceSettings = vi.hoisted(() => vi.fn());
const renameWorkspace = vi.hoisted(() => vi.fn());
const fetchWorkspace = vi.hoisted(() => vi.fn());
const createWorkspaceMock = vi.hoisted(() => vi.fn());

vi.mock("@momo/core/features/settings/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/features/settings/api")>();
  return {
    ...actual,
    patchWorkspaceSettings: (
      workspaceId: string,
      body: {
        role_labels?: RoleLabels | null;
        welcome_agent_member_id?: string | null;
        welcome_prompt?: string;
      }
    ) => patchWorkspaceSettings(workspaceId, body) as Promise<unknown>,
    renameWorkspace: (...args: unknown[]) =>
      renameWorkspace(...args) as Promise<WorkspaceIdentity>,
    fetchWorkspace: (...args: unknown[]) => fetchWorkspace(...args),
    createWorkspace: (...args: unknown[]) => createWorkspaceMock(...args) as Promise<unknown>,
  };
});

const fetchWorkspaceUnfurlSettings = vi.hoisted(() => vi.fn());
const updateWorkspaceUnfurlSettings = vi.hoisted(() => vi.fn());

vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return {
    ...actual,
    fetchWorkspaceUnfurlSettings: (...args: unknown[]) =>
      fetchWorkspaceUnfurlSettings(...args) as Promise<unknown>,
    updateWorkspaceUnfurlSettings: (...args: unknown[]) =>
      updateWorkspaceUnfurlSettings(...args) as Promise<unknown>,
  };
});

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let mountedRoot: Root | null = null;
let mountedHost: HTMLElement | null = null;

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  patchWorkspaceSettings.mockReset();
  renameWorkspace.mockReset();
  fetchWorkspace.mockReset();
  createWorkspaceMock.mockReset();
  fetchWorkspaceUnfurlSettings.mockReset();
  updateWorkspaceUnfurlSettings.mockReset();
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
  clearOwnerOnboardingPending();
  vi.unstubAllGlobals();
});

function agentMember(): RosterMember {
  return {
    id: AGENT_ID,
    workspaceId: WS,
    kind: "agent",
    status: "active",
    displayName: "김인턴",
    handle: "kim-intern",
    role: "member",
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  };
}

function rosterMember(role: RosterMember["role"]): RosterMember {
  return {
    id: MEMBER_ID,
    workspaceId: WS,
    kind: "human",
    status: "active",
    displayName: "곽성재",
    handle: "seongjae",
    role,
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  };
}

function sessionValue(): SessionContextValue {
  return {
    session: {
      accessToken: "access",
      refreshToken: "refresh",
      member: {
        id: MEMBER_ID,
        workspaceId: WS,
        kind: "human",
        displayName: "곽성재",
        handle: "seongjae",
      },
      realtimeWebSocketUrl: "wss://example.test/connection/websocket",
    },
    workspaceId: WS,
    realtime: null,
    connStatus: "connected",
    logout: () => undefined,
    replaceSessionMember: () => undefined,
  };
}

function workspace(labels: RoleLabels): WorkspaceIdentity {
  return {
    id: WS,
    slug: "dawn",
    name: "새벽팀",
    updatedAtMs: WS_TOKEN,
    roleLabels: labels,
    welcomeAgentMemberId: null,
    welcomePrompt: "",
    subscriptionAgentsEnabled: false,
  };
}

function setInputValue(input: HTMLInputElement, value: string) {
  const descriptor = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value"
  );
  descriptor?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function mountSection(options: {
  role: RosterMember["role"];
  labels?: RoleLabels;
  offline?: boolean;
  /** true면 링크 확인 설정을 캐시에 미리 두지 않고 mock 질의가 답하게 한다. */
  liveUnfurl?: boolean;
  /** true면 워크스페이스 본체를 캐시에 두지 않아 읽는 중 상태를 본다. */
  loading?: boolean;
}): HTMLElement {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  if (options.loading) {
    fetchWorkspace.mockReturnValue(new Promise(() => undefined));
  } else {
    client.setQueryData(workspaceIdentityKey(WS), workspace(options.labels ?? {}));
  }
  client.setQueryData(["roster", WS], [
    rosterMember(options.role),
    agentMember(),
  ]);
  if (!options.liveUnfurl) {
    client.setQueryData(["settings", "workspace-unfurls", WS], {
      enabled: true,
    });
  }

  const host = document.createElement("div");
  document.body.append(host);
  mountedHost = host;
  mountedRoot = createRoot(host);
  const tree: ReactElement = createElement(
    QueryClientProvider,
    { client },
    createElement(
      SessionProvider,
      { value: sessionValue() },
      createElement(WorkspaceSection, { workspaceId: WS, offline: options.offline ?? false })
    )
  );
  act(() => mountedRoot?.render(tree));
  return host;
}

async function saveOwnerLabel(host: HTMLElement): Promise<HTMLButtonElement> {
  const owner = host.querySelector(
    '[data-testid="role-label-owner"]'
  ) as HTMLInputElement | null;
  expect(owner).not.toBeNull();
  act(() => setInputValue(owner!, "마스터"));
  const save = host.querySelector(
    '[data-testid="workspace-role-labels-save"]'
  ) as HTMLButtonElement | null;
  expect(save).not.toBeNull();
  await act(async () => {
    save?.click();
  });
  return save!;
}

async function waitForSaveSettled(save: HTMLButtonElement) {
  await vi.waitFor(() => {
    expect(save.textContent).not.toContain("저장 중");
  });
}

describe("RoleLabelsEditor 403 고지", () => {
  it("세션 중 강등된 운영자의 저장 403을 OperatorNotice로 보여 준다", async () => {
    const denied = new ApiError(403, "operator required");
    patchWorkspaceSettings.mockRejectedValue(denied);
    const host = mountSection({ role: "admin" });
    const save = await saveOwnerLabel(host);
    await waitForSaveSettled(save);

    const notice = host.querySelector('[data-testid="operator-notice"]');
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toContain(roleLabelsSaveMessage(denied));
    expect(host.querySelector('[data-testid="workspace-role-labels-save-error"]')).toBeNull();
  });

  it("403 뒤 재시도 pending 중에는 실패 고지가 없다", async () => {
    const denied = new ApiError(403, "operator required");
    patchWorkspaceSettings
      .mockRejectedValueOnce(denied)
      .mockImplementationOnce(() => new Promise(() => undefined));
    const host = mountSection({ role: "admin" });
    const save = await saveOwnerLabel(host);
    await waitForSaveSettled(save);
    expect(host.querySelector('[data-testid="operator-notice"]')).not.toBeNull();

    await act(async () => {
      save.click();
    });

    expect(save.textContent).toContain("저장 중");
    expect(host.querySelector('[data-testid="operator-notice"]')).toBeNull();
    expect(host.querySelector('[data-testid="workspace-role-labels-save-error"]')).toBeNull();
  });

  it("403 뒤 500은 danger 인라인으로 보여 준다", async () => {
    const denied = new ApiError(403, "operator required");
    const serverError = new ApiError(500, "boom");
    patchWorkspaceSettings
      .mockRejectedValueOnce(denied)
      .mockRejectedValueOnce(serverError);
    const host = mountSection({ role: "admin" });
    const save = await saveOwnerLabel(host);
    await waitForSaveSettled(save);
    await act(async () => {
      save.click();
    });
    await waitForSaveSettled(save);

    expect(host.querySelector('[data-testid="operator-notice"]')).toBeNull();
    const inline = host.querySelector('[data-testid="workspace-role-labels-save-error"]');
    expect(inline).not.toBeNull();
    expect(inline?.textContent).toContain(roleLabelsSaveMessage(serverError));
  });
});

describe("RoleLabelsEditor 비운영자 읽기", () => {
  it("멤버에게 감쇠 입력 대신 유효 표시명을 전 대비로 보여 준다", () => {
    const host = mountSection({
      role: "member",
      labels: { owner: "마스터" },
    });
    const panel = host.querySelector('[data-testid="workspace-role-labels"]');
    expect(panel).not.toBeNull();
    expect(panel?.querySelector("input")).toBeNull();
    expect(panel?.textContent).toContain("마스터");
    expect(panel?.textContent).toContain(DEFAULT_ROLE_LABELS.admin);
    expect(host.querySelector('[data-testid="operator-notice"]')?.textContent).toContain(
      "소유자와 관리자만"
    );
  });
});

function setTextareaValue(textarea: HTMLTextAreaElement, value: string) {
  const descriptor = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value"
  );
  descriptor?.set?.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("WelcomeKickoffEditor (#1800 패턴)", () => {
  it("save round trip sends only welcome_agent_member_id and welcome_prompt", async () => {
    patchWorkspaceSettings.mockResolvedValue({});
    const host = mountSection({ role: "owner" });
    const select = host.querySelector(
      '[data-testid="welcome-agent"]'
    ) as HTMLElement | null;
    const prompt = host.querySelector(
      '[data-testid="welcome-prompt"]'
    ) as HTMLTextAreaElement | null;
    expect(select).not.toBeNull();
    expect(prompt).not.toBeNull();
    expect(select!.getAttribute("role")).toBe("combobox");
    chooseListbox(select, AGENT_ID);
    act(() => {
      setTextareaValue(prompt!, "직접 편집한 프롬프트");
    });
    const save = host.querySelector(
      '[data-testid="workspace-welcome-save"]'
    ) as HTMLButtonElement | null;
    expect(save).not.toBeNull();
    await act(async () => {
      save?.click();
    });
    await vi.waitFor(() => {
      expect(patchWorkspaceSettings).toHaveBeenCalled();
    });
    expect(patchWorkspaceSettings.mock.calls[0][1]).toEqual({
      welcome_agent_member_id: AGENT_ID,
      welcome_prompt: "직접 편집한 프롬프트",
    });
    expect(patchWorkspaceSettings.mock.calls[0][1]).not.toHaveProperty("role_labels");
  });

  it("2001 characters is a sentence rejection and no PATCH", async () => {
    const host = mountSection({ role: "owner" });
    const prompt = host.querySelector(
      '[data-testid="welcome-prompt"]'
    ) as HTMLTextAreaElement | null;
    expect(prompt).not.toBeNull();
    expect(prompt?.getAttribute("maxLength")).toBeNull();
    act(() => {
      setTextareaValue(prompt!, "가".repeat(2002));
    });
    expect(prompt?.value.length).toBe(2002);
    expect(host.textContent).toContain("2000자까지 쓸 수 있어요.");
    expect(host.textContent?.split("2000자까지 쓸 수 있어요.").length - 1).toBe(1);
    const save = host.querySelector(
      '[data-testid="workspace-welcome-save"]'
    ) as HTMLButtonElement | null;
    expect(save?.getAttribute("aria-disabled")).toBe("true");
    await act(async () => {
      save?.click();
    });
    expect(patchWorkspaceSettings).not.toHaveBeenCalled();
  });

  it("server 400 surfaces the banner sentence", async () => {
    const denied = new ApiError(400, "welcome_prompt must be at most 2000 characters");
    patchWorkspaceSettings.mockRejectedValue(denied);
    const host = mountSection({ role: "owner" });
    const prompt = host.querySelector(
      '[data-testid="welcome-prompt"]'
    ) as HTMLTextAreaElement | null;
    act(() => {
      setTextareaValue(prompt!, "짧은 프롬프트");
    });
    const save = host.querySelector(
      '[data-testid="workspace-welcome-save"]'
    ) as HTMLButtonElement | null;
    await act(async () => {
      save?.click();
    });
    await vi.waitFor(() => {
      const error = host.querySelector('[data-testid="workspace-welcome-save-error"]');
      expect(error?.textContent).toContain("welcome_prompt must be at most 2000 characters");
      expect(error?.getAttribute("role")).toBe("alert");
      expect(error?.className).toContain("text-meta");
      expect(error?.className).toContain("text-danger");
    });
  });

  it("non-operator sees no editor", () => {
    const host = mountSection({ role: "member" });
    expect(host.querySelector('[data-testid="welcome-agent"]')).toBeNull();
    expect(host.querySelector('[data-testid="welcome-prompt"]')).toBeNull();
    expect(host.querySelector('[data-testid="workspace-welcome-save"]')).toBeNull();
    expect(
      host.querySelector('[data-testid="workspace-welcome-kickoff"]')?.textContent
    ).toContain("기본값 (첫 활성 에이전트)");
  });
});

describe("워크스페이스 이름 E1", () => {
  it("초기 이름 칸은 aria-invalid 속성이 없다 (N-R2-1)", () => {
    const host = mountSection({ role: "owner" });
    const input = host.querySelector('[data-testid="workspace-rename-name"]');
    expect(input).not.toBeNull();
    expect(input?.hasAttribute("aria-invalid")).toBe(false);
    expect(input?.getAttribute("aria-invalid")).toBeNull();
  });

  it("소유자는 이름 저장이 E1 PATCH 1회이다", async () => {
    renameWorkspace.mockResolvedValue({
      ...workspace({}),
      name: "여명거리",
      updatedAtMs: 2,
    });
    const host = mountSection({ role: "owner" });
    const input = host.querySelector(
      '[data-testid="workspace-rename-name"]'
    ) as HTMLInputElement | null;
    expect(input).not.toBeNull();
    act(() => setInputValue(input!, "여명거리"));
    await act(async () => {
      (
        host.querySelector(
          '[data-testid="workspace-rename-save"]'
        ) as HTMLButtonElement
      ).click();
    });
    await vi.waitFor(() => {
      expect(renameWorkspace).toHaveBeenCalledTimes(1);
    });
    expect(renameWorkspace).toHaveBeenCalledWith(WS, "여명거리", WS_TOKEN);
  });

  it("이름 저장은 pending S1 워크스페이스 문을 기록한다 (M-R3-5)", async () => {
    markOwnerOnboardingPending();
    renameWorkspace.mockResolvedValue({
      ...workspace({}),
      name: "여명거리",
      updatedAtMs: 2,
    });
    const host = mountSection({ role: "owner" });
    const input = host.querySelector(
      '[data-testid="workspace-rename-name"]'
    ) as HTMLInputElement;
    act(() => setInputValue(input, "여명거리"));
    await act(async () => {
      (
        host.querySelector(
          '[data-testid="workspace-rename-save"]'
        ) as HTMLButtonElement
      ).click();
    });
    await vi.waitFor(() => {
      expect(renameWorkspace).toHaveBeenCalledTimes(1);
    });
    expect(hasOwnerOnboardingSettingsDoor("workspace")).toBe(true);
  });

  it("409는 초안을 유지하고 S1과 같은 stale 조각을 그린다", async () => {
    renameWorkspace.mockRejectedValue(
      new ApiError(409, "workspace has been updated; refetch and retry")
    );
    fetchWorkspace.mockResolvedValue({
      ...workspace({}),
      name: "다른 기기에서 바꾼 이름",
      updatedAtMs: 9,
    });
    const host = mountSection({ role: "owner" });
    const input = host.querySelector(
      '[data-testid="workspace-rename-name"]'
    ) as HTMLInputElement;
    act(() => setInputValue(input, "여명거리"));
    await act(async () => {
      (
        host.querySelector(
          '[data-testid="workspace-rename-save"]'
        ) as HTMLButtonElement
      ).click();
    });
    await vi.waitFor(() => {
      expect(fetchWorkspace).toHaveBeenCalled();
    });
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="workspace-rename-stale"]')).not.toBeNull();
    });
    expect(
      (host.querySelector(
        '[data-testid="workspace-rename-name"]'
      ) as HTMLInputElement).value
    ).toBe("여명거리");
    expect(host.textContent).toContain("다른 기기에서 바꾼 이름");
    expect(host.querySelector('[data-testid="workspace-rename-keep-theirs"]')?.textContent).toBe(
      "이 이름으로 유지"
    );
    expect(host.querySelector('[data-testid="workspace-rename-keep-mine"]')?.textContent).toBe(
      "내 이름으로 저장"
    );
    const filled = [...host.querySelectorAll('[data-testid="workspace-rename"] button')].filter(
      (button) => button.className.includes("bg-primary")
    );
    expect(filled).toHaveLength(1);
    expect(filled[0]?.textContent).toBe("내 이름으로 저장");
    expect(host.querySelector('[data-testid="workspace-rename-save"]')).toBeNull();
    expect(
      host.querySelector('[data-testid="workspace-rename-name"]')?.getAttribute("aria-describedby")
    ).toContain("workspace-rename-stale-message");
    expect(host.querySelector('[data-testid="stale-name-particle"]')?.textContent).toBe(
      "」으로"
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(document.activeElement).not.toBe(document.body);
    expect(
      document.activeElement?.querySelector('[data-testid="workspace-rename-stale"]')
    ).not.toBeNull();
    act(() => {
      (
        host.querySelector(
          '[data-testid="workspace-rename-keep-theirs"]'
        ) as HTMLButtonElement
      ).click();
    });
    expect(
      (host.querySelector(
        '[data-testid="workspace-rename-name"]'
      ) as HTMLInputElement).value
    ).toBe("다른 기기에서 바꾼 이름");
    expect(document.activeElement).toBe(
      host.querySelector('[data-testid="workspace-rename-name"]')
    );
  });

  it("내 이름으로 저장은 refetch한 토큰으로 초안을 다시 보낸다", async () => {
    renameWorkspace
      .mockRejectedValueOnce(
        new ApiError(409, "workspace has been updated; refetch and retry")
      )
      .mockResolvedValueOnce({
        ...workspace({}),
        name: "여명거리",
        updatedAtMs: 11,
      });
    fetchWorkspace.mockResolvedValue({
      ...workspace({}),
      name: "다른 기기에서 바꾼 이름",
      updatedAtMs: 9,
    });
    const host = mountSection({ role: "owner" });
    const input = host.querySelector(
      '[data-testid="workspace-rename-name"]'
    ) as HTMLInputElement;
    act(() => setInputValue(input, "여명거리"));
    await act(async () => {
      (
        host.querySelector(
          '[data-testid="workspace-rename-save"]'
        ) as HTMLButtonElement
      ).click();
    });
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="workspace-rename-keep-mine"]')).not.toBeNull();
    });
    expect(renameWorkspace).toHaveBeenCalledWith(WS, "여명거리", WS_TOKEN);
    await act(async () => {
      (
        host.querySelector(
          '[data-testid="workspace-rename-keep-mine"]'
        ) as HTMLButtonElement
      ).click();
    });
    await vi.waitFor(() => {
      expect(renameWorkspace).toHaveBeenCalledTimes(2);
    });
    expect(renameWorkspace).toHaveBeenLastCalledWith(WS, "여명거리", 9);
    expect(document.activeElement).not.toBe(document.body);
  });
});


const unfurlSwitch = (host: HTMLElement) =>
  host.querySelector('[data-testid="workspace-unfurls"]') as HTMLButtonElement | null;

describe("링크 확인(서버) 스위치 (S5b)", () => {
  it("서버 값을 aria-checked로 말하고 체크박스를 쓰지 않는다", () => {
    const host = mountSection({ role: "owner" });
    const toggle = unfurlSwitch(host);
    expect(toggle?.getAttribute("role")).toBe("switch");
    expect(toggle?.getAttribute("aria-checked")).toBe("true");
    expect(host.querySelector("input[type=checkbox]")).toBeNull();
    expect(host.querySelector('[data-testid="workspace-unfurl-card"]')?.textContent).toContain(
      "링크 확인(서버)"
    );
  });

  it("누르면 반대 값 하나만 PUT하고 저장된 값으로 바뀐다", async () => {
    updateWorkspaceUnfurlSettings.mockResolvedValue({ enabled: false });
    const host = mountSection({ role: "owner" });
    await act(async () => {
      unfurlSwitch(host)?.click();
    });
    await vi.waitFor(() => {
      expect(updateWorkspaceUnfurlSettings).toHaveBeenCalledWith(WS, false);
      expect(unfurlSwitch(host)?.getAttribute("aria-checked")).toBe("false");
    });
  });

  it("GET이 403이면 스위치 대신 운영자 안내가 서고 다시 시도 단추는 없다", async () => {
    fetchWorkspaceUnfurlSettings.mockRejectedValue(new ApiError(403, "operator required"));
    const host = mountSection({ role: "member", liveUnfurl: true });
    await vi.waitFor(() => {
      expect(
        host.querySelector('[data-testid="workspace-unfurl-card"] [data-testid="operator-notice"]')
      ).not.toBeNull();
    });
    expect(unfurlSwitch(host)).toBeNull();
    expect(host.querySelector('[data-testid="workspace-unfurls-error"]')).toBeNull();
  });

  it("GET이 500이면 403과 달리 다시 시도 단추가 있다", async () => {
    fetchWorkspaceUnfurlSettings.mockRejectedValue(new ApiError(500, "boom"));
    const host = mountSection({ role: "owner", liveUnfurl: true });
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="workspace-unfurls-error"] button')).not.toBeNull();
    });
    expect(host.querySelector('[data-testid="workspace-unfurl-card"] [data-testid="operator-notice"]')).toBeNull();
  });

  it("오프라인이면 스위치가 잠기고 이유를 말하며 쓰기를 내지 않는다", () => {
    const host = mountSection({ role: "owner", offline: true });
    const toggle = unfurlSwitch(host);
    expect(toggle?.disabled).toBe(true);
    expect(toggle?.getAttribute("aria-describedby")).toContain("workspace-unfurls-offline");
    expect(host.textContent).toContain("연결이 끊겨 지금은 이 설정을 바꿀 수 없어요.");
    act(() => toggle?.click());
    expect(updateWorkspaceUnfurlSettings).not.toHaveBeenCalled();
  });
});

describe("워크스페이스 페이지 상태 (S5b)", () => {
  it("읽는 중에는 일반 카드가 스켈레톤이고 편집 카드는 아직 없다", () => {
    const host = mountSection({ role: "owner", loading: true });
    expect(
      host.querySelector('[data-testid="workspace-card"] [data-testid="skeleton"][data-ready="false"]')
    ).not.toBeNull();
    expect(host.querySelector('[data-testid="workspace-role-labels"]')).toBeNull();
    expect(host.querySelector('[data-testid="workspace-welcome-kickoff"]')).toBeNull();
  });

  it("오프라인이면 표시명·웰컴 저장 이유가 서고 입력이 읽기 전용이다", () => {
    const host = mountSection({ role: "owner", offline: true });
    expect(host.textContent).toContain("연결이 끊겨 지금은 표시 이름을 저장할 수 없어요.");
    expect(host.textContent).toContain("연결이 끊겨 지금은 웰컴 설정을 저장할 수 없어요.");
    expect(host.textContent).toContain("연결이 끊겨 지금은 워크스페이스를 만들 수 없어요.");
    const owner = host.querySelector('[data-testid="role-label-owner"]') as HTMLInputElement;
    expect(owner.readOnly).toBe(true);
  });

  it("확정된 비운영자에게는 아바타 변경 단추가 없다", () => {
    expect(
      mountSection({ role: "member" }).querySelector('[data-testid="workspace-avatar-change"]')
    ).toBeNull();
  });

  it("운영자에게는 아바타 변경 단추가 있다", () => {
    expect(
      mountSection({ role: "admin" }).querySelector('[data-testid="workspace-avatar-change"]')
    ).not.toBeNull();
  });

  it("카드는 일반·링크 확인·역할 표시명·웰컴·새로 만들기 순이고 합쇼체가 없다", () => {
    const host = mountSection({ role: "owner" });
    const titles = [...host.querySelectorAll("h2")].map((node) => node.textContent);
    expect(titles).toEqual([
      "일반",
      "링크 확인(서버)",
      "역할 표시명",
      "웰컴 킥오프",
      "새 워크스페이스 만들기",
    ]);
    expect(host.textContent).not.toMatch(/습니다/);
  });

  it("새 워크스페이스 만들기가 403이면 서버 운영자 안내로 바뀐다", async () => {
    createWorkspaceMock.mockRejectedValue(new ApiError(403, "instance operator required"));
    const host = mountSection({ role: "owner" });
    act(() => setInputValue(host.querySelector("#workspace-name") as HTMLInputElement, "새 팀"));
    act(() => setInputValue(host.querySelector("#workspace-slug") as HTMLInputElement, "new-team"));
    await act(async () => {
      (host.querySelector('[data-testid="workspace-create"]') as HTMLButtonElement).click();
    });
    await vi.waitFor(() => {
      expect(
        host.querySelector('[data-testid="workspace-create-card"] [data-testid="operator-notice"]')
          ?.textContent
      ).toContain("서버의 운영자만");
    });
    expect(host.querySelector('[data-testid="workspace-create-form"]')).toBeNull();
  });
});

// 새 워크스페이스 완료 카드의 막다른 길 (#4198, 멀티 조직 P0-A). 레일 「+」 완료 패널
// (`AddWorkspaceDialog.test.tsx`)과 같은 사실을 같은 문장으로 말한다.
describe("새 워크스페이스 완료 카드 (#4198)", () => {
  /**
   * 코어 타입 주석(`CreatedWorkspace.workspaceId`)은 서버 UUID가 대문자로 올 수 있다고 경고한다(옛
   * Swift 서버). 지금 Rust 서버는 소문자를 돌려준다. 시험은 일부러 대문자 값으로 「받은 모양 그대로」를
   * 못 박는다.
   */
  const NEW_WS_ID = "019FA000-1111-7222-8333-444455556666";
  const writeText = vi.fn();
  const scrollIntoView = vi.fn();

  beforeEach(() => {
    writeText.mockReset();
    writeText.mockResolvedValue(undefined);
    scrollIntoView.mockReset();
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    // jsdom에는 scrollIntoView가 없다. 카드는 나타나는 즉시 화면 안으로 가져온다.
    Object.defineProperty(window.HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      writable: true,
      value: scrollIntoView,
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(window.navigator, "clipboard");
    Reflect.deleteProperty(window.HTMLElement.prototype, "scrollIntoView");
  });

  async function createNewTeam(host: HTMLElement) {
    createWorkspaceMock.mockResolvedValue({
      schema: "momo.workspace.created.v1",
      workspaceId: NEW_WS_ID,
      slug: "new-team",
      name: "새 팀",
    });
    act(() => setInputValue(host.querySelector("#workspace-name") as HTMLInputElement, "새 팀"));
    act(() => setInputValue(host.querySelector("#workspace-slug") as HTMLInputElement, "new-team"));
    await act(async () => {
      (host.querySelector('[data-testid="workspace-create"]') as HTMLButtonElement).click();
    });
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="workspace-created"]')).not.toBeNull();
    });
  }

  it("카드에 응답의 ID와 복사 단추가 있고 복사는 그 ID를 쓴다", async () => {
    const host = mountSection({ role: "owner" });
    await createNewTeam(host);

    const card = host.querySelector('[data-testid="workspace-created"]');
    expect(card?.textContent).toContain(NEW_WS_ID);
    expect(host.querySelector('[data-testid="workspace-created-id"]')?.textContent).toBe(NEW_WS_ID);

    const copy = host.querySelector('[data-testid="workspace-created-copy"]') as HTMLButtonElement | null;
    expect(copy).not.toBeNull();
    expect(copy?.getAttribute("aria-label")).toBe("워크스페이스 ID 복사");
    await act(async () => {
      copy?.click();
    });
    expect(writeText).toHaveBeenCalledWith(NEW_WS_ID);
    await vi.waitFor(() => {
      expect(copy?.textContent).toBe("복사됨");
    });
  });

  it("안내는 로그인 화면이 받는 길을 말하고, 슬러그로 다시 로그인한다고 하지 않는다", async () => {
    const host = mountSection({ role: "owner" });
    await createNewTeam(host);

    const text = host.querySelector('[data-testid="workspace-created"]')?.textContent ?? "";
    expect(text).toContain(NEW_WORKSPACE_ENTRY_TEXT);
    expect(text).toContain(NEW_WORKSPACE_ENTRY_GUIDE);
    expect(text).toContain("「다른 워크스페이스로 로그인」");
    expect(text).toContain("워크스페이스 ID 칸");
    expect(text).not.toContain("그 슬러그로 다시 로그인");
    expect(text).not.toMatch(/슬러그로/);
    expect(text).not.toMatch(/습니다/);
  });

  it("한 번만 보인다는 사실을 말한다: 이 화면을 벗어나면 ID를 다시 볼 수 없다", async () => {
    const host = mountSection({ role: "owner" });
    await createNewTeam(host);
    const text = host.querySelector('[data-testid="workspace-created"]')?.textContent ?? "";
    expect(text).toContain(NEW_WORKSPACE_ID_ONCE_NOTICE);
    expect(text).toContain("다시 볼 수 없");
    expect(text).toContain("복사해 두세요");
  });

  it("나타나는 즉시 이름 붙은 묶음으로 초점이 가고 화면 안으로 들어온다(접힌 아래에 뜨기 때문)", async () => {
    const host = mountSection({ role: "owner" });
    await createNewTeam(host);
    const group = host.querySelector('[data-testid="workspace-created"]');
    // status(live region)가 아니라 이름 붙은 group이다: ID가 뜨는 순간 통째로 낭독되지 않는다.
    expect(group?.getAttribute("role")).toBe("group");
    expect(group?.getAttribute("aria-label")).toBe("새 팀 워크스페이스를 만들었어요.");
    expect(document.activeElement).toBe(group);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
  });

  it("카드가 떠 있는 동안 Esc는 삼켜지고, 「닫기」가 카드를 지우고 초점을 이름 칸으로 돌려준다", async () => {
    const host = mountSection({ role: "owner" });
    expect(escapeIsClaimed()).toBe(false);
    await createNewTeam(host);

    // 설정 셸이 Esc로 라우트를 닫으면 다시 볼 수 없는 ID가 확인 없이 사라진다(웹훅 발급 카드와 같은 규칙).
    expect(escapeIsClaimed()).toBe(true);
    const reachedShell = vi.fn();
    window.addEventListener("keydown", reachedShell);
    try {
      act(() => {
        window.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
        );
      });
    } finally {
      window.removeEventListener("keydown", reachedShell);
    }
    expect(reachedShell).not.toHaveBeenCalled();
    expect(host.querySelector('[data-testid="workspace-created"]')).not.toBeNull();

    act(() => (host.querySelector('[data-testid="workspace-created-done"]') as HTMLButtonElement).click());
    expect(host.querySelector('[data-testid="workspace-created"]')).toBeNull();
    expect(escapeIsClaimed()).toBe(false);
    expect(document.activeElement).toBe(host.querySelector("#workspace-name"));
  });

  it("지금 열려 있는 워크스페이스의 ID 줄에도 같은 복사 단추가 있다(같은 낱말이 두 가지로 동작하지 않는다)", async () => {
    const host = mountSection({ role: "owner" });
    expect(host.querySelector('[data-testid="workspace-id"]')?.textContent).toBe(WS);
    const copy = host.querySelector('[data-testid="workspace-id-copy"]') as HTMLButtonElement | null;
    expect(copy).not.toBeNull();
    await act(async () => {
      copy?.click();
    });
    expect(writeText).toHaveBeenCalledWith(WS);
  });
});

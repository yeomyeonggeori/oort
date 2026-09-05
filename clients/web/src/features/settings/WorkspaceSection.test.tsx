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
import { WorkspaceSection } from "./WorkspaceSection";

const WS = "00000000-0000-7000-8000-000000000001";
const MEMBER_ID = "00000000-0000-7000-8000-000000000101";
const AGENT_ID = "00000000-0000-7000-8000-000000000201";

const patchWorkspaceSettings = vi.hoisted(() => vi.fn());

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
    updatedAtMs: 0,
    roleLabels: labels,
    welcomeAgentMemberId: null,
    welcomePrompt: "",
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
}): HTMLElement {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  client.setQueryData(workspaceIdentityKey(WS), workspace(options.labels ?? {}));
  client.setQueryData(["roster", WS], [
    rosterMember(options.role),
    agentMember(),
  ]);
  client.setQueryData(["settings", "workspace-unfurls", WS], {
    enabled: true,
  });

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
      createElement(WorkspaceSection, { workspaceId: WS, offline: false })
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
      "오너와 관리자만"
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
    ) as HTMLSelectElement | null;
    const prompt = host.querySelector(
      '[data-testid="welcome-prompt"]'
    ) as HTMLTextAreaElement | null;
    expect(select).not.toBeNull();
    expect(prompt).not.toBeNull();
    act(() => {
      select!.value = AGENT_ID;
      select!.dispatchEvent(new Event("change", { bubbles: true }));
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
    expect(host.textContent).toContain("2000자까지 쓸 수 있습니다.");
    expect(host.textContent?.split("2000자까지 쓸 수 있습니다.").length - 1).toBe(1);
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


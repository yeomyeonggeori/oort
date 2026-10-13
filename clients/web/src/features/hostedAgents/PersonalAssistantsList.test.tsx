// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { waitFor as rtlWaitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { RosterMember } from "@momo/core/lib/api";
import { fetchRoster, listChannels } from "@momo/core/lib/api";
import {
  createHostedConnection,
  getHostedConnection,
  listHostedConnections,
} from "@momo/core/features/hostedAgents/api";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { PersonalAssistantsList } from "./PersonalAssistantsList";

vi.mock("@momo/core/features/hostedAgents/api", () => ({
  listHostedConnections: vi.fn(),
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

vi.mock("@momo/core/features/settings/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/features/settings/api")>();
  return {
    ...actual,
    fetchWorkspace: vi.fn(async () => ({
      id: WS,
      slug: "test",
      name: "테스트",
      updatedAtMs: 0,
      roleLabels: {},
      welcomeAgentMemberId: null,
      welcomePrompt: "",
    })),
  };
});

vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return {
    ...actual,
    fetchRoster: vi.fn(async () => []),
    listChannels: vi.fn(async () => []),
    fetchAgentLiveness: vi.fn(async () => {
      throw new actual.ApiError(404, "not found");
    }),
  };
});

vi.mock("@/features/common/useOffline", () => ({
  useOffline: () => false,
}));

const WS = "00000000-0000-7000-8000-000000000001";
const MEMBER_ID = "00000000-0000-7000-8000-000000000101";
const AGENT_ID = "019f9a01-0000-7000-8000-000000000404";
const CONNECTION_ID = "019f9a01-0000-7000-8000-0000000005c1";
const SECRET = "momo_pair_v1.list-launch-secret";

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

let mountedRoot: Root | null = null;
let mountedHost: HTMLElement | null = null;

function human(): RosterMember {
  return {
    id: MEMBER_ID,
    workspaceId: WS,
    kind: "human",
    status: "active",
    displayName: "곽성재",
    handle: "seongjae",
    role: "owner",
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

async function waitFor(check: () => boolean, label: string): Promise<void> {
  await rtlWaitFor(
    () => {
      if (!check()) throw new Error(`waitFor ${label}`);
    },
    { timeout: 5000 }
  );
}

function mount(): HTMLElement {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
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
      createElement(MemoryRouter, null, createElement(PersonalAssistantsList))
    )
  );
  act(() => {
    mountedRoot?.render(tree);
  });
  return host;
}

const q = (selector: string) => document.querySelector(selector);
const qa = (selector: string) => [...document.querySelectorAll(selector)];

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  HTMLElement.prototype.scrollIntoView = vi.fn();
});

beforeEach(() => {
  vi.mocked(fetchRoster).mockResolvedValue([human()]);
  vi.mocked(listChannels).mockResolvedValue([]);
  vi.mocked(listHostedConnections).mockResolvedValue({ connections: [] });
  vi.mocked(getHostedConnection).mockResolvedValue({
    connection: {
      id: CONNECTION_ID,
      agentMemberId: AGENT_ID,
      status: "pairing_pending",
      authMode: "static_bearer",
      audience: "/v1/mcp/agent-port",
      approvedChannelIds: [],
      approvedScopes: [],
      createdAtMs: 1,
      updatedAtMs: 1,
    },
    cleanupArtifacts: [],
  });
  vi.mocked(createHostedConnection).mockResolvedValue({
    connection: {
      id: CONNECTION_ID,
      agentMemberId: AGENT_ID,
      status: "pairing_pending",
      authMode: "static_bearer",
      audience: "/v1/mcp/agent-port",
      approvedChannelIds: [],
      approvedScopes: [],
      createdAtMs: 1,
      updatedAtMs: 1,
    },
    pairingCredential: SECRET,
    pairingExpiresAtMs: Date.now() + 600_000,
  });
});

afterEach(() => {
  if (mountedRoot) act(() => mountedRoot?.unmount());
  mountedRoot = null;
  mountedHost?.remove();
  mountedHost = null;
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("개인 비서 목록 (#3773)", () => {
  it("세 줄이 서고 행당 버튼은 최대 하나이며 dots·Muse는 버튼 없이 「곧」이다", async () => {
    mount();
    await waitFor(() => qa('[data-testid="assistant-row"]').length === 3, "rows");
    const rows = qa('[data-testid="assistant-row"]');
    for (const row of rows) {
      expect(row.querySelectorAll("button").length).toBeLessThanOrEqual(1);
    }
    const byId = (id: string) => rows.find((row) => row.getAttribute("data-assistant-id") === id)!;
    expect(byId("grok").querySelectorAll("button")).toHaveLength(1);
    expect(byId("grok").textContent).toContain("연결 안 됨");
    for (const id of ["dots", "muse"]) {
      expect(byId(id).querySelectorAll("button")).toHaveLength(0);
      expect(byId(id).textContent).toContain("곧");
    }
    expect(byId("muse").querySelector('[data-testid="assistant-provider"]')?.textContent).toBe("Meta");
    expect(byId("grok").querySelector('[data-testid="assistant-provider"]')).toBeNull();
    expect(byId("dots").querySelector('[data-testid="assistant-provider"]')).toBeNull();
  });

  it("그록봇 「연결」 한 번으로 이름 단계 없이 연결 프롬프트가 서고 진행 표시는 셋이다", async () => {
    mount();
    await waitFor(() => q('[data-testid="assistant-action"]') !== null, "action");
    act(() => {
      (q('[data-testid="assistant-action"]') as HTMLButtonElement).click();
    });
    await waitFor(() => q('[data-testid="hosted-prompt-copy"]') !== null, "prompt copy");
    // 이름·핸들 입력 단계를 거치지 않았다.
    expect(q('[data-testid="hosted-display-name"]')).toBeNull();
    expect(vi.mocked(createHostedConnection).mock.calls.length).toBe(1);
    // 진행 표시는 다섯이 아니라 셋.
    expect(q('nav[aria-label="연결 단계"]')?.getAttribute("data-step-count")).toBe("3");
    expect(qa('[data-testid="hosted-step-chip"]')).toHaveLength(3);
    // 화면에는 비밀이 마스크된 미리보기만 서고, 비밀은 접힌 보조 구획에 정확히 한 번이다.
    const preview = q('[data-testid="hosted-prompt-preview"]')?.textContent ?? "";
    expect(preview).not.toContain(SECRET);
    expect(preview).toContain("/v1/mcp/agent-port");
    expect((document.body.textContent ?? "").split(SECRET).length - 1).toBe(1);
    // 주 행동(잉크 채움)은 프롬프트 복사 하나다.
    expect(q('[data-testid="hosted-prompt-copy"]')?.className).toContain("bg-primary");
  });

  it("권한이 없는 멤버에게는 행동을 내주지 않는다", async () => {
    vi.mocked(fetchRoster).mockResolvedValue([{ ...human(), role: "member" }]);
    mount();
    await waitFor(() => q('[data-testid="assistants-permission"]') !== null, "permission note");
    expect(qa('[data-testid="assistant-action"]')).toHaveLength(0);
  });
});

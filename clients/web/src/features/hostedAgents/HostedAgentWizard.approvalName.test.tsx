// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { RosterMember } from "@momo/core/lib/api";
import { fetchRoster, listChannels } from "@momo/core/lib/api";
import {
  getHostedConnection,
  listHostedConnections,
} from "@momo/core/features/hostedAgents/api";
import { HOSTED_AGENT_PORT_AUDIENCE } from "@momo/core/features/hostedAgents/model";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { HostedAgentWizard } from "./HostedAgentWizard";

// =============================================================================
// #2327 E2E-A A6 — 호스티드 위저드 4단계 이름 보간.
//
// v0.1.4 실측: 「승인하면 는 2개 채널에서…」(빈 displayName + topic 조사).
// 이 파일이 그리는 것은 `data-testid="hosted-consequence"` 한 문장이다.
// =============================================================================

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
  const actual =
    await importOriginal<typeof import("@momo/core/features/settings/api")>();
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
  };
});

vi.mock("@/features/common/useOffline", () => ({
  useOffline: () => false,
}));

const WS = "00000000-0000-7000-8000-000000000001";
const MEMBER_ID = "00000000-0000-7000-8000-000000000101";
const AGENT_ID = "019f9a01-0000-7000-8000-000000000404";
const CONNECTION_ID = "019f9a01-0000-7000-8000-0000000005c1";
const CHANNEL_LAB = "00000000-0000-7000-8000-000000000201";
const CHANNEL_GENERAL = "00000000-0000-7000-8000-000000000202";

const EMPTY_SENTENCE =
  "승인하면 이 에이전트는 2개 채널에서 자기를 부른 메시지 읽기, 메시지 쓰기를 할 수 있습니다. 승인하지 않은 채널에서는 이 에이전트를 멘션해도 작업이 만들어지지 않습니다.";
const NAMED_SENTENCE =
  "승인하면 그록봇은 2개 채널에서 자기를 부른 메시지 읽기, 메시지 쓰기를 할 수 있습니다. 승인하지 않은 채널에서는 이 에이전트를 멘션해도 작업이 만들어지지 않습니다.";

function wireConnection() {
  return {
    id: CONNECTION_ID,
    agentMemberId: AGENT_ID,
    status: "detected",
    authMode: "static_bearer",
    audience: HOSTED_AGENT_PORT_AUDIENCE,
    approvedChannelIds: [],
    approvedScopes: [],
    createdAtMs: 1_700_000_000_000,
    updatedAtMs: 1_700_000_000_000,
  };
}

function rosterMember(
  overrides: Partial<RosterMember> & Pick<RosterMember, "id" | "kind" | "displayName">
): RosterMember {
  return {
    workspaceId: WS,
    status: "active",
    handle: overrides.kind === "agent" ? "grokbot" : "seongjae",
    role: overrides.kind === "agent" ? "member" : "owner",
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...overrides,
  };
}

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

let mountedRoot: Root | null = null;
let mountedHost: HTMLElement | null = null;

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

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 80; i += 1) {
    if (check()) return;
    await flush();
  }
  throw new Error(`waitFor ${label}`);
}

function mountWizard(agentDisplayName: string): HTMLElement {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  mountedHost?.remove();

  const connection = wireConnection();
  vi.mocked(listHostedConnections).mockResolvedValue({
    connections: [connection],
  });
  vi.mocked(getHostedConnection).mockResolvedValue({
    connection,
    cleanupArtifacts: [],
  });
  vi.mocked(fetchRoster).mockResolvedValue([
    rosterMember({
      id: MEMBER_ID,
      kind: "human",
      displayName: "곽성재",
    }),
    rosterMember({
      id: AGENT_ID,
      kind: "agent",
      displayName: agentDisplayName,
    }),
  ]);
  vi.mocked(listChannels).mockResolvedValue([
    {
      id: CHANNEL_LAB,
      workspaceId: WS,
      kind: "public",
      name: "agent-lab",
      muted: false,
    },
    {
      id: CHANNEL_GENERAL,
      workspaceId: WS,
      kind: "public",
      name: "general",
      muted: false,
    },
  ]);

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
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
      createElement(HostedAgentWizard, {
        open: true,
        onOpenChange: () => undefined,
        opener: null,
        entry: "hub",
        launch: {
          presetId: "grok",
          displayName: "",
          handle: "grokbot",
          connectionId: CONNECTION_ID,
        },
      })
    )
  );
  act(() => {
    mountedRoot?.render(tree);
  });
  return host;
}

async function selectTwoChannels(): Promise<void> {
  await waitFor(
    () => document.querySelectorAll('[data-testid="hosted-channels-row"]').length >= 2,
    "channel rows"
  );
  const boxes = [
    ...document.querySelectorAll<HTMLInputElement>(
      '[data-testid="hosted-channels-row"] input[type="checkbox"]'
    ),
  ].filter((input) => !input.disabled);
  expect(boxes.length).toBeGreaterThanOrEqual(2);
  await act(async () => {
    boxes[0]?.click();
    boxes[1]?.click();
  });
}

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  HTMLElement.prototype.scrollIntoView = vi.fn();
  HTMLElement.prototype.hasPointerCapture = () => false;
  HTMLElement.prototype.setPointerCapture = () => undefined;
  HTMLElement.prototype.releasePointerCapture = () => undefined;
});

beforeEach(() => {
  document.body.replaceChildren();
  vi.mocked(listHostedConnections).mockReset();
  vi.mocked(getHostedConnection).mockReset();
  vi.mocked(fetchRoster).mockReset();
  vi.mocked(listChannels).mockReset();
});

afterEach(() => {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  mountedHost?.remove();
  mountedHost = null;
});

describe("위저드 4단계 이름 보간 (#2327)", () => {
  it("빈 이름과 있는 이름이 각각 구멍을 남기지 않는 문장이다", async () => {
    mountWizard("");
    await waitFor(
      () => document.querySelector('[data-testid="hosted-consequence"]') !== null,
      "empty consequence"
    );
    await selectTwoChannels();
    const empty = document.querySelector('[data-testid="hosted-consequence"]');
    expect(empty?.textContent).toBe(EMPTY_SENTENCE);
    expect(empty?.textContent).not.toMatch(/승인하면\s+는\s/);

    mountWizard("그록봇");
    await waitFor(
      () => document.querySelector('[data-testid="hosted-consequence"]') !== null,
      "named consequence"
    );
    await selectTwoChannels();
    const named = document.querySelector('[data-testid="hosted-consequence"]');
    expect(named?.textContent).toBe(NAMED_SENTENCE);
  });
});

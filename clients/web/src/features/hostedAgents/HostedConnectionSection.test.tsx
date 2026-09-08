// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { RosterMember } from "@momo/core/lib/api";
import {
  TERMINAL_DONE_HEADLINE,
  TERMINAL_HEADLINE,
} from "@momo/core/features/hostedAgents/disconnect";
import {
  disconnectHostedConnection,
  getHostedConnection,
  listHostedConnections,
} from "@momo/core/features/hostedAgents/api";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { HostedConnectionSection } from "./HostedConnectionSection";

// =============================================================================
// R4-N4: 「완료는 서버가 정한다」는 소스 그렙이 아니라 렌더로 잰다.
// cleanup_pending 과 해제 시작 응답이 완료 헤드라인을 그리면 이 파일이 붉다.
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

const roster: RosterMember[] = [];

vi.mock("@/features/workspace/useWorkspace", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/workspace/useWorkspace")>();
  return {
    ...actual,
    useDirectory: () => ({
      directory: actual.makeDirectory(roster),
      isPending: false,
      isError: false,
      data: roster,
      refetch: () => undefined,
    }),
  };
});

const WS = "00000000-0000-7000-8000-000000000001";
const MEMBER_ID = "00000000-0000-7000-8000-000000000101";
const AGENT_ID = "019f9a01-0000-7000-8000-000000000404";
const CONNECTION_ID = "019f9a01-0000-7000-8000-0000000005c1";

function wireConnection(overrides: Record<string, unknown> = {}) {
  return {
    id: CONNECTION_ID,
    agentMemberId: AGENT_ID,
    status: "pairing_pending",
    authMode: "static_bearer",
    audience: "/v1/mcp/agent-port",
    approvedChannelIds: [],
    approvedScopes: [],
    createdAtMs: 1_700_000_000_000,
    updatedAtMs: 1_700_000_000_000,
    ...overrides,
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

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let mountedRoot: Root | null = null;
let mountedHost: HTMLElement | null = null;

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  HTMLElement.prototype.scrollIntoView = vi.fn();
  HTMLElement.prototype.hasPointerCapture = () => false;
  HTMLElement.prototype.setPointerCapture = () => undefined;
  HTMLElement.prototype.releasePointerCapture = () => undefined;
});

beforeEach(() => {
  roster.splice(0, roster.length, {
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
  }, {
    id: AGENT_ID,
    workspaceId: WS,
    kind: "agent",
    status: "active",
    displayName: "김인턴",
    handle: "intern",
    role: "member",
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  });
  vi.mocked(listHostedConnections).mockReset();
  vi.mocked(getHostedConnection).mockReset();
  vi.mocked(disconnectHostedConnection).mockReset();
});

afterEach(() => {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  mountedHost?.remove();
  mountedHost = null;
});

function mountLedger(connection: ReturnType<typeof wireConnection>): HTMLElement {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  mountedHost?.remove();
  vi.mocked(listHostedConnections).mockResolvedValue({
    connections: [connection],
  });
  vi.mocked(getHostedConnection).mockResolvedValue({
    connection,
    cleanupArtifacts: [],
  });
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
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
      createElement(HostedConnectionSection, {
        agentMemberId: AGENT_ID,
        agentLabel: "김인턴",
        title: `김인턴 · ${connection.status}`,
        connectionId: connection.id,
        offline: false,
      })
    )
  );
  act(() => mountedRoot?.render(tree));
  return host;
}

async function waitFor(
  predicate: () => boolean,
  label: string
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 4000) {
      throw new Error(label);
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
}

describe("완료 헤드라인은 서버 disconnected 만 그린다", () => {
  it("cleanup_pending 장부는 완료 문장을 그리지 않는다", async () => {
    const host = mountLedger(wireConnection({ status: "cleanup_pending" }));
    await waitFor(
      () =>
        host.querySelector('[data-testid="hosted-disconnect-terminal"]') !==
        null,
      "terminal"
    );
    expect(host.textContent ?? "").toContain(TERMINAL_HEADLINE);
    expect(host.textContent ?? "").not.toContain(TERMINAL_DONE_HEADLINE);
  });

  it("disconnected 장부는 서버가 정한 완료 문장을 그린다", async () => {
    const host = mountLedger(wireConnection({ status: "disconnected" }));
    await waitFor(
      () =>
        host.querySelector('[data-testid="hosted-disconnect-terminal"]') !==
        null,
      "done terminal"
    );
    expect(host.textContent ?? "").toContain(TERMINAL_DONE_HEADLINE);
  });

  it("해제 시작 응답이 cleanup_pending 이면 완료 문장이 없다", async () => {
    let current = wireConnection({ status: "active" });
    vi.mocked(listHostedConnections).mockImplementation(async () => ({
      connections: [current],
    }));
    vi.mocked(getHostedConnection).mockImplementation(async () => ({
      connection: current,
      cleanupArtifacts: [],
    }));
    vi.mocked(disconnectHostedConnection).mockImplementation(async () => {
      current = wireConnection({ status: "cleanup_pending" });
      return {
        connection: current,
        remainingRequired: 1,
        startedNow: true,
        cleanupArtifacts: [],
      };
    });
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Infinity },
        mutations: { retry: false },
      },
    });
    const host = document.createElement("div");
    document.body.append(host);
    mountedHost = host;
    mountedRoot = createRoot(host);
    act(() => {
      mountedRoot?.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(
            SessionProvider,
            { value: sessionValue() },
            createElement(HostedConnectionSection, {
              agentMemberId: AGENT_ID,
              agentLabel: "김인턴",
              title: "김인턴 · 활성",
              connectionId: CONNECTION_ID,
              offline: false,
            })
          )
        )
      );
    });
    await waitFor(
      () =>
        host.querySelector('[data-testid="hosted-disconnect-start"]') !== null,
      "start"
    );
    act(() => {
      (
        host.querySelector(
          '[data-testid="hosted-disconnect-start"]'
        ) as HTMLButtonElement
      ).click();
    });
    await waitFor(
      () =>
        host.querySelector(
          '[data-testid="hosted-disconnect-start-confirm"]'
        ) !== null,
      "confirm"
    );
    act(() => {
      (
        host.querySelector(
          '[data-testid="hosted-disconnect-start-confirm"]'
        ) as HTMLButtonElement
      ).click();
    });
    await waitFor(
      () => vi.mocked(disconnectHostedConnection).mock.calls.length > 0,
      "start called"
    );
    await waitFor(
      () => (host.textContent ?? "").includes(TERMINAL_HEADLINE),
      "cleanup headline"
    );
    expect(host.textContent ?? "").not.toContain(TERMINAL_DONE_HEADLINE);
  });
});

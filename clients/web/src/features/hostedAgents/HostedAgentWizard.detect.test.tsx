// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { fetchRoster, listChannels } from "@momo/core/lib/api";
import {
  getHostedConnection,
  listHostedConnections,
} from "@momo/core/features/hostedAgents/api";
import { HOSTED_AGENT_PORT_AUDIENCE } from "@momo/core/features/hostedAgents/model";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { HostedAgentWizard } from "./HostedAgentWizard";

// =============================================================================
// #3522 — 3단계 감지 대기: 만료 카운트다운과 오지 않는 원인.
//
// RED PROOF: `DetectingStep` 의 카운트다운 블록(`hosted-detect-countdown`)과 원인 목록
// (`hosted-detect-causes`)을 지우면 붉어진다.
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

function byId(id: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${id}"]`);
}

function wireConnection(overrides: Record<string, unknown>) {
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
    ...overrides,
  };
}

function mountWizard(
  connection: ReturnType<typeof wireConnection> | null,
): void {
  vi.mocked(listHostedConnections).mockResolvedValue({
    connections: connection ? [connection] : [],
  });
  if (connection) {
    vi.mocked(getHostedConnection).mockResolvedValue({
      connection,
      cleanupArtifacts: [],
    } as never);
  }
  vi.mocked(fetchRoster).mockResolvedValue([]);
  vi.mocked(listChannels).mockResolvedValue([]);
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
        launch: connection
          ? {
              presetId: "grok",
              displayName: "",
              handle: "grokbot",
              connectionId: CONNECTION_ID,
            }
          : null,
      }),
    ),
  );
  act(() => {
    mountedRoot?.render(tree);
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
});

afterEach(() => {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  mountedHost?.remove();
  mountedHost = null;
});

describe("3단계 감지 대기 (#3522)", () => {
  it("방금 발급한 연결이면 남은 시간과 원인 후보를 함께 보인다", async () => {
    mountWizard(
      wireConnection({ status: "pairing_pending", updatedAtMs: Date.now() }),
    );
    await waitFor(() => byId("hosted-detect-countdown") !== null, "countdown");
    expect(byId("hosted-detect-countdown-label")?.textContent).toBe(
      "길어야 약 14분 뒤 만료",
    );
    expect(byId("hosted-detect-countdown")?.textContent).toContain("근사치");
    const causes = byId("hosted-detect-causes");
    expect(causes?.textContent).toContain("구분하지 못해요");
    // Grok 프리셋은 확인되지 않았으므로 후보가 하나 더 붙는다.
    expect(causes?.querySelectorAll("li")).toHaveLength(6);
    expect(byId("hosted-regenerate")).not.toBeNull();
  });

  it("15분이 지났으면 서버가 아직 대기라고 해도 만료와 재발급을 말한다", async () => {
    mountWizard(
      wireConnection({
        status: "pairing_pending",
        updatedAtMs: Date.now() - 16 * 60 * 1000,
      }),
    );
    await waitFor(() => byId("hosted-detect-countdown") !== null, "countdown");
    expect(byId("hosted-detect-countdown-label")?.textContent).toBe("만료됨");
    const text = byId("hosted-detect-countdown")?.textContent ?? "";
    expect(text).toContain("연결 값 다시 발급");
    expect(byId("hosted-regenerate")).not.toBeNull();
    // 만료 뒤에는 기다려도 된다는 말이 서지 않는다. 지금 확인은 남는다(시계 오차).
    expect(byId("hosted-detecting-empty")?.textContent).toContain("만료됐어요");
    expect(byId("hosted-detecting-empty")?.textContent).not.toContain(
      "다녀와도",
    );
    expect(byId("hosted-recheck")).not.toBeNull();
    // 원인 목록은 만료 뒤에도 접힌 채 남는다(시계 오차로 만료 판정이 틀릴 수 있다).
    expect(byId("hosted-detect-causes")).not.toBeNull();
  });
});

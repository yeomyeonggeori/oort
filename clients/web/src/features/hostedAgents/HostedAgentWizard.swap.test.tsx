// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchRoster, listChannels } from "@momo/core/lib/api";
import {
  getHostedConnection,
  listHostedConnections,
} from "@momo/core/features/hostedAgents/api";
import { HOSTED_AGENT_PORT_AUDIENCE } from "@momo/core/features/hostedAgents/model";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { HostedAgentWizard } from "./HostedAgentWizard";

// =============================================================================
// #3521 — 위저드의 두 번째 자격증명 교체 이탈 방지.
//
// RED PROOF: 1단계의 미리 안내(`TwoValuesPreview`), 5단계의 교체 체크리스트
// (`SwapChecklist`), 멈춤 안내(`hosted-swap-stall`)를 각각 지우면 붉어진다.
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
const CREDENTIAL_ID = "019f9a01-0000-7000-8000-0000000005e1";

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

function mountWizard(connection: ReturnType<typeof wireConnection> | null): void {
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
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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
      })
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

describe("두 번째 교체 이탈 방지 (#3521)", () => {
  it("1단계가 시작 전에 값을 두 번 붙여 넣는다고 먼저 말한다", async () => {
    mountWizard(null);
    await waitFor(() => byId("hosted-preview") !== null, "preview");
    const text = byId("hosted-preview")?.textContent ?? "";
    expect(text).toContain("두 번 붙여 넣어요");
    expect(text).toContain("연결 값");
    expect(text).toContain("활성 자격증명");
  });

  it("5단계 증명 대기에 체크리스트가 서고 표시하면 바뀐다", async () => {
    mountWizard(
      wireConnection({
        activeCredentialId: CREDENTIAL_ID,
        updatedAtMs: Date.now(),
      })
    );
    await waitFor(() => byId("hosted-swap-checklist") !== null, "checklist");
    const box = (id: string) =>
      document.querySelector<HTMLInputElement>(`#hosted-swap-${id}`);
    expect(box("replace")?.checked).toBe(false);
    expect(box("proof")?.disabled).toBe(true);
    await act(async () => {
      box("replace")?.click();
    });
    expect(box("replace")?.checked).toBe(true);
    // 문턱 전이라 멈춤 안내는 없다.
    expect(byId("hosted-swap-stall")).toBeNull();
  });

  it("교체 없이 오래 멈추면 원인과 다음 행동을 말하고 표시하면 다른 말을 한다", async () => {
    mountWizard(wireConnection({ activeCredentialId: CREDENTIAL_ID }));
    await waitFor(() => byId("hosted-swap-stall") !== null, "stall");
    expect(byId("hosted-swap-stall")?.textContent).toContain("바꾸지 않았다면");
    expect(byId("hosted-regenerate")).not.toBeNull();
    await act(async () => {
      document.querySelector<HTMLInputElement>("#hosted-swap-replace")?.click();
    });
    expect(byId("hosted-swap-stall")?.textContent).toContain("바꿨다고 표시했는데");
  });

  it("활성이면 체크리스트가 모두 끝난 채로 서고 멈춤 안내는 없다", async () => {
    mountWizard(
      wireConnection({ status: "active", activeCredentialId: CREDENTIAL_ID })
    );
    await waitFor(() => byId("hosted-swap-checklist") !== null, "active checklist");
    const boxes = [
      ...document.querySelectorAll<HTMLInputElement>(
        '[data-testid="hosted-swap-list"] input[type="checkbox"]'
      ),
    ];
    expect(boxes).toHaveLength(3);
    expect(boxes.every((input) => input.checked)).toBe(true);
    expect(byId("hosted-swap-stall")).toBeNull();
  });
});

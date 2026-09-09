// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { RosterMember } from "@momo/core/lib/api";
import { createHostedConnection, getHostedConnection, listHostedConnections } from "@momo/core/features/hostedAgents/api";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { clearAllFirstAgentMarkers } from "./firstAgentStore";
import { FirstAgentStage } from "./FirstAgentStage";

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
    fetchProviderLink: vi.fn(async () => ({
      schema: "momo.provider_link.v0",
      configured: false,
      source: "none",
      mode: "external-hermes",
      baseUrl: "",
      endpointLabel: "",
      bearerConfigured: false,
      availability: "unknown",
      keyConfigured: false,
      diagnostics: [],
    })),
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
    fetchRoster: vi.fn(async () => [human]),
    listChannels: vi.fn(async () => [
      {
        id: GENERAL_ID,
        workspaceId: WS,
        name: "general",
        kind: "public",
        muted: false,
      },
    ]),
  };
});

vi.mock("@/features/common/useOffline", () => ({
  useOffline: () => false,
}));

const WS = "00000000-0000-7000-8000-000000000001";
const MEMBER_ID = "00000000-0000-7000-8000-000000000101";
const AGENT_ID = "019f9a01-0000-7000-8000-000000000404";
const CONNECTION_ID = "019f9a01-0000-7000-8000-0000000005c1";
const GENERAL_ID = "00000000-0000-7000-8000-000000000201";
const PRODUCT_SECRET = "momo_pair_v1.issued-from-create-response";

const human: RosterMember = {
  id: MEMBER_ID,
  workspaceId: WS,
  kind: "human",
  status: "active",
  displayName: "곽성재",
  handle: "seongjae",
  role: "owner",
  channelCount: 1,
  channelIds: [GENERAL_ID],
  capabilities: [],
  createdAtMs: 0,
  updatedAtMs: 0,
};

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

function countNeedle(haystack: string, needle: string): number {
  if (needle === "") return 0;
  return haystack.split(needle).length - 1;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 120; i += 1) {
    if (check()) return;
    await flush();
  }
  throw new Error(`waitFor ${label}`);
}

function pressKey(el: Element, key: string): void {
  act(() => {
    el.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })
    );
  });
}

function mountStage(): HTMLElement {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 30_000, refetchOnWindowFocus: false },
    },
  });
  const host = document.createElement("div");
  document.body.append(host);
  mountedHost = host;
  mountedRoot = createRoot(host);
  const tree: ReactElement = createElement(
    QueryClientProvider,
    { client: queryClient },
    createElement(
      SessionProvider,
      { value: sessionValue() },
      createElement(HashRouter, null, createElement(FirstAgentStage, {
        onContinue: () => undefined,
      }))
    )
  );
  act(() => {
    mountedRoot?.render(tree);
  });
  return host;
}

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  HTMLElement.prototype.scrollIntoView = vi.fn();
});

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  clearAllFirstAgentMarkers();
  vi.mocked(listHostedConnections).mockResolvedValue({ connections: [] });
  vi.mocked(createHostedConnection).mockResolvedValue({
    connection: {
      id: CONNECTION_ID,
      agentMemberId: AGENT_ID,
      status: "pairing_pending",
      authMode: "static_bearer",
      audience: "/v1/mcp/agent-port",
      approvedChannelIds: [],
      approvedScopes: [],
      createdAtMs: 1_700_000_000_000,
      updatedAtMs: 1_700_000_000_000,
    },
    pairingCredential: PRODUCT_SECRET,
    pairingExpiresAtMs: Date.now() + 600_000,
  });
  vi.mocked(getHostedConnection).mockResolvedValue({
    connection: {
      id: CONNECTION_ID,
      agentMemberId: AGENT_ID,
      status: "pairing_pending",
      authMode: "static_bearer",
      audience: "/v1/mcp/agent-port",
      approvedChannelIds: [],
      approvedScopes: [],
      createdAtMs: 1_700_000_000_000,
      updatedAtMs: 1_700_000_000_000,
    },
    cleanupArtifacts: [],
  });
});

afterEach(() => {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  mountedHost?.remove();
  mountedHost = null;
});

describe("M-G 실제 위저드 발급 응답이 dd 한 칸이다", () => {
  it("create 응답의 비밀이 DOM 과 콘솔에 한 번이다", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    mountStage();
    await waitFor(
      () => document.querySelector("#first-agent-harness-claude-code") !== null,
      "cards"
    );
    const radio = document.querySelector<HTMLInputElement>(
      "#first-agent-harness-claude-code"
    );
    if (!radio) throw new Error("card");
    radio.focus();
    pressKey(radio, "Enter");
    await waitFor(
      () => document.querySelector('[data-testid="hosted-pairing-card"]') !== null,
      "wizard pairing"
    );
    expect(vi.mocked(createHostedConnection).mock.calls.length).toBe(1);
    const secretEls = [...document.querySelectorAll("dd")].filter(
      (node) => node.textContent === PRODUCT_SECRET
    );
    expect(secretEls).toHaveLength(1);
    expect(countNeedle(document.body.textContent ?? "", PRODUCT_SECRET)).toBe(1);
    const joined = [log, warn, error, info, debug]
      .flatMap((spy) => spy.mock.calls)
      .map((args) => args.map(String).join(" "))
      .join("\n");
    expect(joined).not.toContain(PRODUCT_SECRET);
    log.mockRestore();
    warn.mockRestore();
    error.mockRestore();
    info.mockRestore();
    debug.mockRestore();
  });
});

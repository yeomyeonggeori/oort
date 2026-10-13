// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { waitFor as rtlWaitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { RosterMember } from "@momo/core/lib/api";
import { fetchRoster, listChannels } from "@momo/core/lib/api";
import {
  confirmHostedConnection,
  getHostedConnection,
  listHostedConnections,
} from "@momo/core/features/hostedAgents/api";
import { HOSTED_AGENT_PORT_AUDIENCE } from "@momo/core/features/hostedAgents/model";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { HostedAgentWizard } from "./HostedAgentWizard";

// =============================================================================
// #3773 — 그록봇 승인 뒤 교체도 프롬프트 한 덩어리다. 승인(사람 확인)은 그대로
// 홀로 서고, 교체 프롬프트의 비밀은 한 번만 나오며, 「붙여 넣었어요」가 교체 표시를
// 대신 눌러 준다.
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
  return { ...actual, fetchRoster: vi.fn(), listChannels: vi.fn() };
});

vi.mock("@/features/common/useOffline", () => ({ useOffline: () => false }));

const WS = "00000000-0000-7000-8000-000000000001";
const MEMBER_ID = "00000000-0000-7000-8000-000000000101";
const AGENT_ID = "019f9a01-0000-7000-8000-000000000404";
const CONNECTION_ID = "019f9a01-0000-7000-8000-0000000005c1";
const CHANNEL_A = "00000000-0000-7000-8000-000000000201";
const ACTIVE_SECRET = "momo_active_v1.swap-prompt-secret";

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let root: Root | null = null;
let host: HTMLElement | null = null;

function wire(over: Record<string, unknown> = {}) {
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
    ...over,
  };
}

function member(over: Partial<RosterMember> & Pick<RosterMember, "id" | "kind" | "displayName">): RosterMember {
  return {
    workspaceId: WS,
    status: "active",
    handle: over.kind === "agent" ? "grokbot" : "seongjae",
    role: over.kind === "agent" ? "member" : "owner",
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...over,
  };
}

function session(): SessionContextValue {
  return {
    session: {
      accessToken: "a",
      refreshToken: "r",
      member: { id: MEMBER_ID, workspaceId: WS, kind: "human", displayName: "곽성재", handle: "seongjae" },
      realtimeWebSocketUrl: "wss://example.test/connection/websocket",
    },
    workspaceId: WS,
    realtime: null,
    connStatus: "connected",
    logout: () => undefined,
    replaceSessionMember: () => undefined,
  };
}

async function waitFor(check: () => boolean, label: string) {
  await rtlWaitFor(
    () => {
      if (!check()) throw new Error(`waitFor ${label}`);
    },
    { timeout: 5000 }
  );
}

const q = (selector: string) => document.querySelector(selector);

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  HTMLElement.prototype.scrollIntoView = vi.fn();
  HTMLElement.prototype.hasPointerCapture = () => false;
  HTMLElement.prototype.setPointerCapture = () => undefined;
  HTMLElement.prototype.releasePointerCapture = () => undefined;
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  document.body.replaceChildren();
  vi.clearAllMocks();
});

describe("그록봇 승인과 교체 프롬프트 (#3773)", () => {
  it("승인은 사람이 한 번 누르고, 교체 프롬프트의 비밀은 한 번만 나오며, 붙여 넣었어요가 교체 표시를 채운다", async () => {
    vi.mocked(listHostedConnections).mockResolvedValue({ connections: [wire()] });
    vi.mocked(getHostedConnection).mockResolvedValue({ connection: wire(), cleanupArtifacts: [] });
    vi.mocked(fetchRoster).mockResolvedValue([
      member({ id: MEMBER_ID, kind: "human", displayName: "곽성재" }),
      member({ id: AGENT_ID, kind: "agent", displayName: "그록봇" }),
    ]);
    vi.mocked(listChannels).mockResolvedValue([
      { id: CHANNEL_A, workspaceId: WS, kind: "public", name: "general", muted: false },
    ]);
    vi.mocked(confirmHostedConnection).mockResolvedValue({
      connection: wire({ activeCredentialId: "cred-1", approvedChannelIds: [CHANNEL_A] }),
      credentialId: "cred-1",
      credential: ACTIVE_SECRET,
      tokenType: "Bearer",
    });

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    const tree: ReactElement = createElement(
      QueryClientProvider,
      { client },
      createElement(
        SessionProvider,
        { value: session() },
        createElement(HostedAgentWizard, {
          open: true,
          onOpenChange: () => undefined,
          opener: null,
          entry: "settings",
          launch: { presetId: "grok", displayName: "그록봇", handle: "grokbot", connectionId: CONNECTION_ID },
        })
      )
    );
    act(() => root?.render(tree));

    // 승인 화면: 진행 표시 셋 중 2번이 현재, 승인 버튼은 사람이 누른다.
    await waitFor(() => q('[data-testid="hosted-confirm"]') !== null, "confirm button");
    const chips = [...document.querySelectorAll('[data-testid="hosted-step-chip"]')];
    expect(chips).toHaveLength(3);
    expect(chips[1]?.getAttribute("data-step-state")).toBe("current");
    expect(vi.mocked(confirmHostedConnection)).not.toHaveBeenCalled();
    await act(async () => {
      (q('[data-testid="hosted-channels-row"] input[type="checkbox"]') as HTMLInputElement).click();
    });
    await act(async () => {
      (q('[data-testid="hosted-confirm"]') as HTMLButtonElement).click();
    });

    // 교체 화면: 프롬프트 복사가 주 행동이고 비밀은 접힌 구획에 한 번뿐이다.
    await waitFor(() => q('[data-testid="hosted-swap-prompt-copy"]') !== null, "swap prompt");
    expect(chips.length).toBe(3);
    const preview = q('[data-testid="hosted-prompt-preview"]')?.textContent ?? "";
    expect(preview).not.toContain(ACTIVE_SECRET);
    expect((document.body.textContent ?? "").split(ACTIVE_SECRET).length - 1).toBe(1);
    expect(q('[data-testid="hosted-swap-prompt-copy"]')?.className).toContain("bg-primary");

    // 「붙여 넣었어요」 뒤 교체 표시는 이미 채워져 있다.
    await act(async () => {
      (q('[data-testid="hosted-secret-done"]') as HTMLButtonElement).click();
    });
    await waitFor(() => q('[data-testid="hosted-swap-list"]') !== null, "swap list");
    const replace = q('[data-testid="hosted-swap-row"] input[type="checkbox"]') as HTMLInputElement;
    expect(replace.checked).toBe(true);
  });
});

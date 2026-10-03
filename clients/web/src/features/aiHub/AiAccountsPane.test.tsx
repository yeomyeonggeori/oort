// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchRoster, type RosterMember } from "@momo/core/lib/api";
import { fetchWorkspace } from "@momo/core/features/settings/api";
import { listHostedConnections } from "@momo/core/features/hostedAgents/api";
import type { LocalHarnessProbe } from "@momo/core/features/hostedAgents/detect";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { AiAccountsPane } from "./AiAccountsPane";

// AIH-4 (#3399): 「내 AI 계정」. 두 가지를 못 박는다.
// - 웹에서 로그인 줄만 던지는 막다른 길이 아니다(앱 받기·열기 + 서버에 있는 내 에이전트).
// - Claude 구독 에이전트는 보수 모드(#3397) 동안 「연결됨/부를 수 있어요」라 말하지 않는다.

const envSlot = vi.hoisted(() => ({ tauri: true }));
vi.mock("@/lib/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/env")>();
  return {
    ...actual,
    get IS_TAURI() {
      return envSlot.tauri;
    },
    get SUBSCRIPTION_AGENTS_BUILD_FLAG() {
      return true;
    },
  };
});

const shell = vi.hoisted(() => ({ probes: [] as LocalHarnessProbe[] }));
vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return {
    ...actual,
    detectLocalHarnesses: vi.fn(async () => shell.probes),
    harnessProfileList: vi.fn(async () => []),
    harnessProfileStatus: vi.fn(async () => ({ id: "claude", installed: true, auth: "logged_in" })),
  };
});
vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return { ...actual, fetchRoster: vi.fn() };
});
vi.mock("@momo/core/features/settings/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/features/settings/api")>();
  return { ...actual, fetchWorkspace: vi.fn() };
});
vi.mock("@momo/core/features/hostedAgents/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/features/hostedAgents/api")>();
  return { ...actual, listHostedConnections: vi.fn() };
});

const WS = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";
const OTHER = "00000000-0000-7000-8000-000000000102";
const CLAUDE_AGENT = "00000000-0000-7000-8000-000000000301";
const CODEX_AGENT = "00000000-0000-7000-8000-000000000302";
const OTHERS_AGENT = "00000000-0000-7000-8000-000000000303";

const human = (id: string, name: string): RosterMember => ({
  id, workspaceId: WS, kind: "human", status: "active", displayName: name, handle: name, role: "owner",
  channelCount: 0, channelIds: [], capabilities: [], createdAtMs: 0, updatedAtMs: 0,
});
const agent = (id: string, name: string, owner: string): RosterMember => ({
  ...human(id, name), kind: "agent", role: undefined, ownerHumanId: owner,
});
const conn = (agentMemberId: string, harness: string) => ({
  id: `c-${agentMemberId}`, agentMemberId, status: "active", authMode: "bearer", audience: "oort",
  approvedChannelIds: [], approvedScopes: [], createdAtMs: 1, updatedAtMs: 1,
  invocationScope: "owner_only", subscriptionHarness: harness,
});

const session: SessionContextValue = {
  session: {
    accessToken: "access", refreshToken: "refresh",
    member: { id: ME, workspaceId: WS, kind: "human", displayName: "곽성재", handle: "seongjae" },
    realtimeWebSocketUrl: "wss://example.test/connection/websocket",
  },
  workspaceId: WS, realtime: null, connStatus: "connected", logout: () => undefined, replaceSessionMember: () => undefined,
};

const act_ = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root | null = null;
let host: HTMLElement | null = null;

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(
      createElement(QueryClientProvider, { client }, createElement(SessionProvider, { value: session }, createElement(AiAccountsPane))),
    );
  });
}
const q = (testId: string) => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
async function until(testId: string) {
  return waitFor(() => {
    const el = q(testId);
    if (!el) throw new Error(`missing ${testId}`);
    return el;
  });
}

beforeAll(() => {
  act_.IS_REACT_ACT_ENVIRONMENT = true;
  window.HTMLElement.prototype.scrollIntoView ??= () => undefined;
});
beforeEach(() => {
  envSlot.tauri = true;
  shell.probes = [
    { id: "claude", installed: true, auth: "logged_in" },
    { id: "codex", installed: true, auth: "needs_login" },
  ];
  localStorage.clear();
  vi.mocked(fetchRoster).mockResolvedValue([
    human(ME, "곽성재"), human(OTHER, "서연"),
    agent(CLAUDE_AGENT, "성재-claude", ME),
    agent(OTHERS_AGENT, "서연-codex", OTHER),
  ]);
  vi.mocked(listHostedConnections).mockResolvedValue({
    connections: [conn(CLAUDE_AGENT, "claude_code"), conn(OTHERS_AGENT, "codex")],
  } as never);
  vi.mocked(fetchWorkspace).mockResolvedValue({
    id: WS, slug: "team", name: "우리 팀", updatedAtMs: 1, roleLabels: {}, welcomeAgentMemberId: null, welcomePrompt: "",
    subscriptionAgentsEnabled: true,
  });
});
afterEach(() => {
  if (root) act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe("웹: 막다른 길이 아니다", () => {
  beforeEach(() => {
    envSlot.tauri = false;
  });

  it("로그인은 데스크탑에서 한다고 말하고, 앱 받기·열기 길과 내 에이전트를 보여준다", async () => {
    mount();
    await until("ai-accounts-web");
    expect(q("ai-accounts-web-notice")?.textContent).toContain("로그인은 데스크탑 앱에서 해요");
    const get = q("ai-accounts-get-app") as HTMLAnchorElement;
    const open = q("ai-accounts-open-app") as HTMLAnchorElement;
    expect(get.getAttribute("href")).toMatch(/^https:\/\//);
    expect(open.getAttribute("href")).toMatch(/^oort:\/\//);
    // 안내 한 줄만 던지고 끝나는 옛 막다른 길이 아니다.
    expect(q("subscription-entry")).toBeNull();
    expect(q("subscription-entry-detail")).toBeNull();
    expect(host?.textContent).not.toContain("이 브라우저 탭에는 이 맥의 CLI가 없어요");
    // 서버에 있는 내 에이전트(남의 에이전트는 없다).
    await until("ai-accounts-agent-claude_code");
    expect(host?.textContent).toContain("@성재-claude");
    expect(host?.textContent).not.toContain("서연-codex");
  });

  it("Claude 에이전트는 문의 중이다: 켜짐·부를 수 있어요라 하지 않는다", async () => {
    mount();
    await until("ai-accounts-agent-claude_code");
    const row = q("ai-accounts-agent-claude_code")?.textContent ?? "";
    expect(q("ai-accounts-agent-claude_code-chip")?.textContent).toBe("문의 중");
    expect(row).not.toMatch(/연결됨|부를 수 있|나만 부름|켜짐/);
  });

  it("에이전트를 못 읽으면 없다고 하지 않고 못 읽었다고 한다", async () => {
    vi.mocked(listHostedConnections).mockRejectedValue(new Error("boom"));
    mount();
    await until("ai-accounts-my-agents-error");
    expect(q("ai-accounts-my-agents-empty")).toBeNull();
  });

  it("에이전트가 없으면 빈 줄을 말한다", async () => {
    vi.mocked(listHostedConnections).mockResolvedValue({ connections: [] } as never);
    mount();
    await until("ai-accounts-my-agents-empty");
  });
});

describe("데스크탑: 구독 줄과 연결된 에이전트", () => {
  it("Claude 줄: 로그인 준비됨이어도 에이전트는 회색 문의 중이고 부를 수 있다고 하지 않는다", async () => {
    mount();
    await until("my-account-claude-agent-chip");
    expect(q("my-account-claude-state")?.textContent).toContain("준비됨");
    expect(q("my-account-claude-agent-text")?.textContent).toBe("에이전트 @성재-claude");
    expect(q("my-account-claude-agent-chip")?.textContent).toBe("문의 중");
    expect(q("my-account-claude-agent-chip")?.querySelector("[data-tone]")?.getAttribute("data-tone")).toBe("mute");
    const agentLine = q("my-account-claude-agent")?.textContent ?? "";
    expect(agentLine).not.toMatch(/연결됨|부를 수 있|나만 부름/);
    expect(q("my-account-claude-agent-detail")?.textContent).toContain("대신 구동하지 않아요");
  });

  it("Codex 줄: 에이전트가 없으면 아직 없음이고 로그인 필요 행동이 있다", async () => {
    mount();
    await until("my-account-codex-agent-text");
    expect(q("my-account-codex-agent-text")?.textContent).toBe("아직 에이전트 없음");
    expect(q("my-account-codex-agent-chip")).toBeNull();
    expect(q("my-account-codex-login")).not.toBeNull();
  });

  it("Codex 에이전트가 있으면 나만 부름이다(보수 모드는 Codex와 무관)", async () => {
    const CODEX_MINE = CODEX_AGENT;
    vi.mocked(fetchRoster).mockResolvedValue([human(ME, "곽성재"), agent(CODEX_MINE, "성재-codex", ME)]);
    vi.mocked(listHostedConnections).mockResolvedValue({ connections: [conn(CODEX_MINE, "codex")] } as never);
    mount();
    await until("my-account-codex-agent-chip");
    expect(q("my-account-codex-agent-text")?.textContent).toBe("에이전트 @성재-codex");
    expect(q("my-account-codex-agent-chip")?.textContent).toBe("나만 부름");
    // Claude 줄은 에이전트가 없고 이유 한 줄은 그대로.
    expect(q("my-account-claude-agent-text")?.textContent).toBe("아직 에이전트 없음");
    expect(q("my-account-claude-agent-detail")).not.toBeNull();
  });

  it("에이전트 목록을 못 읽으면 없다고 말하지 않는다", async () => {
    vi.mocked(listHostedConnections).mockRejectedValue(new Error("boom"));
    mount();
    await until("my-account-claude-state");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(q("my-account-claude-agent")).toBeNull();
    expect(host?.textContent).not.toContain("아직 에이전트 없음");
  });
});

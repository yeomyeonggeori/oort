// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchRoster, type RosterMember } from "@momo/core/lib/api";
import { fetchWorkspace } from "@momo/core/features/settings/api";
import { listHostedConnections } from "@momo/core/features/hostedAgents/api";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { AiAgentsPane } from "./AiAgentsPane";

vi.mock("./CreateAgentFlow", () => ({
  CreateAgentFlow: ({ onCreated }: { onCreated?: (c: { id: string }) => void }) =>
    createElement("button", { "data-testid": "fake-created", onClick: () => onCreated?.({ id: "A6" }) }, "created"),
}));

// AIH-7 (#3428): 만든 직후 그 줄을 칠하고 이름 링크로 포커스를 옮긴다.
// - 칸의 문장은 서버 값 → core 라벨. 개인 키는 「개인 키 · 나만」, Claude 구독 대행이 꺼진 에이전트는 회색 「문의 중」.
// - 웹에서 내 구독 만들기는 숨지 않고 「데스크탑에서」 사유로 잠긴다.

const envSlot = vi.hoisted(() => ({ tauri: false }));
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
vi.mock("@/features/common/useOffline", () => ({ useOffline: () => false }));

const WS = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";
const OTHER = "00000000-0000-7000-8000-000000000102";

const person = (id: string, name: string, role: RosterMember["role"]): RosterMember => ({
  id, workspaceId: WS, kind: "human", status: "active", displayName: name, handle: name, role,
  channelCount: 0, channelIds: [], capabilities: [], createdAtMs: 0, updatedAtMs: 0,
});
const bot = (id: string, name: string, extra: Partial<RosterMember>): RosterMember => ({
  ...person(id, name, undefined), kind: "agent", paused: false, ...extra,
});
const owned = (id: string, name: string) => ({ ownerHumanId: id, owner: { id, displayName: name } });

const ROSTER = (role: RosterMember["role"]): RosterMember[] => [
  person(ME, "곽성재", role),
  person(OTHER, "서연", "member"),
  bot("a1", "김인턴", { brain: "team_key", callableBy: "everyone" }),
  bot("a2", "성재-codex", { brain: "subscription", callableBy: "owner_only", hostOnline: true, ...owned(ME, "성재") }),
  bot("a3", "서연-codex", { brain: "subscription", callableBy: "owner_only", hostOnline: false, ...owned(OTHER, "서연") }),
  bot("a4", "성재-키", { brain: "personal_key", callableBy: "owner_only", ...owned(ME, "성재") }),
  bot("a5", "성재-claude", {
    brain: "subscription", callableBy: "owner_only", hostOnline: true, brainUnavailableReason: "claude_subscription_agent_paused", ...owned(ME, "성재"),
  }),
  bot("a6", "hermes", { brain: "external", callableBy: "everyone" }),
];

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

function mount(path = "/ai/agents") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(
      createElement(
        MemoryRouter,
        { initialEntries: [path] },
        createElement(QueryClientProvider, { client }, createElement(SessionProvider, { value: session }, createElement(AiAgentsPane)))
      )
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
  envSlot.tauri = false;
  vi.mocked(fetchRoster).mockResolvedValue(ROSTER("owner"));
  vi.mocked(listHostedConnections).mockResolvedValue({ connections: [] } as never);
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
  document.body.innerHTML = "";
});


describe("방금 만든 줄", () => {
  it("만들기 완료 뒤 그 줄을 칠하고 이름 링크로 포커스를 옮겼다가, 칠은 곧 사라진다", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mount();
      await until("ai-agents-table");
      expect(q("ai-agent-row-hermes")?.hasAttribute("data-just-created")).toBe(false);
      act(() => fireEvent.click(q("fake-created") as HTMLElement));
      expect(q("ai-agent-row-hermes")?.getAttribute("data-just-created")).toBe("true");
      expect(q("ai-agent-row-hermes")?.className).toContain("bg-accent-soft");
      await act(async () => {
        vi.advanceTimersByTime(500);
      });
      expect(document.activeElement).toBe(q("ai-agent-link-hermes"));
      await act(async () => {
        vi.advanceTimersByTime(3000);
      });
      expect(q("ai-agent-row-hermes")?.hasAttribute("data-just-created")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { fetchRoster, type RosterMember } from "@momo/core/lib/api";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { AgentHubRoute } from "./AgentHubRoute";

// #3821: 에이전트 목록의 앞 칸은 로봇 아이콘이 아니라 에이전트 아바타(사진 또는 이니셜)다.
// 선택된 에이전트의 프로필 탭 맨 위에는 프로필 카드가 선다.

vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return { ...actual, fetchRoster: vi.fn(), fetchAgentProfile: vi.fn(async () => ({})) };
});
vi.mock("@/features/common/useOffline", () => ({ useOffline: () => false }));
vi.mock("@/app/SidebarDrawerToggle", () => ({ SidebarDrawerToggle: () => null }));

const WS = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";
const A1 = "00000000-0000-7000-8000-000000000301";
const row = (id: string, name: string, kind: "human" | "agent"): RosterMember => ({
  id, workspaceId: WS, kind, status: "active", displayName: name, handle: name,
  role: kind === "human" ? "owner" : undefined,
  channelCount: 0, channelIds: [], capabilities: [], createdAtMs: 0, updatedAtMs: 0, paused: false,
});
const session: SessionContextValue = {
  session: {
    accessToken: "a", refreshToken: "r",
    member: { id: ME, workspaceId: WS, kind: "human", displayName: "곽성재", handle: "seongjae" },
    realtimeWebSocketUrl: "wss://example.test/connection/websocket",
  },
  workspaceId: WS, realtime: null, connStatus: "connected", logout: () => undefined, replaceSessionMember: () => undefined,
};
const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root | null = null;
let host: HTMLElement | null = null;
beforeAll(() => {
  env.IS_REACT_ACT_ENVIRONMENT = true;
  window.HTMLElement.prototype.scrollIntoView ??= () => undefined;
});
afterEach(() => {
  if (root) act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  document.body.innerHTML = "";
});

describe("에이전트 허브 아바타", () => {
  it("목록 행은 에이전트 아바타를 갖고, 프로필 탭 맨 위는 프로필 카드이며 admin에게는 이름 바꾸기가 열린다", async () => {
    vi.mocked(fetchRoster).mockResolvedValue([row(ME, "곽성재", "human"), row(A1, "가나다", "agent")]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => {
      root?.render(
        createElement(
          MemoryRouter,
          { initialEntries: ["/agents"] },
          createElement(QueryClientProvider, { client }, createElement(SessionProvider, { value: session }, createElement(AgentHubRoute)))
        )
      );
    });
    await waitFor(() => expect(document.querySelector("[data-testid='agent-hub-agent-row']")).not.toBeNull());
    const listRow = document.querySelector("[data-testid='agent-hub-agent-row']") as HTMLElement;
    const avatar = listRow.querySelector("[data-testid='member-avatar']");
    expect(avatar?.getAttribute("data-avatar-kind")).toBe("agent");
    expect(avatar?.textContent).toBe("가");
    expect(listRow.querySelector("svg.lucide-bot")).toBeNull();
    await waitFor(() => expect(document.querySelector("[data-testid='agent-identity-card']")).not.toBeNull());
    expect(document.querySelector("[data-testid='agent-identity-edit']")).not.toBeNull();
  });
});

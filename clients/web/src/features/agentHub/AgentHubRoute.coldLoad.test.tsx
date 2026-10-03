// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchRoster, type RosterMember } from "@momo/core/lib/api";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { AgentHubRoute } from "./AgentHubRoute";

// AIH-7 (#3428): `/agents?agent=<id>` 로 처음 열면(새로고침 포함) 명부가 오기 전에 선택을 지우고 첫 줄을 고르면 안 된다.

vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return { ...actual, fetchRoster: vi.fn(), fetchAgentProfile: vi.fn(async () => ({})) };
});
vi.mock("@/features/common/useOffline", () => ({ useOffline: () => false }));
vi.mock("@/app/SidebarDrawerToggle", () => ({ SidebarDrawerToggle: () => null }));

const WS = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";
const row = (id: string, name: string, kind: "human" | "agent", extra: Partial<RosterMember> = {}): RosterMember => ({
  id, workspaceId: WS, kind, status: "active", displayName: name, handle: name, role: kind === "human" ? "owner" : undefined,
  channelCount: 0, channelIds: [], capabilities: [], createdAtMs: 0, updatedAtMs: 0, paused: false, ...extra,
});
const A1 = "00000000-0000-7000-8000-000000000301";
const A2 = "00000000-0000-7000-8000-000000000302";
const ROSTER = [row(ME, "곽성재", "human"), row(A1, "가나다", "agent"), row(A2, "하하하", "agent")];

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
function Where() {
  const loc = useLocation();
  return createElement("span", { "data-testid": "where" }, loc.search);
}
function mount(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(
      createElement(
        MemoryRouter,
        { initialEntries: [path] },
        createElement(
          QueryClientProvider,
          { client },
          createElement(SessionProvider, { value: session }, createElement(AgentHubRoute), createElement(Where))
        )
      )
    );
  });
}
const selectedIds = () =>
  [...document.querySelectorAll("[data-testid='agent-hub-agent-row']")]
    .filter((e) => e.getAttribute("aria-current") === "page")
    .map((e) => e.getAttribute("data-agent-id"));

beforeAll(() => {
  env.IS_REACT_ACT_ENVIRONMENT = true;
  window.HTMLElement.prototype.scrollIntoView ??= () => undefined;
});
beforeEach(() => {
  // 명부가 늦게 온다: 처음에는 빈 목록이다.
  vi.mocked(fetchRoster).mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(ROSTER), 50)));
});
afterEach(() => {
  if (root) act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  document.body.innerHTML = "";
});

describe("/agents?agent= 처음 열기", () => {
  it("명부가 오기 전에 선택을 지우지 않아서, 온 뒤에 첫 줄이 아니라 ?agent= 의 에이전트가 선택된다", async () => {
    mount(`/agents?agent=${A2}`);
    await waitFor(() => expect(document.querySelectorAll("[data-testid='agent-hub-agent-row']").length).toBe(2));
    expect(selectedIds()).toEqual([A2.toLowerCase()]);
  });

  it("?agent= 이 없거나 모르는 값이면 예전처럼 첫 줄", async () => {
    mount(`/agents?agent=00000000-0000-7000-8000-0000000009ff`);
    await waitFor(() => expect(document.querySelectorAll("[data-testid='agent-hub-agent-row']").length).toBe(2));
    expect(selectedIds()).toEqual([A1.toLowerCase()]);
  });

  it("다른 에이전트를 고르면 주소의 ?agent= 도 따라가고, 기록을 쌓지 않는다(replace)", async () => {
    mount(`/agents?agent=${A2}`);
    await waitFor(() => expect(document.querySelectorAll("[data-testid='agent-hub-agent-row']").length).toBe(2));
    const first = document.querySelector(`[data-agent-id='${A1.toLowerCase()}']`) as HTMLElement;
    act(() => fireEvent.click(first));
    expect(selectedIds()).toEqual([A1.toLowerCase()]);
    expect(document.querySelector("[data-testid='where']")?.textContent).toBe(`?agent=${A1.toLowerCase()}`);
  });
});

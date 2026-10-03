// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { accountsCard, agentsCard, externalCard, teamKeysCard, READ_LOADING } from "./aiHubOverviewModel";

vi.mock("@/app/session", () => ({
  useSession: () => ({
    workspaceId: "w1",
    session: { member: { id: "m1", kind: "human" } },
  }),
}));
vi.mock("@/app/SidebarDrawerToggle", () => ({ SidebarDrawerToggle: () => null }));
vi.mock("@/features/common/useOffline", () => ({ useOffline: () => false }));
vi.mock("@/features/workspace/useWorkspace", () => ({
  useDirectory: () => ({ isPending: false, directory: { members: [], byId: new Map() } }),
}));
vi.mock("@momo/core/features/workspace/directory", () => ({
  memberFor: () => ({ role: "owner" }),
}));
vi.mock("./useAiHubOverview", () => ({
  useAiHubOverview: () => ({
    cards: [
      accountsCard({ kind: "web" }),
      teamKeysCard({ state: "denied" }),
      agentsCard({ roster: { state: "ok", value: [] }, connections: READ_LOADING }),
      externalCard({
        apps: READ_LOADING,
        incoming: READ_LOADING,
        outgoing: READ_LOADING,
        externalAgents: READ_LOADING,
      }),
    ],
    nudge: false,
  }),
}));
const stub = (id: string) => () => createElement("div", { "data-testid": `ai-hub-pane-${id}` }, id);
vi.mock("./AiAccountsPane", () => ({ AiAccountsPane: stub("accounts") }));
vi.mock("./AiAgentsPane", () => ({ AiAgentsPane: stub("agents") }));
vi.mock("./AiExternalPane", () => ({ AiExternalPane: stub("external") }));

vi.mock("./AiTeamKeysPane", () => ({
  AiTeamKeysPane: () => createElement("div", { "data-testid": "ai-hub-pane-teamKeys" }, "teamKeys"),
}));

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  if (root) act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

async function mountAt(path: string): Promise<HTMLElement> {
  const { AiHubRoute } = await import("./AiHubRoute");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(
      createElement(
        MemoryRouter,
        { initialEntries: [path] },
        createElement(Routes, null, createElement(Route, { path: "ai/*", element: createElement(AiHubRoute) }))
      )
    );
  });
  return host;
}

describe("AI 허브 라우트 (AIH-3)", () => {
  it.each([
    ["/ai/accounts", "accounts"],
    ["/ai/team-keys", "teamKeys"],
    ["/ai/agents", "agents"],
    ["/ai/external", "external"],
  ])("%s 는 %s 구획 본문을 세운다", async (path, pane) => {
    const el = await mountAt(path);
    expect(el.querySelector(`[data-testid="ai-hub-pane-${pane}"]`)).not.toBeNull();
    expect(el.querySelector('[data-testid="ai-hub-overview"]')).toBeNull();
  });

  it("/ai 는 개요: 용어집 이름의 카드 넷과 구획으로 가는 링크", async () => {
    const el = await mountAt("/ai");
    const cards = [...el.querySelectorAll('[data-testid^="ai-hub-card-"]')].map((n) => n.querySelector("h2")?.textContent);
    expect(cards).toEqual(["내 AI 계정", "팀 AI 키", "에이전트", "외부 연결"]);
    const hrefs = [...el.querySelectorAll('a[data-testid^="ai-hub-open-"]')].map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(["/ai/accounts", "/ai/team-keys", "/ai/agents", "/ai/external"]);
    expect(el.querySelector('[data-testid="ai-hub-create-agent"]')?.getAttribute("href")).toBe("/ai/agents?create=1");
  });

  it("탭은 개요와 네 구획이고 현재 자리가 aria-current다", async () => {
    const el = await mountAt("/ai/external");
    const current = [...el.querySelectorAll('[data-testid="ai-hub-tabs"] [aria-current="page"]')].map((a) => a.textContent);
    expect(current).toEqual(["외부 연결"]);
    expect(el.querySelectorAll('[data-testid="ai-hub-tabs"] a')).toHaveLength(5);
  });

  it("제목은 AI, 부제는 모델 문구", async () => {
    const el = await mountAt("/ai");
    expect(el.querySelector("h1")?.textContent).toBe("AI");
    expect(el.textContent).toContain("누가 어떤 AI를 쓰는지, 누가 부를 수 있는지, 비용이 누구 몫인지 한 곳에서 봐요.");
  });
});

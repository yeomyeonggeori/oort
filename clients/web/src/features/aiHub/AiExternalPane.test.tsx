// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { findLegacyTerms, AI_EXTERNAL_ROWS, AI_EXTERNAL_COPY } from "@momo/core/features/ai/aiHubModel";
import type { ExternalInput } from "./aiHubOverviewModel";

// AIH-8 (#3438): 「외부 연결」 목차와 상세 라우트. 본문 구획은 자리표시자로 바꿔 라우팅만 본다.

const reads = vi.hoisted(() => ({
  input: {} as ExternalInput,
  bots: { state: "ok", value: 1 } as { state: "ok"; value: number } | { state: "denied" },
}));
vi.mock("./useAiHubOverview", () => ({
  useExternalReads: () => ({ input: reads.input, hosted: {}, hostedBots: reads.bots }),
}));
const body = (id: string) => () => createElement("div", { "data-testid": `body-${id}` });
vi.mock("@/features/plugins/PluginSection", () => ({ PluginSection: body("apps") }));
vi.mock("@/features/settings/WebhookSection", () => ({ WebhookSection: body("incoming") }));
vi.mock("@/features/settings/EventSubscriptionSection", () => ({ EventSubscriptionSection: body("outgoing") }));
vi.mock("@/features/settings/AgentCredentialsSection", () => ({ AgentCredentialsSection: body("agents") }));

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
  const { AiExternalPane } = await import("./AiExternalPane");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root?.render(
      createElement(
        MemoryRouter,
        { initialEntries: [`/ai/external${path === "/" ? "" : path}`] },
        createElement(
          Routes,
          null,
          createElement(Route, {
            path: "/ai/external/*",
            element: createElement(AiExternalPane, { offline: false, workspaceId: "w1", memberId: "m1" }),
          })
        )
      )
    )
  );
  return host;
}

const OK = (value: number) => ({ state: "ok" as const, value });

describe("외부 연결 목차 (AIH-8)", () => {
  it("다섯 줄: 용어집 이름, 옛 이름 괄호(영어 약자 없음), 열기 링크", async () => {
    reads.input = { apps: OK(2), incoming: OK(1), outgoing: OK(2), externalAgents: OK(1) };
    const el = await mountAt("/");
    const rows = [...el.querySelectorAll('[data-testid^="ai-external-row-"]')];
    expect(rows.map((r) => r.querySelector("h3")?.firstChild?.textContent)).toEqual([
      "앱",
      "채널로 들어오는 주소",
      "밖으로 보내는 알림",
      "외부 에이전트 연결",
      "호스티드 봇 초대",
    ]);
    const hrefs = AI_EXTERNAL_ROWS.map((row) => el.querySelector(`[data-testid="ai-external-open-${row.id}"]`)?.getAttribute("href"));
    expect(hrefs).toEqual([
      "/ai/external/apps",
      "/ai/external/incoming",
      "/ai/external/outgoing",
      "/ai/external/agents",
      "/ai/agents?create=1",
    ]);
    expect(el.textContent).not.toMatch(/MCP|Agent Port/);
    expect(el.textContent).not.toContain("합류");
    expect(el.querySelector('[data-testid="ai-external-permission"]')?.textContent).toBe(AI_EXTERNAL_COPY.permission);
    expect(el.querySelector('[data-testid="ai-external-code-host-link"]')?.getAttribute("href")).toBe("/settings?section=code");
  });

  it("개수 칩: 읽은 값만 센다. 권한이 없으면 숫자 대신 안내, 읽는 중에는 칩이 없다", async () => {
    reads.input = {
      apps: OK(0),
      incoming: { state: "denied" },
      outgoing: { state: "error" },
      externalAgents: { state: "loading" },
    };
    const el = await mountAt("/");
    const chip = (id: string) => el.querySelector(`[data-testid="ai-external-chip-${id}"]`)?.textContent ?? null;
    expect(chip("apps")).toBe("설치 0");
    expect(chip("incoming")).toBe("소유자·관리자만 볼 수 있어요");
    expect(chip("outgoing")).toBe("읽지 못했어요");
    expect(chip("externalAgents")).toBeNull();
    expect(chip("hostedBotInvite")).toBe("봇 1");
    reads.bots = { state: "denied" };
    act(() => root?.unmount());
    host?.remove();
    const again = await mountAt("/");
    expect(again.querySelector('[data-testid="ai-external-chip-hostedBotInvite"]')?.textContent).toBe("소유자·관리자만 볼 수 있어요");
    reads.bots = { state: "ok", value: 1 };
  });

  it("새 문구가 옛 말(합류 등)을 되살리지 않는다", () => {
    for (const row of AI_EXTERNAL_ROWS) {
      for (const text of [row.title, row.summary, ...row.detail]) expect(findLegacyTerms(text), text).toEqual([]);
    }
    expect(findLegacyTerms(AI_EXTERNAL_COPY.permission)).toEqual([]);
  });
});

describe("외부 연결 상세 (AIH-8)", () => {
  it.each([
    ["/apps", "apps", "앱"],
    ["/incoming", "incoming", "채널로 들어오는 주소"],
    ["/outgoing", "outgoing", "밖으로 보내는 알림"],
    ["/agents", "agents", "외부 에이전트 연결"],
  ])("%s 는 본문을 그대로 세우고 머리는 용어집 이름이다", async (path, id, title) => {
    reads.input = { apps: OK(0), incoming: OK(0), outgoing: OK(0), externalAgents: OK(0) };
    const el = await mountAt(path);
    expect(el.querySelector(`[data-testid="body-${id}"]`)).not.toBeNull();
    expect(el.querySelector("h2")?.firstChild?.textContent).toBe(title);
    expect(el.querySelector('[data-testid="ai-external-back"]')?.getAttribute("href")).toBe("/ai/external");
  });

  it("상세에 들어오면 제목으로 포커스가 가고, 돌아오면 그 줄의 열기로 돌아온다", async () => {
    reads.input = { apps: OK(0), incoming: OK(0), outgoing: OK(0), externalAgents: OK(0) };
    const el = await mountAt("/incoming");
    expect(document.activeElement).toBe(el.querySelector("h2"));
    act(() => (el.querySelector('[data-testid="ai-external-back"]') as HTMLElement).click());
    expect(document.activeElement).toBe(el.querySelector('[data-testid="ai-external-open-incoming"]'));
    expect(el.querySelector('[data-testid="ai-external-open-incoming"]')?.getAttribute("aria-labelledby")).toContain("ai-external-row-title-incoming");
  });

  it("외부 에이전트 연결의 머리 괄호에서만 영어 약자가 선다", async () => {
    const el = await mountAt("/agents");
    expect(el.querySelector("h2")?.textContent).toContain("MCP");
    expect(el.querySelector("h2")?.textContent).toContain("Agent Port");
  });

  it("모르는 하위 주소는 목차로 돌아온다", async () => {
    reads.input = { apps: OK(0), incoming: OK(0), outgoing: OK(0), externalAgents: OK(0) };
    const el = await mountAt("/nope");
    expect(el.querySelector('[data-testid="ai-external-row-apps"]')).not.toBeNull();
  });
});

// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { channelActionAvailability, channelActionItemsForSurface } from "@momo/core/features/channels/actionModel";
import { GITHUB_PLUGIN_ID, githubFacesFor } from "@momo/core/features/github/model";

// serverSurfaces 숨김 시험 (#3955 수용): 서버가 GitHub 알림을 싣지 않으면
//   · 채널 ⋮ 에 「GitHub 알림」이 없고
//   · AI › 외부 연결 목차에 줄이 없고
//   · 「앱」 GitHub 카드는 알림 얼굴 없이 도구 얼굴만 말한다.

const surface = vi.hoisted(() => ({ github: true }));
vi.mock("@momo/core/features/capabilities/serverSurfaces", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/features/capabilities/serverSurfaces")>();
  return {
    ...actual,
    isSurfaceProvided: (id: Parameters<typeof actual.isSurfaceProvided>[0]) =>
      id === "githubNotifications" ? surface.github : actual.isSurfaceProvided(id),
  };
});
vi.mock("./GithubPane", () => ({ GithubPane: () => createElement("div", { "data-testid": "body-github" }) }));
vi.mock("@/features/plugins/PluginSection", () => ({ PluginSection: () => null }));
vi.mock("@/features/settings/WebhookSection", () => ({ WebhookSection: () => null }));
vi.mock("@/features/settings/EventSubscriptionSection", () => ({ EventSubscriptionSection: () => null }));
vi.mock("@/features/settings/AgentCredentialsSection", () => ({ AgentCredentialsSection: () => null }));
vi.mock("@/features/hostedAgents/PersonalAssistantsList", () => ({ PersonalAssistantsList: () => null }));
vi.mock("@/features/aiHub/useAiHubOverview", () => ({
  useExternalReads: () => ({
    input: {
      apps: { state: "ok", value: 1 },
      incoming: { state: "ok", value: 0 },
      outgoing: { state: "ok", value: 0 },
      externalAgents: { state: "ok", value: 0 },
    },
    hosted: {},
    hostedBots: { state: "ok", value: 0 },
  }),
  useAppsRead: () => ({ state: "ok", value: 1 }),
}));

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  if (root) act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  surface.github = true;
});

async function mountHub(): Promise<HTMLElement> {
  const { AiExternalPane } = await import("@/features/aiHub/AiExternalPane");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root?.render(
      createElement(
        MemoryRouter,
        { initialEntries: ["/ai/external"] },
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

const CHANNEL = { kind: "public" as const, topic: "" };
const available = (over: Partial<Parameters<typeof channelActionAvailability>[0]> = {}) =>
  channelActionAvailability({
    channel: CHANNEL,
    selfRole: "owner",
    unreadCount: 0,
    hasGithubNotifications: true,
    ...over,
  });
const headerKeys = (over: Partial<Parameters<typeof channelActionAvailability>[0]> = {}) =>
  channelActionItemsForSurface("header", available(over), { muted: false, copiedLink: false, copiedName: false }).map(
    (item) => item.key
  );

describe("채널 ⋮ 의 GitHub 알림", () => {
  it("서버가 싣고 소유자·관리자이고 DM 이 아니면 헤더 메뉴에 선다", () => {
    expect(headerKeys()).toContain("github");
    expect(headerKeys({ selfRole: "admin" })).toContain("github");
    // 역할을 아직 모르면 내놓고 서버가 답하게 둔다.
    expect(headerKeys({ selfRole: undefined })).toContain("github");
  });

  it("서버가 싣지 않으면 항목이 없다", () => {
    expect(headerKeys({ hasGithubNotifications: false })).not.toContain("github");
    expect(headerKeys({ hasGithubNotifications: undefined })).not.toContain("github");
  });

  it("일반 멤버와 게스트와 DM 에는 항목이 없다", () => {
    expect(headerKeys({ selfRole: "member" })).not.toContain("github");
    expect(headerKeys({ selfRole: "guest" })).not.toContain("github");
    expect(headerKeys({ channel: { kind: "dm", topic: "" } })).not.toContain("github");
  });

  it("행 우클릭에는 서지 않는다(구독은 채널 안에서 하는 일이다)", () => {
    const rowKeys = channelActionItemsForSurface("row", available(), {
      muted: false,
      copiedLink: false,
      copiedName: false,
    }).map((item) => item.key);
    expect(rowKeys).not.toContain("github");
  });

  it("항목의 이름은 「GitHub 알림」이고 알림 무리에 선다", () => {
    const item = channelActionItemsForSurface("header", available(), {
      muted: false,
      copiedLink: false,
      copiedName: false,
    }).find((candidate) => candidate.key === "github");
    expect(item?.label).toBe("GitHub 알림");
    expect(item?.cluster).toBe("state");
  });
});

describe("AI › 외부 연결 목차", () => {
  it("서버가 싣는 날에는 「GitHub 알림」 줄이 선다", async () => {
    const el = await mountHub();
    expect(el.querySelector('[data-testid="ai-external-row-github"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="ai-external-chip-github"]')).toBeNull();
  });

  it("서버가 싣지 않는 날에는 줄도 열기 링크도 없다", async () => {
    surface.github = false;
    const el = await mountHub();
    expect(el.querySelector('[data-testid="ai-external-row-github"]')).toBeNull();
    expect(el.querySelector('[data-testid="ai-external-open-github"]')).toBeNull();
    // 다른 줄은 그대로다.
    expect(el.querySelector('[data-testid="ai-external-row-apps"]')).not.toBeNull();
  });
});

describe("「앱」 GitHub 카드의 얼굴", () => {
  it("서버가 싣는 날에는 알림과 도구 두 얼굴", () => {
    expect(githubFacesFor(GITHUB_PLUGIN_ID).map((face) => face.id)).toEqual(["notify", "tools"]);
  });

  it("서버가 싣지 않는 날에는 도구 얼굴만 남는다", () => {
    surface.github = false;
    expect(githubFacesFor(GITHUB_PLUGIN_ID).map((face) => face.id)).toEqual(["tools"]);
  });

  it("GitHub 가 아닌 앱에는 얼굴이 없다", () => {
    expect(githubFacesFor("com.momo.plugins.notion")).toEqual([]);
    expect(githubFacesFor("com.momo.plugins.drive")).toEqual([]);
  });

  it("대소문자가 달라도 같은 앱으로 읽는다", () => {
    expect(githubFacesFor(GITHUB_PLUGIN_ID.toUpperCase()).length).toBe(2);
  });
});

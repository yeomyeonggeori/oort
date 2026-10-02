// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FeedItem } from "@momo/core/features/inbox/model";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import type { Feed } from "@/features/inbox/useInbox";
import { ActivityRoute } from "./ActivityRoute";

const WS = "00000000-0000-7000-8000-000000000001";
const MEMBER_ID = "00000000-0000-7000-8000-000000000101";
const CH = "00000000-0000-7000-8000-000000000201";
const NOW = 1_800_000_000_000;

vi.mock("@/app/SidebarDrawerToggle", () => ({
  SidebarDrawerToggle: () => null,
}));

const ITEM: FeedItem = {
  key: "row-1",
  kind: "approval",
  tone: "warn",
  actor: "김인턴",
  actorIsAgent: true,
  predicate: "세션을 마치려고 합니다.",
  outcome: null,
  outcomeTone: "muted",
  channelId: CH,
  channelLabel: "엔진",
  timeLabel: "방금",
  sortAtMs: NOW,
  pending: true,
  reason: "실행 허가",
};

const RUN: FeedItem = {
  ...ITEM,
  key: "run-1",
  kind: "run",
  tone: "agent",
  predicate: "작업을 실행했습니다",
  outcome: "완료",
  outcomeTone: "ok",
  pending: false,
};
const DECIDED: FeedItem = { ...ITEM, key: "ap-done", pending: false, outcome: "승인됨", outcomeTone: "ok" };

const feed: Feed = {
  items: [ITEM, RUN, DECIDED],
  isLoading: false,
  error: false,
  absent: false,
  updatedAtMs: NOW,
  refetch: () => undefined,
};

const lastOptions: { ownedBy?: string } = {};
vi.mock("@/features/inbox/useInbox", () => ({
  useAgentFeed: (_enabled: boolean, options: { ownedBy?: string } = {}) => {
    lastOptions.ownedBy = options.ownedBy;
    return feed;
  },
}));

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

async function mount(): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  mountedHost = host;
  mountedRoot = createRoot(host);
  const tree: ReactElement = createElement(
    SessionProvider,
    { value: sessionValue() },
    createElement(
      MemoryRouter,
      { initialEntries: ["/activity"] },
      createElement(ActivityRoute)
    )
  );
  await act(async () => {
    mountedRoot?.render(tree);
    await Promise.resolve();
  });
  return host;
}

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  feed.items = [ITEM, RUN, DECIDED];
  lastOptions.ownedBy = undefined;
  feed.isLoading = false;
  feed.absent = false;
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
});

afterEach(() => {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  mountedHost?.remove();
  mountedHost = null;
  vi.unstubAllGlobals();
});

const rows = (host: HTMLElement) =>
  [...host.querySelectorAll('[data-testid="activity-list"] > li')].length;

async function pick(host: HTMLElement, filter: string) {
  await act(async () => {
    (host.querySelector(`[data-testid="activity-tab-${filter}"]`) as HTMLElement).click();
    await Promise.resolve();
  });
}

describe("활동 필터 칩 (#3337)", () => {
  it("칩 네 개가 서고 개수는 달지 않는다", async () => {
    const host = await mount();
    const tabs = [...host.querySelectorAll('[role="tab"]')].map((t) => t.textContent);
    expect(tabs).toEqual(["전체", "내 에이전트", "승인", "작업 끝남"]);
  });

  it("전체는 세 행, 승인은 승인 행만, 작업 끝남은 끝난 실행만 보인다", async () => {
    const host = await mount();
    expect(rows(host)).toBe(3);
    await pick(host, "approvals");
    expect(rows(host)).toBe(2);
    await pick(host, "done");
    expect(rows(host)).toBe(1);
    await pick(host, "all");
    expect(rows(host)).toBe(3);
  });

  it("내 에이전트 칩은 담당 판정(ownedBy)을 내 멤버 id로 원천에 건다", async () => {
    const host = await mount();
    expect(lastOptions.ownedBy).toBeUndefined();
    await pick(host, "mine");
    expect(lastOptions.ownedBy).toBe(MEMBER_ID);
  });

  it("대기 중인 승인 행만 인박스로 건너가는 링크를 단다 (활동에서는 결정하지 않는다)", async () => {
    const host = await mount();
    const links = host.querySelectorAll('[data-testid="activity-pending-link"]');
    expect(links.length).toBe(1);
    expect(links[0]?.getAttribute("href")).toBe("/inbox");
    expect(host.querySelector('[data-testid="inbox-approval-actions"]')).toBeNull();
  });

  it("필터 결과가 비면 그 칩의 빈 상태를 보인다", async () => {
    feed.items = [ITEM];
    const host = await mount();
    await pick(host, "done");
    expect(host.querySelector('[data-testid="activity-empty"]')?.textContent).toContain(
      "끝난 작업이 아직 없습니다."
    );
  });
});

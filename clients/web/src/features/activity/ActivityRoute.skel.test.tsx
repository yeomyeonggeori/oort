// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FeedItem } from "@momo/core/features/inbox/model";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import type { AppLocale } from "@/i18n/localeStore";
import { koreanLocale } from "@/testing/koLocale";
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

const feed: Feed = {
  items: [ITEM],
  isLoading: false,
  error: false,
  absent: false,
  updatedAtMs: NOW,
  refetch: () => undefined,
};

vi.mock("@/features/inbox/useInbox", () => ({
  useAgentFeed: () => feed,
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

let ko: AppLocale;
/** `korean`은 사전 문장을 단정하는 시험만 켠다(공급자가 없으면 번들된 영어로 물러난다). */
async function mount(korean = false): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  mountedHost = host;
  mountedRoot = createRoot(host);
  const page: ReactElement = createElement(
    SessionProvider,
    { value: sessionValue() },
    createElement(
      MemoryRouter,
      { initialEntries: ["/activity"] },
      createElement(ActivityRoute)
    )
  );
  await act(async () => {
    mountedRoot?.render(korean ? createElement(LocaleProvider, { locale: ko, children: page }) : page);
    await Promise.resolve();
  });
  return host;
}

beforeAll(async () => {
  ko = await koreanLocale();
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  feed.items = [ITEM];
  feed.isLoading = false;
  feed.error = false;
  feed.refetch = () => undefined;
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

describe("ActivityRoute skeleton host", () => {
  it("wraps the activity list inside Skeleton (moving the list out turns this red)", async () => {
    const host = await mount();
    const list = host.querySelector('[data-testid="activity-list"]');
    const skel = host.querySelector(
      '[data-testid="activity-route"] [data-testid="skeleton"]'
    );
    expect(list).not.toBeNull();
    expect(skel).not.toBeNull();
    expect(skel?.contains(list)).toBe(true);
    expect(skel?.getAttribute("data-ready")).toBe("true");
    expect(skel?.querySelector(".skel-content")).toBeTruthy();
  });

  it("stays data-ready=false while the feed is loading (ready={true} turns this red)", async () => {
    feed.items = [];
    feed.isLoading = true;
    const host = await mount();
    const skel = host.querySelector(
      '[data-testid="activity-route"] [data-testid="skeleton"]'
    );
    expect(skel).not.toBeNull();
    expect(skel?.getAttribute("data-ready")).toBe("false");
  });
});

// #5242: 활동을 불러오지 못했을 때. 옛 「활동을 불러오지 못했습니다.」 배너는 원인 상자다. 피드 훅은 오류를 불리언으로만 내므로
// 원인은 기기가 아는 사실 하나(꺼져 있는가)로 갈린다.
describe("ActivityRoute: 불러오기 실패 (#5242)", () => {
  // 지키는 것: 보여 줄 줄이 없을 때만 상자(제목 + 이유 + 다시 시도). 줄이 있으면 상자로 덮지 않는다.
  it("줄이 없으면 원인 상자가 서고 이유가 기기 상태를 따라가며, 다시 시도가 피드를 다시 읽는다", async () => {
    const cases: [boolean, string, string][] = [
      [false, "deviceOffline", "오프라인이에요. 연결되면 다시 불러올 수 있어요."],
      [true, "", "문제가 생겼어요. 다시 시도해 주세요."],
    ];
    for (const [online, cause, reason] of cases) {
      vi.spyOn(globalThis.navigator, "onLine", "get").mockReturnValue(online);
      const refetch = vi.fn();
      feed.items = [];
      feed.error = true;
      feed.refetch = refetch;
      const host = await mount(true);
      const box = host.querySelector<HTMLElement>('[data-testid="activity-error"]');
      expect(box, reason).not.toBeNull();
      expect(box?.getAttribute("role")).toBe("alert");
      expect(box?.getAttribute("data-cause") ?? "").toBe(cause);
      expect(box?.textContent).toContain("활동을 불러오지 못했어요");
      expect(box?.querySelector('[data-testid="load-failure-reason"]')?.textContent).toBe(reason);
      expect(host.textContent).not.toContain("활동을 불러오지 못했습니다");
      await act(async () => {
        box?.querySelector("button")?.click();
      });
      expect(refetch).toHaveBeenCalledTimes(1);
      act(() => mountedRoot?.unmount());
      mountedHost?.remove();
      mountedRoot = null;
      mountedHost = null;
      vi.restoreAllMocks();
    }
  });

  it("받아 둔 줄이 있으면 오류여도 상자 없이 줄이 선다", async () => {
    feed.error = true;
    const host = await mount(true);
    expect(host.querySelector('[data-testid="activity-error"]')).toBeNull();
    expect(host.querySelector('[data-testid="activity-list"]')).not.toBeNull();
  });
});

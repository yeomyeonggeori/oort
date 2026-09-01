// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Channel, MessageSearchHit } from "@momo/core/lib/api";
import {
  ESCALATE_TO_WORKSPACE_LABEL,
  searchScopeLabel,
} from "@momo/core/features/search/searchModel";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { SearchRoute } from "./SearchRoute";

// =============================================================================
// 검색 범위 칩이 실제로 요청을 바꾸는가 (BT-3 / #1931).
//
// 범위 어휘와 캐시 키 규칙은 코어에서 시험된다(searchModel.test.ts). 여기서만
// 볼 수 있는 것은 **셋이 한 화면에서 맞물리는가**다: 칩을 누르면 새 요청이
// 나가는가, 그 요청이 이전 범위의 커서를 물고 가지 않는가, 빈 결과가 범위에
// 따라 다른 말을 하는가.
//
// 계약 원문: server-rust/bins/momo-server/src/routes/search.rs
// =============================================================================

const WS = "00000000-0000-7000-8000-000000000001";
const MEMBER_ID = "00000000-0000-7000-8000-000000000101";
const CH_DEPLOY = "00000000-0000-7000-8000-000000000201";
const AUTHOR = "00000000-0000-7000-8000-000000000102";

const searchMessages = vi.hoisted(() => vi.fn());

vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return {
    ...actual,
    searchMessages: (...args: unknown[]) => searchMessages(...args),
  };
});

vi.mock("@/app/SidebarDrawerToggle", () => ({
  SidebarDrawerToggle: () => null,
}));

const channels: Channel[] = [
  {
    id: CH_DEPLOY,
    workspaceId: WS,
    kind: "public",
    name: "배포",
    muted: false,
  },
];

vi.mock("@/features/workspace/useWorkspace", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/workspace/useWorkspace")>();
  return {
    ...actual,
    useChannels: () => ({
      isPending: false,
      isSuccess: true,
      isError: false,
      data: channels,
      groups: { channels, dms: [] },
      refetch: () => undefined,
    }),
    useDirectory: () => ({
      directory: actual.makeDirectory([]),
      isPending: false,
      refetch: () => undefined,
    }),
  };
});

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let mountedRoot: Root | null = null;
let mountedHost: HTMLElement | null = null;

function hit(id: string): MessageSearchHit {
  return {
    channelId: CH_DEPLOY,
    messageId: id,
    authorMemberId: AUTHOR,
    seq: 1,
    createdAtMs: 1_800_000_000_000,
    snippet: "배포 준비 끝났습니다",
    matchOffset: 0,
  };
}

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

async function mountAt(path: string): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  mountedHost = host;
  mountedRoot = createRoot(host);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const tree: ReactElement = createElement(
    QueryClientProvider,
    { client },
    createElement(
      SessionProvider,
      { value: sessionValue() },
      createElement(
        MemoryRouter,
        { initialEntries: [path] },
        createElement(
          Routes,
          null,
          createElement(Route, {
            path: "/search",
            element: createElement(SearchRoute),
          })
        )
      )
    )
  );
  await act(async () => {
    mountedRoot?.render(tree);
    await Promise.resolve();
  });
  await settle();
  return host;
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function scopeOf(call: unknown[]): string | undefined {
  const options = call[2] as { channelId?: string } | undefined;
  return options?.channelId;
}

function cursorOf(call: unknown[]): string | undefined {
  const options = call[2] as { cursor?: string } | undefined;
  return options?.cursor;
}

async function click(host: HTMLElement, testId: string): Promise<void> {
  const element = host.querySelector(
    `[data-testid="${testId}"]`
  ) as HTMLElement | null;
  expect(element, `${testId} 를 찾지 못했습니다.`).not.toBeNull();
  await act(async () => {
    element!.click();
  });
  await settle();
}

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  searchMessages.mockReset();
  searchMessages.mockResolvedValue({ hits: [hit("m-1")] });
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

describe("범위 칩", () => {
  it("채널을 들고 오면 칩이 서고 첫 요청이 그 채널로 좁혀진다", async () => {
    const host = await mountAt(`/search?q=배포&channel=${CH_DEPLOY}`);

    expect(host.querySelector('[data-testid="search-scope-channel"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="search-scope-workspace"]')).not.toBeNull();
    expect(searchMessages).toHaveBeenCalledTimes(1);
    expect(scopeOf(searchMessages.mock.calls[0])).toBe(CH_DEPLOY);
  });

  it("채널 없이 들어오면 칩 자체가 없다", async () => {
    // 좁힐 대상이 없는 자리의 「이 채널에서」는 누를 수 없는 칩이고, 누를 수
    // 없는 칩은 컨트롤이 아니라 장식이다.
    const host = await mountAt("/search?q=배포");
    expect(host.querySelector('[data-testid="search-scope-channel"]')).toBeNull();
    expect(host.querySelector('[data-testid="search-scope-workspace"]')).toBeNull();
    expect(scopeOf(searchMessages.mock.calls[0])).toBeUndefined();
  });

  it("칩 문구는 표면과 팔레트가 함께 읽는 그 한 줄이다", async () => {
    const host = await mountAt(`/search?q=배포&channel=${CH_DEPLOY}`);
    const chip = host.querySelector('[data-testid="search-scope-channel"]');
    expect(chip?.textContent).toContain(
      searchScopeLabel("channel", {
        channelId: CH_DEPLOY,
        label: "배포",
        isDirect: false,
      })
    );
  });
});

describe("범위를 바꾸면 커서가 남지 않는다", () => {
  it("전체로 넓히면 channel= 없는 새 요청이 나가고 커서는 따라가지 않는다", async () => {
    // 1페이지가 커서를 남긴 상태에서 범위를 바꾼다. 캐시 키에 범위가 없으면
    // tanstack이 이 커서를 그대로 들고 있다가 다음 요청에 실어 보내고, 서버는
    // 스코프 봉인 400으로 답한다.
    searchMessages.mockResolvedValue({
      hits: [hit("m-1")],
      nextCursor: "channel-scoped-cursor",
    });
    const host = await mountAt(`/search?q=배포&channel=${CH_DEPLOY}`);
    expect(searchMessages).toHaveBeenCalledTimes(1);

    await click(host, "search-scope-workspace");

    expect(searchMessages.mock.calls.length).toBeGreaterThan(1);
    const latest = searchMessages.mock.calls[searchMessages.mock.calls.length - 1];
    expect(scopeOf(latest)).toBeUndefined();
    expect(cursorOf(latest)).toBeUndefined();
  });

  it("다시 좁히면 채널 요청이 나가고, 그때도 커서는 새로 시작한다", async () => {
    searchMessages.mockResolvedValue({
      hits: [hit("m-1")],
      nextCursor: "workspace-cursor",
    });
    const host = await mountAt(`/search?q=배포&channel=${CH_DEPLOY}`);
    await click(host, "search-scope-workspace");
    searchMessages.mockClear();

    await click(host, "search-scope-channel");

    expect(searchMessages).toHaveBeenCalled();
    const latest = searchMessages.mock.calls[searchMessages.mock.calls.length - 1];
    expect(scopeOf(latest)).toBe(CH_DEPLOY);
    expect(cursorOf(latest)).toBeUndefined();
  });
});

describe("빈 결과는 범위에 따라 다른 말을 한다", () => {
  it("좁힌 범위에서 빈손이면 어디서 못 찾았는지 말하고 승격 버튼을 준다", async () => {
    searchMessages.mockResolvedValue({ hits: [] });
    const host = await mountAt(`/search?q=배포&channel=${CH_DEPLOY}`);

    const empty = host.querySelector('[data-testid="search-empty"]');
    expect(empty?.textContent).toContain("이 채널에는");
    const escalate = host.querySelector(
      '[data-testid="search-empty-escalate"]'
    ) as HTMLElement | null;
    expect(escalate).not.toBeNull();
    expect(escalate!.textContent).toContain(ESCALATE_TO_WORKSPACE_LABEL);
  });

  it("승격 버튼 한 번이 질의는 두고 범위만 넓힌다", async () => {
    searchMessages.mockResolvedValue({ hits: [] });
    const host = await mountAt(`/search?q=배포&channel=${CH_DEPLOY}`);
    searchMessages.mockClear();

    await click(host, "search-empty-escalate");

    const latest = searchMessages.mock.calls[searchMessages.mock.calls.length - 1];
    // 질의는 그대로다 — 다시 칠 일이 없어야 승격이 한 번의 누름이다.
    expect(latest[1]).toBe("배포");
    expect(scopeOf(latest)).toBeUndefined();
    // 그리고 화면은 이제 전체 범위의 문장으로 갈아입는다.
    expect(
      host.querySelector('[data-testid="search-empty"]')?.textContent
    ).not.toContain("이 채널에는");
  });

  it("전체에서 빈손이면 지금까지의 그 문장 그대로다", async () => {
    searchMessages.mockResolvedValue({ hits: [] });
    const host = await mountAt("/search?q=배포");
    const empty = host.querySelector('[data-testid="search-empty"]');
    expect(empty?.textContent).toContain("찾지 못했습니다");
    expect(empty?.textContent).not.toContain("이 채널에는");
    // 승격할 곳이 없으므로 승격 버튼도 없다.
    expect(host.querySelector('[data-testid="search-empty-escalate"]')).toBeNull();
  });
});

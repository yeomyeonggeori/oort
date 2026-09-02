// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Channel, MessageSearchHit, RosterMember } from "@momo/core/lib/api";
import { ApiError } from "@momo/core/lib/api";
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
const CH_DM = "00000000-0000-7000-8000-000000000202";
const CH_GONE = "00000000-0000-7000-8000-0000000002ff";
const AUTHOR = "00000000-0000-7000-8000-000000000102";
const PEER = "00000000-0000-7000-8000-000000000103";

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
  {
    id: CH_DM,
    workspaceId: WS,
    kind: "dm",
    muted: false,
    memberIds: [MEMBER_ID, PEER],
  },
];

/** 디렉터리가 도착했는가. `false`면 DM의 상대를 못 찾는다(H-2의 흔한 상태). */
let directoryArrived = true;

const peerRow: RosterMember = {
  id: PEER,
  workspaceId: WS,
  kind: "human",
  status: "active",
  displayName: "김인턴",
  handle: "intern",
  role: "member",
  channelCount: 1,
  channelIds: [CH_DM],
  capabilities: [],
  presenceStatus: "auto",
  createdAtMs: 0,
  updatedAtMs: 0,
};

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
      directory: actual.makeDirectory(directoryArrived ? [peerRow] : []),
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

/** MemoryRouter의 현재 주소를 시험이 읽을 수 있게 하는 탐침. */
let currentSearch = "";

function LocationProbe() {
  currentSearch = useLocation().search;
  return null;
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
          "div",
          null,
          createElement(LocationProbe),
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
  directoryArrived = true;
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
        peer: null,
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
  it("좁힌 범위에서 빈손이면 **채널 이름**을 말하고 승격 버튼을 준다", async () => {
    searchMessages.mockResolvedValue({ hits: [] });
    const host = await mountAt(`/search?q=배포&channel=${CH_DEPLOY}`);

    // R1 H-1: 1차 판본은 「이 채널에는」으로만 말했고, 그 화면 어디에도 채널
    // 이름이 없었다(안내문은 질의가 있으면 안 보이고, 행이 없으니 행 메타도
    // 없다). 어디서 못 찾았는지가 중요한 것은 정확히 이 화면이다.
    const empty = host.querySelector('[data-testid="search-empty"]');
    expect(empty?.textContent).toContain("배포에는");
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
    ).toContain("찾지 못했습니다");
  });

  it("전체에서 빈손이면 지금까지의 그 문장 그대로다", async () => {
    searchMessages.mockResolvedValue({ hits: [] });
    const host = await mountAt("/search?q=배포");
    const empty = host.querySelector('[data-testid="search-empty"]');
    expect(empty?.textContent).toContain("찾지 못했습니다");
    expect(empty?.textContent).not.toContain("에는 없습니다");
    // 승격할 곳이 없으므로 승격 버튼도 없다.
    expect(host.querySelector('[data-testid="search-empty-escalate"]')).toBeNull();
  });
});

describe("볼 수 없는 채널의 404는 「기능 미제공」이 아니다", () => {
  it("서버가 404로 거절하면 그 채널 이야기로 말한다", async () => {
    // R1 B-3: 1차 판본은 이 404를 `serverSaysAbsent`(404·405·501)로 흘려
    // 「이 서버는 아직 메시지 검색을 제공하지 않습니다 / 채널을 열어 직접
    // 찾아보세요」를 그렸다. 두 문장 다 틀렸다 — 서버는 검색을 제공하고 있고,
    // 이 오류의 조건이 바로 **그 채널을 열 수 없다**는 것이다.
    searchMessages.mockRejectedValue(new ApiError(404, "channel not found"));
    const host = await mountAt(`/search?q=배포&channel=${CH_GONE}`);

    expect(host.querySelector('[data-testid="search-unavailable"]')).toBeNull();
    const refused = host.querySelector('[data-testid="search-scope-refused"]');
    expect(refused).not.toBeNull();
    expect(refused!.textContent).toContain("이 채널의 메시지는 찾을 수 없습니다");
    expect(refused!.textContent).not.toContain("제공하지 않습니다");
    expect(refused!.textContent).not.toContain("채널을 열어");
  });

  it("회복은 빈손 화면과 같은 문법이고, 실제로 회복된다", async () => {
    searchMessages.mockRejectedValue(new ApiError(404, "channel not found"));
    const host = await mountAt(`/search?q=배포&channel=${CH_GONE}`);
    const escalate = host.querySelector(
      '[data-testid="search-scope-refused-escalate"]'
    ) as HTMLElement | null;
    expect(escalate).not.toBeNull();
    expect(escalate!.textContent).toContain(ESCALATE_TO_WORKSPACE_LABEL);

    searchMessages.mockResolvedValue({ hits: [hit("m-1")] });
    await click(host, "search-scope-refused-escalate");

    // 거절 화면이 걷히고 결과가 선다 — 막다른 길이 아니라 회복 동선이다.
    expect(host.querySelector('[data-testid="search-scope-refused"]')).toBeNull();
    expect(host.querySelector('[data-testid="search-results"]')).not.toBeNull();
    const latest = searchMessages.mock.calls[searchMessages.mock.calls.length - 1];
    expect(scopeOf(latest)).toBeUndefined();
  });

  it("전체 범위의 404는 여전히 표면 미제공이다", async () => {
    // 표면 전체를 물었을 때의 404는 판정표가 읽어야 할 그 404다. 새 갈래가
    // 기존 이중 방어를 먹어 버리면 안 된다.
    searchMessages.mockRejectedValue(new ApiError(404, "not found"));
    const host = await mountAt("/search?q=배포");
    expect(host.querySelector('[data-testid="search-scope-refused"]')).toBeNull();
    expect(
      host.querySelector('[data-testid="search-unavailable"]')
    ).not.toBeNull();
  });

  it("좁힌 범위의 500은 장애 배너 그대로다", async () => {
    searchMessages.mockRejectedValue(new ApiError(500, "boom"));
    const host = await mountAt(`/search?q=배포&channel=${CH_DEPLOY}`);
    expect(host.querySelector('[data-testid="search-scope-refused"]')).toBeNull();
    expect(host.querySelector('[data-testid="search-error"]')).not.toBeNull();
  });
});

describe("존칭은 사람에게만", () => {
  it("DM 상대를 찾으면 그 사람 이름으로 말한다", async () => {
    searchMessages.mockResolvedValue({ hits: [] });
    const host = await mountAt(`/search?q=배포&channel=${CH_DM}`);
    const empty = host.querySelector('[data-testid="search-empty"]');
    expect(empty?.textContent).toContain("김인턴님과의 대화에는");
  });

  it("디렉터리가 안 왔으면 존칭 없는 문장으로 물러난다", async () => {
    // R1 H-2: `channelLabel`이 상대를 못 찾으면 「다이렉트 메시지」를 준다.
    // 거기에 「님」을 기계적으로 붙이면 「다이렉트 메시지님과의 대화」가 난다.
    directoryArrived = false;
    searchMessages.mockResolvedValue({ hits: [] });
    const host = await mountAt(`/search?q=배포&channel=${CH_DM}`);
    const text = host.querySelector('[data-testid="search-empty"]')?.textContent;
    expect(text).toContain("이 대화에는");
    expect(text).not.toContain("다이렉트 메시지님");

    const input = host.querySelector(
      '[data-testid="search-input"]'
    ) as HTMLInputElement;
    expect(input.placeholder).not.toContain("님");
  });
});

describe("못 푼 채널 id는 화면에 서지 않는다", () => {
  it("문장과 접근성 이름 어디에도 내부 식별자가 없다", async () => {
    // R1 M-1: 1차 판본은 「019f9c99에서 검색」·「검색 범위(019f9c99)」였다.
    searchMessages.mockResolvedValue({ hits: [] });
    const host = await mountAt(`/search?q=배포&channel=${CH_GONE}`);
    const prefix = CH_GONE.slice(0, 8);

    const input = host.querySelector(
      '[data-testid="search-input"]'
    ) as HTMLInputElement;
    expect(input.placeholder).toBe("이 채널에서 검색");
    expect(input.placeholder).not.toContain(prefix);

    const tablist = host.querySelector('[role="tablist"]');
    expect(tablist?.getAttribute("aria-label")).toBe("검색 범위");

    expect(
      host.querySelector('[data-testid="search-empty"]')?.textContent
    ).not.toContain(prefix);
  });
});

describe("범위는 주소에 적힌다", () => {
  it("승격하면 주소가 함께 넓어지고 문맥은 남는다", async () => {
    // R1 M-2: 1차 판본은 승격 뒤 주소가 화면과 반대말을 했다(주소는 channel=…,
    // 화면은 전체 결과). 새로고침하면 기본값이 채널을 다시 골라 사람이 방금
    // 내린 결정을 조용히 되돌렸다.
    searchMessages.mockResolvedValue({ hits: [] });
    const host = await mountAt(`/search?q=배포&channel=${CH_DEPLOY}`);
    await click(host, "search-empty-escalate");

    const params = new URLSearchParams(currentSearch);
    expect(params.get("scope")).toBe("all");
    // 문맥이 남아야 칩이 남고, 칩이 남아야 되좁힐 길이 있다.
    expect(params.get("channel")).toBe(CH_DEPLOY);
    expect(params.get("q")).toBe("배포");
    expect(
      host.querySelector('[data-testid="search-scope-channel"]')
    ).not.toBeNull();
  });

  it("주소가 이미 넓어져 있으면 그 상태로 도착한다", async () => {
    // 새로고침·공유가 같은 화면을 여는지를 이 한 줄이 잰다.
    const host = await mountAt(
      `/search?q=배포&channel=${CH_DEPLOY}&scope=all`
    );
    expect(scopeOf(searchMessages.mock.calls[0])).toBeUndefined();
    const selected = host.querySelector(
      '[data-testid="search-scope-workspace"]'
    );
    expect(selected?.getAttribute("aria-selected")).toBe("true");
  });

  it("칩으로 되좁히면 주소에서 scope 가 지워진다", async () => {
    const host = await mountAt(
      `/search?q=배포&channel=${CH_DEPLOY}&scope=all`
    );
    await click(host, "search-scope-channel");
    const params = new URLSearchParams(currentSearch);
    expect(params.get("scope")).toBeNull();
    expect(params.get("channel")).toBe(CH_DEPLOY);
    expect(scopeOf(searchMessages.mock.calls[searchMessages.mock.calls.length - 1])).toBe(
      CH_DEPLOY
    );
  });
});

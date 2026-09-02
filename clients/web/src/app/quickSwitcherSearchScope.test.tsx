// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Channel } from "@momo/core/lib/api";
import { searchEntryLabel } from "@momo/core/features/search/searchModel";
import { serverSurface } from "@momo/core/features/capabilities/serverSurfaces";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { QuickSwitcher } from "./QuickSwitcher";

// =============================================================================
// ⌘K의 검색 진입 두 줄 (R1 B-1 / B-2 / N-1).
//
// 이 팔레트는 **이름**만 거른다. 그래서 여기 있는 두 줄 — 「이름으로 못 찾았을
// 때 쓰라고 있는」 줄들 — 은 걸러지면 정확히 필요한 순간에 없다. 그 생존이
// 두 겹이라는 것이 이 파일이 못 박는 것이다:
//
//   ① 항목이 `forceMount`라 필터를 넘긴다.
//   ② 그 항목이 속한 **그룹**도 `forceMount`라 cmdk가 `hidden`을 걸지 않는다.
//
// ②가 빠지면 항목은 DOM에 남지만 그룹이 `hidden`이라 상자가 0×0이 된다 —
// 키보드는 닿는데 눈은 못 보는 컨트롤(ADR-0112 D6, 상시 Blocker)이고, 바로 위
// `Command.Empty`의 「아래 …에서 찾을 수 있습니다」는 화면에 없는 곳을 가리킨다.
// jsdom은 레이아웃을 재지 않으므로 여기서는 `hidden` 속성으로 잰다(그 속성이
// UA 스타일시트의 display:none 그 자체다). 실제 상자 크기는 capture 장면이 잰다.
// =============================================================================

const WS = "00000000-0000-7000-8000-000000000001";
const MEMBER_ID = "00000000-0000-7000-8000-000000000101";
const CH_DEPLOY = "00000000-0000-7000-8000-000000000201";
const CH_DM = "00000000-0000-7000-8000-000000000202";
const SEARCH_SURFACE_NAME = serverSurface("messageSearch").label;

const channels: Channel[] = [
  { id: CH_DEPLOY, workspaceId: WS, kind: "public", name: "배포", muted: false },
  {
    id: CH_DM,
    workspaceId: WS,
    kind: "dm",
    muted: false,
    memberIds: [MEMBER_ID, "00000000-0000-7000-8000-000000000103"],
  },
];

// 팔레트가 여는 폼 다이얼로그들은 이 시험의 대상이 아니다. 각자 provider를
// 요구하므로 여는 쪽만 no-op으로 세워 둔다 — 열림 여부를 읽는 훅들은 기본값
// (false)이 그대로 맞다.
vi.mock("@/features/channels/useCreateChannel", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/channels/useCreateChannel")>();
  return { ...actual, useOpenCreateChannel: () => () => undefined };
});

vi.mock("@/features/routing/useAgentProfile", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/routing/useAgentProfile")>();
  return { ...actual, useOpenAgentProfile: () => () => undefined };
});

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
      groups: {
        channels: channels.filter((c) => c.kind !== "dm"),
        dms: channels.filter((c) => c.kind === "dm"),
      },
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
let currentPath = "";

function LocationProbe() {
  const location = useLocation();
  currentPath = `${location.pathname}${location.search}`;
  return null;
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

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** 팔레트를 연 채로 `path` 위에 세운다. */
async function openAt(path: string): Promise<void> {
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
        createElement(LocationProbe),
        createElement(
          Routes,
          null,
          createElement(Route, {
            path: "*",
            element: createElement(QuickSwitcher, {
              open: true,
              onOpenChange: () => undefined,
            }),
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
}

/** 팔레트 입력에 실제로 친다. cmdk의 필터는 이 값으로 돈다. */
async function type(text: string): Promise<void> {
  const input = document.querySelector(
    '[data-testid="quick-switcher-input"]'
  ) as HTMLInputElement;
  expect(input).not.toBeNull();
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set;
    setter?.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
}

function row(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`);
}

/** 이 줄이 **눈에 보이는가**. 조상 중 하나라도 `hidden`이면 아니다. */
function isVisible(element: HTMLElement | null): boolean {
  if (element === null) return false;
  for (
    let node: HTMLElement | null = element;
    node !== null;
    node = node.parentElement
  ) {
    if (node.hidden) return false;
  }
  return true;
}

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  HTMLElement.prototype.scrollIntoView = () => undefined;
  HTMLElement.prototype.hasPointerCapture = () => false;
  HTMLElement.prototype.setPointerCapture = () => undefined;
  HTMLElement.prototype.releasePointerCapture = () => undefined;
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {
        return undefined;
      }
      unobserve() {
        return undefined;
      }
      disconnect() {
        return undefined;
      }
    };
  }
});

beforeEach(() => {
  currentPath = "";
});

afterEach(() => {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  mountedHost?.remove();
  mountedHost = null;
});

describe("검색 진입 줄은 이름이 안 맞아도 살아남는다", () => {
  it("입력이 없을 때 두 줄 다 있다", async () => {
    await openAt(`/c/${CH_DEPLOY}`);
    expect(isVisible(row("switcher-message-search"))).toBe(true);
    expect(isVisible(row("switcher-message-search-channel"))).toBe(true);
  });

  it("**찾으려는 말**을 쳐도 채널 줄이 남는다", async () => {
    // R1 B-1: 1차 판본의 채널 줄은 `forceMount`가 없어 cmdk의 이름 필터에
    // 걸렸다. 그래서 이 줄은 질의가 컨트롤 자기 이름과 겹칠 때만 살았고,
    // 「질의를 들고 채널 범위로 인계」라는 자기 용도에서는 없었다.
    await openAt(`/c/${CH_DEPLOY}`);
    await type("배포");
    expect(isVisible(row("switcher-message-search-channel"))).toBe(true);
    expect(isVisible(row("switcher-message-search"))).toBe(true);
  });

  it("이름이 아무것도 안 맞아도 두 줄이 **보인다**", async () => {
    // R1 B-2: 항목만 `forceMount`이던 판본에서는 cmdk가 그룹에 `hidden`을 걸어
    // 줄이 DOM에는 남고 상자는 0×0이 됐다. Enter는 동작하는데 화면에는 없다.
    await openAt(`/c/${CH_DEPLOY}`);
    await type("이런이름은없다");

    const wide = row("switcher-message-search");
    const narrow = row("switcher-message-search-channel");
    expect(isVisible(wide)).toBe(true);
    expect(isVisible(narrow)).toBe(true);

    // 그 줄이 속한 그룹 자체가 살아 있는지 직접 잰다.
    const group = wide!.closest("[cmdk-group]") as HTMLElement;
    expect(group.hidden).toBe(false);
  });

  it("Enter가 겨누는 줄은 언제나 보이는 줄이다", async () => {
    await openAt(`/c/${CH_DEPLOY}`);
    await type("이런이름은없다");
    const selected = document.querySelector(
      '[cmdk-item][data-selected="true"]'
    ) as HTMLElement | null;
    expect(selected).not.toBeNull();
    expect(isVisible(selected)).toBe(true);
  });

  it("빈 문장이 가리키는 이름이 실제로 화면에 있다", async () => {
    // `Command.Empty`는 「메시지 본문은 아래 {표면 이름}에서 찾을 수 있습니다」
    // 라고 말한다. 그 이름이 화면에 없으면 안내가 없는 곳을 가리킨다.
    await openAt(`/c/${CH_DEPLOY}`);
    await type("이런이름은없다");
    const group = row("switcher-message-search")!.closest(
      "[cmdk-group]"
    ) as HTMLElement;
    const heading = group.querySelector("[cmdk-group-heading]");
    expect(heading?.textContent).toBe(SEARCH_SURFACE_NAME);
  });

  it("채널 밖에서는 채널 줄이 없다", async () => {
    // 「이 채널」이 어느 채널도 가리키지 않는 자리다.
    await openAt("/inbox");
    expect(isVisible(row("switcher-message-search"))).toBe(true);
    expect(row("switcher-message-search-channel")).toBeNull();
  });
});

describe("두 줄이 같은 동사를 쓴다", () => {
  it("입력 유무와 무관하게 한 규칙에서 나온다", async () => {
    // R1 N-1: 1차 판본은 「'배포' 메시지 검색」과 「이 채널에서 '배포' 찾기」로
    // 갈렸고, 채널 줄은 상태에 따라 동사가 또 바뀌었다.
    await openAt(`/c/${CH_DEPLOY}`);
    expect(row("switcher-message-search")!.textContent).toContain(
      searchEntryLabel("workspace", null, "")
    );
    expect(row("switcher-message-search-channel")!.textContent).toContain(
      searchEntryLabel(
        "channel",
        { channelId: CH_DEPLOY, label: "배포", isDirect: false, peer: null },
        ""
      )
    );

    await type("배포");
    for (const [testId, scope] of [
      ["switcher-message-search", "workspace"],
      ["switcher-message-search-channel", "channel"],
    ] as const) {
      const text = row(testId)!.textContent ?? "";
      expect(text).toContain("'배포' 검색");
      expect(text).not.toContain("찾기");
      expect(scope).toBeTruthy();
    }
  });

  it("DM에서는 「이 대화에서」다", async () => {
    await openAt(`/c/${CH_DM}`);
    expect(row("switcher-message-search-channel")!.textContent).toContain(
      "이 대화에서"
    );
  });
});

describe("채널 줄이 질의와 범위를 함께 인계한다", () => {
  it("Enter가 q 와 channel 을 둘 다 실은 주소로 데려간다", async () => {
    await openAt(`/c/${CH_DEPLOY}`);
    await type("배포");
    await act(async () => {
      row("switcher-message-search-channel")!.click();
    });
    await settle();
    const params = new URLSearchParams(currentPath.split("?")[1] ?? "");
    expect(currentPath.startsWith("/search")).toBe(true);
    expect(params.get("q")).toBe("배포");
    expect(params.get("channel")).toBe(CH_DEPLOY);
  });

  it("전체 줄은 범위를 싣지 않는다", async () => {
    await openAt(`/c/${CH_DEPLOY}`);
    await type("배포");
    await act(async () => {
      row("switcher-message-search")!.click();
    });
    await settle();
    const params = new URLSearchParams(currentPath.split("?")[1] ?? "");
    expect(params.get("q")).toBe("배포");
    expect(params.get("channel")).toBeNull();
  });
});

// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NetworkError } from "@momo/core/lib/http";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { AddChannelMemberProvider } from "./AddChannelMemberDialog";
import { CreateChannelProvider } from "./CreateChannelDialog";
import { useOpenCreateChannel } from "./useCreateChannel";

// 실패 문장이 서면 그 자리가 스크롤 칸 안에서 보이게 한다(#5965, 5906-H1). 문장은 스크롤 칸의 맨 아래에 서서 작은 창·큰 글자에서는
// 칸 밖에 놓였다. jsdom 은 배치를 못 재므로 「문장을 보이게 하는 호출이 그 문장에 나간다」를 잰다(실제 위치는 브라우저로 잰다).

const WS = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";

const createChannel = vi.hoisted(() => vi.fn());
vi.mock("@momo/core/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@momo/core/lib/api")>()),
  createChannel: (...args: unknown[]) => createChannel(...args),
}));
vi.mock("@/features/common/useOffline", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/common/useOffline")>()),
  useOffline: () => false,
}));

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root | null = null;
let host: HTMLElement | null = null;
let client: QueryClient;

const session: SessionContextValue = {
  session: {
    accessToken: "a",
    refreshToken: "r",
    member: { id: ME, workspaceId: WS, kind: "human", displayName: "곽성재", handle: "seongjae" },
    realtimeWebSocketUrl: "wss://example.test/connection/websocket",
  },
  workspaceId: WS,
  realtime: null,
  connStatus: "connected",
  logout: () => undefined,
  replaceSessionMember: () => undefined,
};

function Opener() {
  const open = useOpenCreateChannel();
  return createElement(
    "button",
    { "data-testid": "opener", onClick: (e: React.MouseEvent<HTMLElement>) => open(e.currentTarget) },
    "열기"
  );
}
async function mount(): Promise<void> {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree: ReactElement = createElement(
    QueryClientProvider,
    { client },
    createElement(
      SessionProvider,
      { value: session },
      createElement(
        MemoryRouter,
        { initialEntries: ["/"] },
        // 셸과 같은 순서(#5784): 만들기 창이 비공개 채널 뒤에 「멤버 추가」를 이어서 열므로 그 provider 안에 선다.
        createElement(
          AddChannelMemberProvider,
          null,
          createElement(CreateChannelProvider, null, createElement(Opener))
        )
      )
    )
  );
  await act(async () => {
    root?.render(tree);
    await Promise.resolve();
  });
}

const input = (testId: string) => document.querySelector<HTMLInputElement>(`[data-testid="${testId}"]`)!;
const click = (testId: string) =>
  act(async () => {
    document.querySelector<HTMLElement>(`[data-testid="${testId}"]`)!.click();
    await Promise.resolve();
  });
const type = (testId: string, value: string) =>
  act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    set.call(input(testId), value);
    input(testId).dispatchEvent(new Event("input", { bubbles: true }));
  });

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});
const scrolled: { target: Element; options: unknown }[] = [];
beforeEach(() => {
  createChannel.mockReset();
  scrolled.length = 0;
  // jsdom 에는 `scrollIntoView`가 없다. 누가 어떤 인자로 불렀는지만 적는다.
  Element.prototype.scrollIntoView = function (this: Element, options?: unknown) {
    scrolled.push({ target: this, options });
  };
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
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  Reflect.deleteProperty(Element.prototype, "scrollIntoView");
});

describe("채널 만들기 다이얼로그 — 실패 문장이 서면 보이는 자리로 옮긴다 (#5965)", () => {
  it("만들기가 실패해 문장이 서면, 그 문장이 스크롤 칸 안에서 보이게 가장 가까운 만큼만 옮긴다", async () => {
    createChannel.mockRejectedValue(new NetworkError("timeout", 15_000));
    await mount();
    await click("opener");
    await type("create-channel-name", "ops-room");
    expect(scrolled).toHaveLength(0);

    await click("create-channel-submit");
    await act(async () => {
      await Promise.resolve();
    });

    const alert = document.querySelector('[data-testid="create-channel-error"]');
    expect(alert).not.toBeNull();
    expect(scrolled.map((call) => call.target)).toEqual([alert]);
    expect(scrolled[0]?.options).toEqual({ block: "nearest" });
  });
});

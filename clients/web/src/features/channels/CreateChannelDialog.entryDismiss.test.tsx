// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Channel } from "@momo/core/lib/api";
import { dismissTemporarySurfaces } from "@momo/core/features/notifications/entryDismiss";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { CreateChannelProvider } from "./CreateChannelDialog";
import { useOpenCreateChannel } from "./useCreateChannel";

// 알림 클릭이 새 입구로 들어오면(#4667) 열려 있던 채널 만들기 다이얼로그가 걷힌다. 이 파일은 그 뒤의 두 가지를 잰다(#5058).
//   1. 쓰던 이름·주제·공개 범위는 남는다 — 이 다이얼로그는 셸의 provider 가 초안을 쥐어 어떻게 닫혀도 남는 것이 본래 약속이고,
//      알림 클릭이 닫는 길도 그 약속을 지나야 한다(이미 지키는 규칙을 못박는다).
//   2. 만드는 동안 알림이 착지하면, 요청이 끝나도 새 채널로 끌고 가지 않는다. 다이얼로그가 걷혔는데 늦은 응답이 알림이 세운
//      목적지를 덮어쓰면 안 된다(폰의 `NewChannelSheet` 와 같은 규칙).

const WS = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";
const CREATED_ID = "00000000-0000-7000-8000-0000000003aa";
const LANDING = "/c/notification-destination";

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
function Where() {
  return createElement("span", { "data-testid": "where" }, useLocation().pathname);
}
/** 알림 클릭이 하는 그대로: 이동하기 직전에 방송을 올리고 간다(`DesktopNotifications` 의 `landOnNotification`). */
function Lander() {
  const navigate = useNavigate();
  return createElement(
    "button",
    {
      "data-testid": "land",
      onClick: () => {
        dismissTemporarySurfaces();
        navigate(LANDING);
      },
    },
    "알림 착지"
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
        createElement(CreateChannelProvider, null, createElement(Opener), createElement(Where), createElement(Lander))
      )
    )
  );
  await act(async () => {
    root?.render(tree);
    await Promise.resolve();
  });
}

const dialog = () => document.querySelector<HTMLElement>('[data-testid="create-channel-dialog"]');
const input = (testId: string) => document.querySelector<HTMLInputElement>(`[data-testid="${testId}"]`)!;
const where = () => document.querySelector('[data-testid="where"]')!.textContent;
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

/** 서버의 응답을 시험이 쥔다 — 「요청이 나가 있는 동안」을 시험이 정한다. */
function holdServer() {
  let answer: (() => void) | null = null;
  createChannel.mockImplementation(
    () =>
      new Promise((resolve) => {
        answer = () =>
          resolve({
            channel: { id: CREATED_ID, workspaceId: WS, kind: "public", name: "ops-room", muted: false } as Channel,
          });
      })
  );
  return {
    answer: () =>
      act(async () => {
        answer?.();
        await Promise.resolve();
      }),
  };
}

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  createChannel.mockReset();
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
});

describe("채널 만들기 다이얼로그 — 알림 클릭이 닫아도 입력은 남는다 (#5058)", () => {
  it("이름·주제·공개 범위를 쓰던 중 알림 클릭이 닫으면, 다시 연 다이얼로그에 그대로 있다", async () => {
    await mount();
    await click("opener");
    await type("create-channel-name", "ops-room");
    await type("create-channel-topic", "운영 이야기");
    // 공개 범위의 라디오는 testid 가 아니라 id 로 서 있다.
    await act(async () => {
      document.querySelector<HTMLInputElement>("#create-channel-kind-private")!.click();
    });
    expect(document.querySelector<HTMLInputElement>("#create-channel-kind-private")!.checked).toBe(true);

    await click("land");
    expect(dialog()).toBeNull();

    await click("opener");
    expect(input("create-channel-name").value).toBe("ops-room");
    expect(input("create-channel-topic").value).toBe("운영 이야기");
    expect(document.querySelector<HTMLInputElement>("#create-channel-kind-private")!.checked).toBe(true);
  });
});

describe("채널 만들기 다이얼로그 — 만드는 동안 알림이 착지하면 새 채널로 끌고 가지 않는다 (#5058)", () => {
  const submit = async () => {
    await type("create-channel-name", "ops-room");
    await click("create-channel-submit");
    expect(createChannel).toHaveBeenCalledTimes(1);
  };
  const cached = () => client.getQueryData<Channel[]>(["channels", WS]);

  it("대조: 아무 일도 없으면 만들어진 채널로 이동하고 다이얼로그가 닫히며 초안이 비워진다", async () => {
    const server = holdServer();
    await mount();
    await click("opener");
    await submit();

    await server.answer();

    expect(where()).toBe(`/c/${CREATED_ID}`);
    expect(dialog()).toBeNull();
    expect(cached()?.some((channel) => channel.id === CREATED_ID)).toBe(true);
    await click("opener");
    expect(input("create-channel-name").value).toBe("");
  });

  it("알림이 착지해 다이얼로그가 걷혔다면 응답이 와도 이동하지 않는다 — 채널은 목록에 있고, 그 사이 다시 연 다이얼로그를 늦은 응답이 닫지 않는다", async () => {
    const server = holdServer();
    await mount();
    await click("opener");
    await submit();

    await click("land");
    expect(where()).toBe(LANDING);
    expect(dialog()).toBeNull();

    // 사람이 알림의 대화에서 다시 + 를 눌러 같은 다이얼로그를 열었다 — 요청은 아직 나가 있다.
    await click("opener");
    expect(dialog()).not.toBeNull();
    expect(input("create-channel-name").value).toBe("ops-room");

    await server.answer();

    expect(where()).toBe(LANDING);
    expect(cached()?.some((channel) => channel.id === CREATED_ID)).toBe(true);
    // 옛 요청의 응답이 새로 연 다이얼로그를 닫지 않는다. 만들어진 채널의 초안은 더 이상 초안이 아니라 비워진다.
    expect(dialog()).not.toBeNull();
    expect(input("create-channel-name").value).toBe("");
  });
});

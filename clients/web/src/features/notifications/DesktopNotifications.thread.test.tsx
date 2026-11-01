// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import type { MessageNewEvent } from "@momo/core/lib/realtimeEvents";
import type { NotificationRules } from "@momo/core/features/settings/notificationRules";
import type { RealtimeHandle } from "@/lib/realtime";
import { messageAnchorPath } from "@/features/inbox/anchor";
import { DesktopNotifications } from "./DesktopNotifications";
import { osNotifier } from "./osNotifier";
import { reloadDesktopNotificationKindsForTest, setDesktopNotificationKind } from "./preference";
import { noteFollowing, resetThreadFollowStoreForTest } from "./threadFollowStore";
import { resetViewedThreadForTest, viewThread } from "./viewedThread";

// =============================================================================
// 따라가는 스레드의 새 답글이 OS 배너가 되는 길 (#4890, ADR-0206 증보 1). 서버의 따라가기 답(`GET …/replies` 의
// `following`)만 가짜이고, 판정·장부·알림 묶음·셸 다리까지는 진짜다 — `showNotification` 이 불리는 횟수와 서버 읽기의
// 호출 수가 증거다. 사보타주(「보는 중이면 안 띄움」·「내가 쓴 답글 제외」·「끈 종류 무시」)는 코어 `model.test.ts` 가 판정에서,
// 여기서는 배선(열린 스레드 저장소·장부·설정 저장소)에서 잰다.
//
// #5017: 같은 스레드의 답글이 묶인 배너를 누르면 채널이 아니라 그 스레드로 가는지, 한 스레드의 배너가 분당 6건을 넘지 않는지
// (넘은 답글은 배너도 착지 무장도 없다). 6 은 폰 푸시의 대량 층과 같은 값이라 **숫자를 그대로 적는다** — 상수를 가져다 쓰면
// 상수를 바꿔도 시험이 따라 바뀌어 아무것도 지키지 못한다.
// =============================================================================

const IDS = vi.hoisted(() => ({
  ws: "00000000-0000-7000-8000-000000000001",
  self: "00000000-0000-7000-8000-000000000101",
  other: "00000000-0000-7000-8000-0000000005d1",
  channel: "00000000-0000-7000-8000-00000000020a",
  root: "00000000-0000-7000-8000-000000000311",
  otherRoot: "00000000-0000-7000-8000-000000000312",
}));

const showNotification = vi.hoisted(() => vi.fn());
const fetchNotificationRules = vi.hoisted(() => vi.fn());
const fetchThreadReplies = vi.hoisted(() => vi.fn());

vi.mock("@/lib/tauri", () => ({
  isDesktop: () => true,
  showNotification: (...args: unknown[]) => showNotification(...args),
}));

vi.mock("@momo/core/features/settings/notificationRules", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/features/settings/notificationRules")>();
  return {
    ...actual,
    fetchNotificationRules: (workspaceId: string) => fetchNotificationRules(workspaceId) as Promise<NotificationRules>,
  };
});

vi.mock("@momo/core/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@momo/core/lib/api")>()),
  fetchThreadReplies: (...args: unknown[]) => fetchThreadReplies(...args),
}));

vi.mock("@/features/workspace/useWorkspace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/workspace/useWorkspace")>();
  return {
    ...actual,
    useChannels: () => ({
      groups: {
        channels: [{ id: IDS.channel, workspaceId: IDS.ws, kind: "public" as const, name: "ops", muted: false }],
        dms: [],
      },
    }),
    useDirectory: () => ({
      directory: actual.makeDirectory([
        {
          id: IDS.other,
          workspaceId: IDS.ws,
          kind: "human",
          status: "active",
          displayName: "곽성재",
          handle: "seongjae",
          channelCount: 1,
          channelIds: [IDS.channel],
          capabilities: [],
          createdAtMs: 0,
          updatedAtMs: 0,
        },
      ]),
    }),
  };
});

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let mountedRoot: Root | null = null;
let mountedHost: HTMLElement | null = null;
let onMessage: ((event: MessageNewEvent) => void) | null = null;
let hasFocus = false;

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  showNotification.mockReset();
  showNotification.mockResolvedValue(true);
  fetchNotificationRules.mockReset();
  fetchNotificationRules.mockResolvedValue({ dnd: false, mentionOverridesMute: false } satisfies NotificationRules);
  fetchThreadReplies.mockReset();
  fetchThreadReplies.mockResolvedValue({ messages: [], following: true });
  onMessage = null;
  hasFocus = false;
  localStorage.clear();
  reloadDesktopNotificationKindsForTest(localStorage);
  resetThreadFollowStoreForTest();
  resetViewedThreadForTest();
  vi.spyOn(document, "hasFocus").mockImplementation(() => hasFocus);
});

afterEach(() => {
  if (mountedRoot) act(() => mountedRoot?.unmount());
  mountedRoot = null;
  mountedHost?.remove();
  mountedHost = null;
  reloadDesktopNotificationKindsForTest(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

let seq = 100;
function replyEvent(over: Partial<MessageNewEvent["payload"]> = {}): MessageNewEvent {
  const now = Date.now();
  seq += 1;
  return {
    type: "message.new",
    v: 1,
    ts: now,
    seq,
    payload: {
      id: `019F96A4-E717-7F82-9750-${String(seq).padStart(12, "0")}`,
      channel_id: IDS.channel,
      seq,
      type: "text",
      body: "배포 끝났어요",
      author_member_id: IDS.other,
      hlc_ts: now,
      hlc_count: 0,
      root_id: IDS.root,
      props: {},
      ...over,
    },
  };
}

function sessionValue(): SessionContextValue {
  const realtime = {
    subscribeChannel: (_ws: string, _ch: string, handlers: { onMessage: (event: MessageNewEvent) => void }) => {
      onMessage = handlers.onMessage;
      return () => {
        onMessage = null;
      };
    },
  } as unknown as RealtimeHandle;
  return {
    session: {
      accessToken: "access",
      refreshToken: "refresh",
      member: { id: IDS.self, workspaceId: IDS.ws, kind: "human", displayName: "데모 사용자", handle: "demo" },
      realtimeWebSocketUrl: "wss://example.test/connection/websocket",
    },
    workspaceId: IDS.ws,
    realtime,
    connStatus: "connected",
    logout: () => undefined,
    replaceSessionMember: () => undefined,
  };
}

function mountRail(): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  mountedHost = host;
  mountedRoot = createRoot(host);
  const tree: ReactElement = createElement(
    MemoryRouter,
    { initialEntries: ["/"] },
    createElement(
      QueryClientProvider,
      { client: new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } }) },
      createElement(
        SessionProvider,
        { value: sessionValue() },
        createElement(() => {
          const location = useLocation();
          return createElement(
            "div",
            null,
            createElement(DesktopNotifications),
            createElement("output", { "data-testid": "notification-route" }, location.pathname + location.search)
          );
        })
      )
    )
  );
  act(() => mountedRoot?.render(tree));
  return host;
}

async function until(condition: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 100 && !condition(); attempt += 1) {
    await act(async () => {
      await new Promise((resolve) => globalThis.setTimeout(resolve, 2));
    });
  }
  expect(condition(), what).toBe(true);
}

/** 마운트하고 서버 규칙의 첫 읽기와 구독이 서도록 기다린다. */
async function mountSettled(): Promise<HTMLElement> {
  const host = mountRail();
  await until(() => fetchNotificationRules.mock.calls.length >= 1 && onMessage !== null, "규칙 읽기와 구독이 섰다");
  return host;
}

/** 프레임을 한 건 배달하고, 서버에 묻는 길이 끝난 뒤의 판정까지 기다린 다음 묶음을 내보낸다. */
async function deliver(event: MessageNewEvent): Promise<void> {
  await act(async () => {
    onMessage?.(event);
  });
  await act(async () => {
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
  });
  await act(async () => {
    osNotifier().flush();
    await Promise.resolve();
  });
}

/** 프레임 여럿을 묶음 창 안에 연달아 배달하고, 한 번에 내보낸다. */
async function deliverBurst(events: MessageNewEvent[]): Promise<void> {
  for (const event of events) {
    await act(async () => {
      onMessage?.(event);
    });
  }
  await act(async () => {
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
  });
  await act(async () => {
    osNotifier().flush();
    await Promise.resolve();
  });
}

const routeNow = (host: HTMLElement): string | null | undefined =>
  host.querySelector('[data-testid="notification-route"]')?.textContent;

describe("따라가는 스레드의 새 답글 배너 (#4890)", () => {
  it("서버가 따라간다고 말한 스레드에 남이 쓴 답글은 배너가 된다 — 그 스레드 하나를 limit=1 로 물어 확인한 뒤에", async () => {
    await mountSettled();
    await deliver(replyEvent());
    expect(fetchThreadReplies).toHaveBeenCalledTimes(1);
    expect(fetchThreadReplies).toHaveBeenCalledWith(IDS.ws, IDS.channel, IDS.root, undefined, 1);
    expect(showNotification).toHaveBeenCalledTimes(1);
    expect(showNotification.mock.calls[0]?.[0]).toBe("곽성재");
    expect(showNotification.mock.calls[0]?.[1]).toBe("배포 끝났어요");
  });

  it("이미 서버가 알려 준 값(스레드 열기·따라가기 응답)이 있으면 묻지 않고 바로 알린다", async () => {
    await mountSettled();
    noteFollowing(IDS.ws, IDS.root, true);
    await deliver(replyEvent());
    expect(fetchThreadReplies).not.toHaveBeenCalled();
    expect(showNotification).toHaveBeenCalledTimes(1);
  });

  it("서버가 따라가지 않는다고 하면 알리지 않고, 같은 스레드의 다음 답글은 장부로 판정해 다시 묻지 않는다", async () => {
    fetchThreadReplies.mockResolvedValue({ messages: [], following: false });
    await mountSettled();
    await deliver(replyEvent());
    await deliver(replyEvent());
    expect(showNotification).not.toHaveBeenCalled();
    expect(fetchThreadReplies).toHaveBeenCalledTimes(1);
  });

  it("옛 서버(following 키 없음)와 서버 읽기 실패는 따라가지 않는 것으로 읽고, 되풀이해 묻지 않는다", async () => {
    fetchThreadReplies.mockResolvedValue({ messages: [] });
    await mountSettled();
    await deliver(replyEvent());
    fetchThreadReplies.mockReset();
    fetchThreadReplies.mockRejectedValue(new Error("network"));
    await deliver(replyEvent({ root_id: IDS.otherRoot }));
    await deliver(replyEvent({ root_id: IDS.otherRoot }));
    expect(showNotification).not.toHaveBeenCalled();
    expect(fetchThreadReplies).toHaveBeenCalledTimes(1);
  });

  it("내가 쓴 답글은 알리지 않고 서버에 묻지도 않는다", async () => {
    await mountSettled();
    await deliver(replyEvent({ author_member_id: IDS.self }));
    expect(fetchThreadReplies).not.toHaveBeenCalled();
    expect(showNotification).not.toHaveBeenCalled();
  });

  it("그 스레드를 보고 있으면(창이 앞이고 패널이 열려 있으면) 알리지 않고 묻지도 않는다 — 닫으면 다시 알린다", async () => {
    hasFocus = true;
    await mountSettled();
    noteFollowing(IDS.ws, IDS.root, true);
    const close = viewThread(IDS.channel, IDS.root);
    await deliver(replyEvent());
    expect(showNotification).not.toHaveBeenCalled();
    // 같은 채널의 다른 스레드가 열려 있는 것은 이 스레드를 본 것이 아니다.
    close();
    viewThread(IDS.channel, IDS.otherRoot);
    await deliver(replyEvent());
    expect(showNotification).toHaveBeenCalledTimes(1);
  });

  it("이 기기에서 이 종류를 끄면 알리지 않고 서버에 묻지도 않는다", async () => {
    await mountSettled();
    setDesktopNotificationKind("thread-reply", false, localStorage);
    await deliver(replyEvent());
    expect(fetchThreadReplies).not.toHaveBeenCalled();
    expect(showNotification).not.toHaveBeenCalled();
  });

  it("알림을 눌러 앞에 온 창은 그 답글이 있는 스레드를 연다", async () => {
    const host = await mountSettled();
    noteFollowing(IDS.ws, IDS.root, true);
    const event = replyEvent();
    await deliver(event);
    expect(showNotification).toHaveBeenCalledTimes(1);
    act(() => window.dispatchEvent(new Event("focus")));
    expect(host.querySelector('[data-testid="notification-route"]')?.textContent).toBe(
      `${messageAnchorPath(IDS.channel, event.payload.id)}&thread=${IDS.root}`
    );
  });
});

describe("같은 스레드의 답글이 묶인 배너는 그 스레드로 간다 (#5017)", () => {
  it("한 묶음 배너가 되면 눌러 앞에 온 창은 채널이 아니라 그 스레드의 가장 늦은 답글로 간다 — 스레드가 섞이면 예전처럼 채널이다", async () => {
    const host = await mountSettled();
    noteFollowing(IDS.ws, IDS.root, true);
    noteFollowing(IDS.ws, IDS.otherRoot, true);
    const burst = [replyEvent(), replyEvent(), replyEvent()];
    // 브라우저 탭의 묶음 배너는 이 값으로 같은 스레드를 알아본다(`osNotifier.routeFor`): 레일이 스레드 루트를 실어 보낸다.
    const offer = vi.spyOn(osNotifier(), "offer");
    await deliverBurst(burst);
    expect(offer.mock.calls.map(([item]) => item.rootId)).toEqual([IDS.root, IDS.root, IDS.root]);
    expect(showNotification).toHaveBeenCalledTimes(1); // 셋이 한 묶음이다
    act(() => window.dispatchEvent(new Event("focus")));
    expect(routeNow(host)).toBe(`${messageAnchorPath(IDS.channel, burst[2]!.payload.id)}&thread=${IDS.root}`);

    // 다른 스레드의 답글이 끼면 어느 스레드인지 추측하지 않고 채널이다.
    await deliverBurst([replyEvent(), replyEvent({ root_id: IDS.otherRoot })]);
    act(() => window.dispatchEvent(new Event("focus")));
    expect(routeNow(host)).toBe(`/c/${IDS.channel}`);
  });
});

describe("한 스레드의 배너는 분당 6건까지다 (#5017, 폭주 상한)", () => {
  it("여덟 번째 답글까지 따로 와도 배너는 여섯이고, 넘은 답글은 착지 무장도 없다. 다른 스레드는 따로 세고, 60초가 지나면 다시 뜬다", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-01T10:00:00+09:00"));
    const host = await mountSettled();
    noteFollowing(IDS.ws, IDS.root, true);
    noteFollowing(IDS.ws, IDS.otherRoot, true);
    const sent: MessageNewEvent[] = [];
    for (let n = 0; n < 8; n += 1) {
      const event = replyEvent();
      sent.push(event);
      await deliver(event); // 매번 따로 내보낸다: 묶음 창이 합쳐 주지 않는 천천히 이어지는 스레드
      vi.setSystemTime(Date.now() + 1_000);
    }
    expect(showNotification).toHaveBeenCalledTimes(6);
    // 상한을 넘은 일곱째·여덟째 답글은 무장되지 않았다: 눌러 들어오면 여섯째 답글이다.
    act(() => window.dispatchEvent(new Event("focus")));
    expect(routeNow(host)).toBe(`${messageAnchorPath(IDS.channel, sent[5]!.payload.id)}&thread=${IDS.root}`);

    // 다른 스레드는 자기 한도를 쓴다.
    await deliver(replyEvent({ root_id: IDS.otherRoot }));
    expect(showNotification).toHaveBeenCalledTimes(7);

    // 첫 배너에서 60초가 지나면 자리가 비어 다시 뜬다(장부가 늙었으니 서버가 말한 값도 다시 적는다).
    vi.setSystemTime(Date.now() + 60_000);
    noteFollowing(IDS.ws, IDS.root, true);
    await deliver(replyEvent());
    expect(showNotification).toHaveBeenCalledTimes(8);
  });
});

// @vitest-environment jsdom

import { act, createElement, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/design/ui/dialog";
import type { MessageNewEvent } from "@momo/core/lib/realtimeEvents";
import type { NotificationRules } from "@momo/core/features/settings/notificationRules";
import type { RealtimeHandle } from "@/lib/realtime";
import { messageAnchorPath } from "@/features/inbox/anchor";
import { DesktopNotifications } from "./DesktopNotifications";
import { resetBannerClicksForTest } from "./bannerClicks";
import { osNotifier } from "./osNotifier";
import { reloadDesktopNotificationKindsForTest } from "./preference";

// =============================================================================
// #5059 (#4667 후속): 데스크탑 OS 알림의 클릭을 진짜 클릭 이벤트로 받는다.
//
// 이슈의 수용기준 세 줄을 그대로 시험으로 옮긴다.
//   1. 셸이 보낸 클릭 이벤트가 오면 그 배너의 목적지로 이동한다.
//   2. 포커스 어림은 클릭 이벤트가 없을 때만 쓴다 — 클릭 없이 창만 앞에 오면 이동하지 않는다(잘못 이동이 사라졌다).
//   3. 클릭이 없는 환경(옛 셸·다른 OS)에서는 기존 어림이 그대로 남는다.
//
// 셸 다리(`@/lib/tauri`)만 가짜이고, 판정·알림 묶음·장부·이동·대화상자 걷기는 진짜다. 셸이 실제로 배너의 클릭을
// 알려 주는지는 이 시험이 증명하지 못한다(`runtime-unverified`) — Rust 쪽은 `notification_click.rs` 의 시험과
// 인계의 실기기 확인 장면이 맡는다.
// =============================================================================

const IDS = vi.hoisted(() => ({
  ws: "00000000-0000-7000-8000-000000000001",
  self: "00000000-0000-7000-8000-000000000101",
  other: "00000000-0000-7000-8000-0000000005d1",
  agent: "00000000-0000-7000-8000-000000000103",
  channel: "00000000-0000-7000-8000-00000000020a",
  root: "00000000-0000-7000-8000-000000000311",
}));

interface ClickPayload {
  id: string;
  target: string;
}

const shell = vi.hoisted(() => ({
  /** 셸이 클릭을 알려 주는가에 대한 답. 시험이 늦게 풀 수 있게 약속으로 둔다. */
  supported: Promise.resolve(true) as Promise<boolean>,
  outcome: "clickable" as "clickable" | "plain" | "refused",
  /** 페이지가 듣고 있는 클릭 처리기. 해제하면 비워진다. */
  deliver: null as ((payload: unknown) => void) | null,
}));
const showNotification = vi.hoisted(() => vi.fn());
const showClickable = vi.hoisted(() => vi.fn());
const fetchNotificationRules = vi.hoisted(() => vi.fn());

vi.mock("@/lib/tauri", () => ({
  isDesktop: () => true,
  showNotification: (...args: unknown[]) => showNotification(...args),
  notificationClickSupported: () => shell.supported,
  showClickableNotification: (...args: unknown[]) => showClickable(...args),
  onNotificationClick: (handler: (payload: unknown) => void) => {
    shell.deliver = handler;
    return Promise.resolve(() => {
      shell.deliver = null;
    });
  },
}));

vi.mock("@momo/core/features/settings/notificationRules", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/features/settings/notificationRules")>();
  return {
    ...actual,
    fetchNotificationRules: (workspaceId: string) => fetchNotificationRules(workspaceId) as Promise<NotificationRules>,
  };
});

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
          displayName: "이도현",
          handle: "dohyun",
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

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  showNotification.mockReset();
  showNotification.mockResolvedValue(true);
  showClickable.mockReset();
  showClickable.mockImplementation(() => Promise.resolve(shell.outcome));
  fetchNotificationRules.mockReset();
  fetchNotificationRules.mockResolvedValue({ dnd: false, mentionOverridesMute: false });
  shell.supported = Promise.resolve(true);
  shell.outcome = "clickable";
  shell.deliver = null;
  onMessage = null;
  resetBannerClicksForTest();
  localStorage.clear();
  reloadDesktopNotificationKindsForTest(localStorage);
  vi.spyOn(document, "hasFocus").mockReturnValue(false);
});

afterEach(() => {
  osNotifier().flush();
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  mountedHost?.remove();
  mountedHost = null;
  reloadDesktopNotificationKindsForTest(null);
  resetBannerClicksForTest();
  vi.restoreAllMocks();
});

function mentionEvent(id = "019F96A4-E717-7F82-9750-58B2D7D28225"): MessageNewEvent {
  const now = Date.now();
  return {
    type: "message.new",
    v: 1,
    ts: now,
    seq: 42,
    payload: {
      id,
      channel_id: IDS.channel,
      seq: 42,
      type: "text",
      body: "@데모 사용자 배포 확인 부탁드립니다",
      author_member_id: IDS.other,
      hlc_ts: now,
      hlc_count: 0,
      props: { mention_member_ids: [IDS.self] },
    },
  };
}

function approvalEvent(id = "019F96A4-E717-7F82-9750-58B2D7D28226"): MessageNewEvent {
  const now = Date.now();
  return {
    type: "message.new",
    v: 1,
    ts: now,
    seq: 43,
    payload: {
      id,
      channel_id: IDS.channel,
      seq: 43,
      type: "approval_request",
      body: "승인 요청",
      author_member_id: IDS.agent,
      hlc_ts: now,
      hlc_count: 0,
      props: { approval_id: "019F8338-025E-7873-93A3-C1FBA9149185" },
    },
  };
}

function sessionValue(): SessionContextValue {
  const realtime = {
    subscribeChannel: (
      _workspaceId: string,
      _channelId: string,
      handlers: { onMessage: (event: MessageNewEvent) => void }
    ) => {
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
      member: {
        id: IDS.self,
        workspaceId: IDS.ws,
        kind: "human",
        displayName: "데모 사용자",
        handle: "demo",
      },
      realtimeWebSocketUrl: "wss://example.test/connection/websocket",
    },
    workspaceId: IDS.ws,
    realtime,
    connStatus: "connected",
    logout: () => undefined,
    replaceSessionMember: () => undefined,
  };
}

function mountRail(path = "/"): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  mountedHost = host;
  mountedRoot = createRoot(host);
  const tree: ReactElement = createElement(
    MemoryRouter,
    { initialEntries: [path] },
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
            // 이동 횟수까지 읽으려고 location.key 도 싣는다(같은 주소로 다시 가도 키는 새로 난다).
            createElement(
              "output",
              { "data-testid": "notification-route", "data-key": location.key },
              location.pathname + location.search
            )
          );
        })
      )
    )
  );
  act(() => mountedRoot?.render(tree));
  return host;
}

const routeOf = (host: HTMLElement) => host.querySelector('[data-testid="notification-route"]')?.textContent;
const keyOf = (host: HTMLElement) => host.querySelector('[data-testid="notification-route"]')?.getAttribute("data-key");

/** 약속이 풀리는 만큼의 미세 작업 차례를 흘려보낸다(배너 보내기는 약속 사슬이다). */
async function drain(): Promise<void> {
  for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
}

/** 마운트하고 셸의 「클릭을 알려 주는가」 답이 페이지에 닿을 때까지 흘려보낸다. */
async function mountSettled(path = "/"): Promise<HTMLElement> {
  const host = mountRail(path);
  await act(async () => {
    await drain();
  });
  return host;
}

/** 이벤트 하나(또는 여럿)를 알림 레일에 넣고 묶음을 지금 보낸다. */
async function fire(...events: MessageNewEvent[]): Promise<void> {
  await act(async () => {
    for (const event of events) onMessage?.(event);
    osNotifier().flush();
    await drain();
  });
}

/** 셸이 보낸 클릭 이벤트가 페이지에 닿는다. */
function click(payload: unknown): void {
  act(() => shell.deliver?.(payload));
}

/** 셸에 실제로 보낸 클릭 가능한 배너의 `{ id, target }`. */
function sentClick(index = 0): ClickPayload {
  const call = showClickable.mock.calls[index] as [string, string | undefined, ClickPayload] | undefined;
  if (call === undefined) throw new Error(`클릭 가능한 배너 ${index + 1}번째가 셸에 나가지 않았다`);
  return call[2];
}

function focusWindow(): void {
  act(() => window.dispatchEvent(new Event("focus")));
}

/** 열려 있는 대화상자 하나를 다른 뿌리에 세운다. 닫히는 순간의 경로를 알린다. */
function mountOpenDialog(onOpenChange: (open: boolean) => void): { host: HTMLElement; root: Root } {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  function Probe() {
    const [open, setOpen] = useState(true);
    return createElement(
      Dialog,
      {
        open,
        onOpenChange: (next: boolean) => {
          onOpenChange(next);
          setOpen(next);
        },
      },
      createElement(
        DialogContent,
        null,
        createElement(DialogTitle, null, "열려 있던 대화상자"),
        createElement(DialogDescription, null, "알림이 걷는다")
      )
    );
  }
  act(() => root.render(createElement(Probe)));
  return { host, root };
}

describe("셸이 클릭을 알려 주는 곳 (macOS)", () => {
  it("멘션 배너는 클릭 가능한 길로 나가고(일반 배너는 아니다), 클릭 이벤트가 오면 그 채널로 간다", async () => {
    const host = await mountSettled();
    await fire(mentionEvent());

    expect(showNotification).not.toHaveBeenCalled();
    expect(showClickable).toHaveBeenCalledTimes(1);
    const sent = sentClick();
    expect(sent.target).toBe(`/c/${IDS.channel}`);
    expect(routeOf(host)).toBe("/");

    click(sent);

    expect(routeOf(host)).toBe(`/c/${IDS.channel}`);
  });

  it("승인 배너는 그 카드로, 스레드 안의 카드면 스레드까지 가진 주소로 간다", async () => {
    const host = await mountSettled();
    const event = approvalEvent();
    event.payload.root_id = IDS.root;
    await fire(event);

    const sent = sentClick();
    expect(sent.target).toBe(`${messageAnchorPath(IDS.channel, event.payload.id)}&thread=${IDS.root}`);
    click(sent);
    expect(routeOf(host)).toBe(sent.target);
  });

  it("한 묶음이 된 서로 다른 카드의 배너는 눌러도 한 곳을 고르지 않고 멘션 인박스로 간다", async () => {
    const host = await mountSettled();
    await fire(approvalEvent("019F96A4-E717-7F82-9750-58B2D7D28226"), approvalEvent("019F96A4-E717-7F82-9750-58B2D7D28227"));

    expect(showClickable).toHaveBeenCalledTimes(1);
    expect(showClickable.mock.calls[0]?.[0]).toBe("승인 필요 2건");
    click(sentClick());
    expect(routeOf(host)).toBe("/inbox?filter=mentions");
  });

  it("클릭 없이 창만 앞에 와도 이동하지 않는다 — 배너를 무시하고 돌아온 사람을 잘못 옮기지 않는다 (#5059 핵심)", async () => {
    const host = await mountSettled();
    await fire(approvalEvent());
    expect(showClickable).toHaveBeenCalledTimes(1);

    // 20초 안에 창이 앞에 왔다: 옛 어림이었다면 여기서 그 카드로 갔다.
    focusWindow();

    expect(routeOf(host)).toBe("/");
  });

  it("클릭이 오면 열려 있던 대화상자를 먼저 걷고 간다", async () => {
    const host = await mountSettled();
    const closedAt: Array<string | null | undefined> = [];
    const dialog = mountOpenDialog((open) => {
      if (!open) closedAt.push(routeOf(host));
    });
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    await fire(approvalEvent());

    click(sentClick());

    expect(routeOf(host)).toBe(messageAnchorPath(IDS.channel, "019F96A4-E717-7F82-9750-58B2D7D28226"));
    // 걷히는 순간 경로는 아직 떠나기 전의 자리(`/`)였다 — 이동 전에 걷었다.
    expect(closedAt).toEqual(["/"]);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    act(() => dialog.root.unmount());
    dialog.host.remove();
  });

  it("앱이 만든 배너가 아닌 클릭은 버린다: 모르는 id, 다른 목적지의 페이로드, 모양이 틀린 값", async () => {
    const host = await mountSettled();
    await fire(approvalEvent());
    const sent = sentClick();
    const key = keyOf(host);

    click({ id: "n-unknown-1", target: sent.target });
    click({ id: "n-unknown-1", target: "/inbox?filter=mentions" });
    click({ id: sent.id, target: "/inbox?filter=mentions" });
    click({ id: sent.id });
    click(null);
    click("/inbox");

    expect(routeOf(host)).toBe("/");
    expect(keyOf(host)).toBe(key);
    // 진짜 클릭은 그 뒤에도 먹는다(잘못된 페이로드가 줄을 지우지 않았다).
    click(sent);
    expect(routeOf(host)).toBe(sent.target);
  });

  it("같은 클릭이 두 번 와도 한 번만 간다", async () => {
    const host = await mountSettled();
    await fire(mentionEvent());
    const sent = sentClick();

    click(sent);
    const afterFirst = keyOf(host);
    click(sent);

    expect(keyOf(host)).toBe(afterFirst);
  });

  it("다른 곳을 보고 있어도 오래된 배너의 클릭은 그 배너의 목적지로 간다(알림 센터에 남아 있던 것)", async () => {
    const host = await mountSettled("/settings");
    await fire(mentionEvent());
    expect(routeOf(host)).toBe("/settings");

    click(sentClick());

    expect(routeOf(host)).toBe(`/c/${IDS.channel}`);
  });

  it("클릭 가능한 배너는 눌린 뒤에 창이 앞에 와도 다시 가지 않는다(클릭 한 번 = 이동 한 번)", async () => {
    const host = await mountSettled();
    await fire(approvalEvent());
    click(sentClick());
    const afterClick = keyOf(host);

    focusWindow();

    expect(keyOf(host)).toBe(afterClick);
  });

  it("셸의 답이 알림보다 늦게 와도 — 먼저 무장된 어림은 거두어지고, 배너는 클릭으로 간다", async () => {
    let answer: (supported: boolean) => void = () => undefined;
    shell.supported = new Promise<boolean>((resolve) => {
      answer = resolve;
    });
    const host = mountRail();
    // 답이 없는 사이에 알림이 왔다: 옛 방식으로 무장된다.
    await act(async () => {
      onMessage?.(approvalEvent());
      await drain();
    });
    // 셸이 「클릭을 알려 준다」고 답한다. 그 뒤 묶음이 클릭 가능한 길로 나간다.
    await act(async () => {
      answer(true);
      await drain();
      osNotifier().flush();
      await drain();
    });
    expect(showClickable).toHaveBeenCalledTimes(1);
    expect(showNotification).not.toHaveBeenCalled();

    focusWindow();
    expect(routeOf(host)).toBe("/");

    click(sentClick());
    expect(routeOf(host)).toBe(messageAnchorPath(IDS.channel, "019F96A4-E717-7F82-9750-58B2D7D28226"));
  });

  it("셸이 배너를 뜨지 못하게 거절하면(권한 없음) 어림도 무장하지 않는다", async () => {
    shell.outcome = "refused";
    const host = await mountSettled();
    await fire(approvalEvent());
    expect(showClickable).toHaveBeenCalledTimes(1);

    focusWindow();

    expect(routeOf(host)).toBe("/");
  });

  it("화면이 내려가면 클릭 구독을 풀고 장부를 비운다 — 로그아웃 뒤 클릭은 아무 데도 가지 않는다", async () => {
    await mountSettled();
    await fire(mentionEvent());
    const sent = sentClick();
    expect(shell.deliver).not.toBeNull();

    act(() => mountedRoot?.unmount());
    mountedRoot = null;
    expect(shell.deliver).toBeNull();

    // 같은 id 로 다시 마운트해 클릭을 보내도(다음 사람) 장부에 없다.
    const host = await mountSettled();
    click(sent);
    expect(routeOf(host)).toBe("/");
  });
});

describe("셸이 배너의 클릭을 알려 주지만 이 배너는 못 알리는 때 (한도 초과 등)", () => {
  it("일반 배너로 뜬 것은 그 배너의 재료로 옛 어림을 무장한다 — 창이 앞에 오면 그 카드로 간다", async () => {
    shell.outcome = "plain";
    const host = await mountSettled();
    const event = approvalEvent();
    await fire(event);
    expect(showClickable).toHaveBeenCalledTimes(1);

    focusWindow();

    expect(routeOf(host)).toBe(messageAnchorPath(IDS.channel, event.payload.id));
  });

  it("일반 배너로 뜨면 그 id 의 클릭은 오지 않으므로 장부에 남기지 않는다", async () => {
    shell.outcome = "plain";
    const host = await mountSettled();
    await fire(mentionEvent());

    click(sentClick());

    expect(routeOf(host)).toBe("/");
  });
});

describe("셸이 클릭을 알려 주지 못하는 곳 (다른 OS · 옛 셸) — 옛 어림이 그대로다", () => {
  beforeEach(() => {
    shell.supported = Promise.resolve(false);
  });

  it("일반 배너로 나가고, 창이 앞에 오면 그 카드로 간다", async () => {
    const host = await mountSettled();
    const event = approvalEvent();
    await fire(event);

    expect(showClickable).not.toHaveBeenCalled();
    expect(showNotification).toHaveBeenCalledTimes(1);
    expect(routeOf(host)).toBe("/");

    focusWindow();

    expect(routeOf(host)).toBe(messageAnchorPath(IDS.channel, event.payload.id));
  });

  it("셸이 보내지도 않은 클릭 이벤트는 장부가 없으니 어디로도 보내지 않는다", async () => {
    const host = await mountSettled();
    await fire(approvalEvent());

    click({ id: "n-whatever-1", target: `/c/${IDS.channel}` });

    expect(routeOf(host)).toBe("/");
  });
});

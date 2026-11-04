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
import { DesktopNotifications } from "./DesktopNotifications";
import { osNotifier } from "./osNotifier";
import {
  reloadDesktopNotificationKindsForTest,
  setDesktopNotificationKind,
} from "./preference";
import { serverPauseActive } from "./serverPause";

// 브라우저 탭(셸 없음)에서의 같은 규칙 (#3340).

const IDS = vi.hoisted(() => ({
  ws: "00000000-0000-7000-8000-000000000001",
  self: "00000000-0000-7000-8000-000000000101",
  other: "00000000-0000-7000-8000-0000000005d1",
  channel: "00000000-0000-7000-8000-00000000020a",
  dm: "00000000-0000-7000-8000-00000000020b",
}));

const fetchNotificationRules = vi.hoisted(() => vi.fn());

// 서버 규칙 읽기만 가짜다(`DesktopNotifications.test.tsx` 와 같은 방식). 훅·판정·묶음·`Notification` 은 진짜(가짜 클래스)다.
vi.mock("@momo/core/features/settings/notificationRules", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@momo/core/features/settings/notificationRules")>();
  return {
    ...actual,
    fetchNotificationRules: (workspaceId: string) =>
      fetchNotificationRules(workspaceId) as Promise<NotificationRules>,
  };
});

vi.mock("@/lib/tauri", () => ({
  isDesktop: () => false,
  showNotification: () => {
    throw new Error("the desktop bridge must not be used in a tab");
  },
}));

vi.mock("@/features/workspace/useWorkspace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/workspace/useWorkspace")>();
  return {
    ...actual,
    useChannels: () => ({
      groups: {
        channels: [
          { id: IDS.channel, workspaceId: IDS.ws, kind: "public" as const, name: "ops", muted: false },
        ],
        dms: [{ id: IDS.dm, workspaceId: IDS.ws, kind: "dm" as const, name: "dm", muted: false }],
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

class FakeNotification {
  static permission: NotificationPermission = "granted";
  static requestPermission = vi.fn(async () => "granted" as NotificationPermission);
  static instances: FakeNotification[] = [];
  onclick: (() => void) | null = null;
  close = vi.fn();
  constructor(
    public title: string,
    public options?: NotificationOptions
  ) {
    FakeNotification.instances.push(this);
  }
}

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let mountedRoot: Root | null = null;
let mountedHost: HTMLElement | null = null;
let onMessage: ((event: MessageNewEvent) => void) | null = null;
let subscribed = 0;
let visibility: DocumentVisibilityState = "hidden";
let pathname = "";

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
});

beforeEach(() => {
  fetchNotificationRules.mockReset();
  fetchNotificationRules.mockResolvedValue({ dnd: false, mentionOverridesMute: false });
  FakeNotification.permission = "granted";
  FakeNotification.instances = [];
  FakeNotification.requestPermission.mockClear();
  vi.stubGlobal("Notification", FakeNotification);
  onMessage = null;
  subscribed = 0;
  visibility = "hidden";
  localStorage.clear();
  reloadDesktopNotificationKindsForTest(localStorage);
  vi.spyOn(document, "hasFocus").mockReturnValue(false);
});

afterEach(() => {
  if (mountedRoot) act(() => mountedRoot?.unmount());
  mountedRoot = null;
  mountedHost?.remove();
  mountedHost = null;
  reloadDesktopNotificationKindsForTest(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function message(over: { channel: string; id: string; props?: Record<string, unknown> }): MessageNewEvent {
  const now = Date.now();
  return {
    type: "message.new",
    v: 1,
    ts: now,
    seq: 1,
    payload: {
      id: over.id,
      channel_id: over.channel,
      seq: 1,
      type: "text",
      body: "확인 부탁드립니다",
      author_member_id: IDS.other,
      hlc_ts: now,
      hlc_count: 0,
      props: over.props ?? {},
    },
  };
}
const mention = () =>
  message({ channel: IDS.channel, id: "019F96A4-E717-7F82-9750-58B2D7D28225", props: { mention_member_ids: [IDS.self] } });
const dmMessage = () => message({ channel: IDS.dm, id: "019F96A4-E717-7F82-9750-58B2D7D28301" });

function sessionValue(): SessionContextValue {
  const realtime = {
    subscribeChannel: (_w: string, _c: string, handlers: { onMessage: (e: MessageNewEvent) => void }) => {
      subscribed += 1;
      onMessage = handlers.onMessage;
      return () => {
        onMessage = null;
      };
    },
  } as unknown as RealtimeHandle;
  return {
    session: {
      accessToken: "a",
      refreshToken: "r",
      member: { id: IDS.self, workspaceId: IDS.ws, kind: "human", displayName: "데모", handle: "demo" },
      realtimeWebSocketUrl: "wss://example.test/connection/websocket",
    },
    workspaceId: IDS.ws,
    realtime,
    connStatus: "connected",
    logout: () => undefined,
    replaceSessionMember: () => undefined,
  };
}

function PathProbe() {
  pathname = useLocation().pathname;
  return null;
}

/**
 * 열려 있는 대화상자 하나를 **다른 뿌리**에 세운다(셸 위에 서는 전역 대화상자처럼). 알림 입구의 방송은 앱 하나의 것이라 어느 뿌리의
 * 구독자든 받는다. 닫기 요청이 올 때의 경로를 `onOpenChange` 로 알려, 이동보다 **먼저** 걷히는지 잰다.
 */
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

function mountRail(path = "/"): void {
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
        createElement(DesktopNotifications),
        createElement(PathProbe)
      )
    )
  );
  act(() => mountedRoot?.render(tree));
}

/**
 * 조건이 설 때까지 기다린다. 질의의 상태 알림은 약속이 풀린 **뒤** 매크로태스크에 나가므로 고정된 한 틱은
 * 부하에서 어긋난다(전체 시험에서만 붉던 시험이 그 증거다).
 */
async function until(condition: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 100 && !condition(); attempt += 1) {
    await act(async () => {
      await new Promise((resolve) => globalThis.setTimeout(resolve, 2));
    });
  }
  expect(condition(), what).toBe(true);
}

async function deliver(event: MessageNewEvent): Promise<void> {
  await act(async () => {
    onMessage?.(event);
    osNotifier().flush();
    await Promise.resolve();
  });
}

describe("DesktopNotifications in a browser tab (#3340)", () => {
  it("never asks for permission on load or on events; only a click may", async () => {
    FakeNotification.permission = "default";
    mountRail();
    await deliver(mention());
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
    expect(FakeNotification.instances).toHaveLength(0);
    // 권한이 없으면 구독도 만들지 않는다: 탭은 켜지 않은 기능에 값을 내지 않는다.
    expect(subscribed).toBe(0);
    // 일시 중지 규칙도 읽지 않는다 — 배너를 낼 수 없는 탭이 쓰지 않을 값에 요청을 내지 않는다(#4197).
    expect(fetchNotificationRules).not.toHaveBeenCalled();
  });

  it("a denied tab stays silent", async () => {
    FakeNotification.permission = "denied";
    mountRail();
    await deliver(mention());
    expect(FakeNotification.instances).toHaveLength(0);
    expect(subscribed).toBe(0);
    expect(fetchNotificationRules).not.toHaveBeenCalled();
  });

  it("a granted, hidden tab gets the mention banner", async () => {
    mountRail();
    expect(subscribed).toBeGreaterThan(0);
    await deliver(mention());
    expect(FakeNotification.instances).toHaveLength(1);
    expect(FakeNotification.instances[0]?.title).toBe("곽성재");
  });

  it("a granted tab holds its banner while the server pause is on, and shows it once it is off (#4197)", async () => {
    // 같은 규칙이 탭에도 선다: 서버가 일시 중지라고 답한 동안은 권한이 있어도 배너가 없다.
    fetchNotificationRules.mockResolvedValue({
      dnd: true,
      mentionOverridesMute: false,
      dndUntilMs: Date.now() + 3_600_000,
    });
    mountRail();
    await until(serverPauseActive, "서버의 일시 중지가 이 탭에 닿았다");
    expect(fetchNotificationRules).toHaveBeenCalledTimes(1);
    await deliver(mention());
    expect(FakeNotification.instances).toHaveLength(0);
  });

  it("the same tab shows the banner when the server pause is off (control for the one above)", async () => {
    mountRail();
    await until(() => fetchNotificationRules.mock.calls.length >= 1, "규칙 읽기가 시작됐다");
    await deliver(mention());
    expect(serverPauseActive()).toBe(false);
    expect(FakeNotification.instances).toHaveLength(1);
  });

  it("DM is off by default, and on once the person turns it on", async () => {
    mountRail();
    await deliver(dmMessage());
    expect(FakeNotification.instances).toHaveLength(0);
    setDesktopNotificationKind("dm", true, localStorage);
    await deliver({ ...dmMessage(), payload: { ...dmMessage().payload, id: "019F96A4-E717-7F82-9750-58B2D7D28302" } } as MessageNewEvent);
    expect(FakeNotification.instances).toHaveLength(1);
  });

  it("a visible AND focused tab on the target stays silent", async () => {
    visibility = "visible";
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    mountRail("/c/" + IDS.channel);
    await deliver(mention());
    expect(FakeNotification.instances).toHaveLength(0);
  });

  it("visible but unfocused (another window in front) still notifies", async () => {
    visibility = "visible";
    mountRail("/c/" + IDS.channel);
    await deliver(mention());
    expect(FakeNotification.instances).toHaveLength(1);
  });

  it("focused but hidden still notifies", async () => {
    visibility = "hidden";
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    mountRail("/c/" + IDS.channel);
    await deliver(mention());
    expect(FakeNotification.instances).toHaveLength(1);
  });

  it("a front tab looking at another screen still notifies, and the click routes to the channel", async () => {
    visibility = "visible";
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    vi.spyOn(window, "focus").mockImplementation(() => undefined);
    mountRail("/inbox");
    await deliver(mention());
    expect(FakeNotification.instances).toHaveLength(1);
    await act(async () => {
      FakeNotification.instances[0]?.onclick?.();
    });
    expect(pathname).toBe("/c/" + IDS.channel);
  });

  it("배너를 누르면 열려 있던 대화상자를 먼저 걷고 그 채널로 간다 (#4667)", async () => {
    visibility = "visible";
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    vi.spyOn(window, "focus").mockImplementation(() => undefined);
    mountRail("/inbox");
    const closedAt: string[] = [];
    const dialog = mountOpenDialog((open) => {
      if (!open) closedAt.push(pathname);
    });
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    await deliver(mention());
    expect(FakeNotification.instances).toHaveLength(1);

    await act(async () => {
      FakeNotification.instances[0]?.onclick?.();
    });

    expect(pathname).toBe("/c/" + IDS.channel);
    // 걷히는 순간 경로는 아직 떠나기 전의 자리였다 — 이동 **전에** 걷었다.
    expect(closedAt).toEqual(["/inbox"]);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    act(() => dialog.root.unmount());
    dialog.host.remove();
  });

  it("honours the same kind toggle as the desktop", async () => {
    mountRail();
    setDesktopNotificationKind("mention", false, localStorage);
    await deliver(mention());
    expect(FakeNotification.instances).toHaveLength(0);
  });
});

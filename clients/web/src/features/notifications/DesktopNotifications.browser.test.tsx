// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import type { MessageNewEvent } from "@momo/core/lib/realtimeEvents";
import type { RealtimeHandle } from "@/lib/realtime";
import { DesktopNotifications } from "./DesktopNotifications";
import { osNotifier } from "./osNotifier";
import {
  reloadDesktopNotificationKindsForTest,
  setDesktopNotificationKind,
} from "./preference";

// 브라우저 탭(셸 없음)에서의 같은 규칙 (#3340).

const IDS = vi.hoisted(() => ({
  ws: "00000000-0000-7000-8000-000000000001",
  self: "00000000-0000-7000-8000-000000000101",
  other: "00000000-0000-7000-8000-0000000005d1",
  channel: "00000000-0000-7000-8000-00000000020a",
  dm: "00000000-0000-7000-8000-00000000020b",
}));

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

function mountRail(path = "/"): void {
  const host = document.createElement("div");
  document.body.append(host);
  mountedHost = host;
  mountedRoot = createRoot(host);
  const tree: ReactElement = createElement(
    MemoryRouter,
    { initialEntries: [path] },
    createElement(
      SessionProvider,
      { value: sessionValue() },
      createElement(DesktopNotifications),
      createElement(PathProbe)
    )
  );
  act(() => mountedRoot?.render(tree));
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
  });

  it("a denied tab stays silent", async () => {
    FakeNotification.permission = "denied";
    mountRail();
    await deliver(mention());
    expect(FakeNotification.instances).toHaveLength(0);
    expect(subscribed).toBe(0);
  });

  it("a granted, hidden tab gets the mention banner", async () => {
    mountRail();
    expect(subscribed).toBeGreaterThan(0);
    await deliver(mention());
    expect(FakeNotification.instances).toHaveLength(1);
    expect(FakeNotification.instances[0]?.title).toBe("곽성재");
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

  it("honours the same kind toggle as the desktop", async () => {
    mountRail();
    setDesktopNotificationKind("mention", false, localStorage);
    await deliver(mention());
    expect(FakeNotification.instances).toHaveLength(0);
  });
});

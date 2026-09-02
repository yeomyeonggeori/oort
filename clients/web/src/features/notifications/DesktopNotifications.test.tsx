// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import type { MessageNewEvent } from "@momo/core/lib/realtimeEvents";
import type { RealtimeHandle } from "@/lib/realtime";
import { DesktopNotifications } from "./DesktopNotifications";
import {
  reloadDesktopNotificationKindsForTest,
  setDesktopNotificationKind,
} from "./preference";

const IDS = vi.hoisted(() => ({
  ws: "00000000-0000-7000-8000-000000000001",
  self: "00000000-0000-7000-8000-000000000101",
  other: "00000000-0000-7000-8000-0000000005d1",
  agent: "00000000-0000-7000-8000-000000000103",
  channel: "00000000-0000-7000-8000-000000000201",
}));

const showNotification = vi.hoisted(() => vi.fn());

vi.mock("@/lib/tauri", () => ({
  isDesktop: () => true,
  showNotification: (...args: unknown[]) => showNotification(...args),
}));

vi.mock("@/features/workspace/useWorkspace", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/workspace/useWorkspace")>();
  return {
    ...actual,
    useChannels: () => ({
      groups: {
        channels: [
          {
            id: IDS.channel,
            workspaceId: IDS.ws,
            kind: "public" as const,
            name: "ops",
            muted: false,
          },
        ],
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

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let mountedRoot: Root | null = null;
let mountedHost: HTMLElement | null = null;
let onMessage: ((event: MessageNewEvent) => void) | null = null;

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  showNotification.mockReset();
  showNotification.mockResolvedValue(true);
  onMessage = null;
  localStorage.clear();
  reloadDesktopNotificationKindsForTest(localStorage);
  vi.spyOn(document, "hasFocus").mockReturnValue(false);
});

afterEach(() => {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  mountedHost?.remove();
  mountedHost = null;
  reloadDesktopNotificationKindsForTest(null);
  vi.restoreAllMocks();
});

function mentionEvent(): MessageNewEvent {
  const now = Date.now();
  return {
    type: "message.new",
    v: 1,
    ts: now,
    seq: 42,
    payload: {
      id: "019F96A4-E717-7F82-9750-58B2D7D28225",
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

function approvalEvent(): MessageNewEvent {
  const now = Date.now();
  return {
    type: "message.new",
    v: 1,
    ts: now,
    seq: 43,
    payload: {
      id: "019F96A4-E717-7F82-9750-58B2D7D28226",
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

function mountRail(): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  mountedHost = host;
  mountedRoot = createRoot(host);
  const tree: ReactElement = createElement(
    MemoryRouter,
    null,
    createElement(
      SessionProvider,
      { value: sessionValue() },
      createElement(DesktopNotifications)
    )
  );
  act(() => mountedRoot?.render(tree));
  return host;
}

describe("DesktopNotifications", () => {
  it("shows a mention through the shell bridge", async () => {
    mountRail();
    expect(onMessage).not.toBeNull();
    await act(async () => {
      onMessage?.(mentionEvent());
      await Promise.resolve();
    });
    expect(showNotification).toHaveBeenCalledTimes(1);
    expect(showNotification.mock.calls[0]?.[0]).toBe("곽성재");
  });

  it("honours this-device kind toggles on the live rail", async () => {
    mountRail();
    setDesktopNotificationKind("mention", false, localStorage);
    await act(async () => {
      onMessage?.(mentionEvent());
      await Promise.resolve();
    });
    expect(showNotification).not.toHaveBeenCalled();

    await act(async () => {
      onMessage?.(approvalEvent());
      await Promise.resolve();
    });
    expect(showNotification).toHaveBeenCalledTimes(1);
  });
});

// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import type { MessageNewEvent } from "@momo/core/lib/realtimeEvents";
import type { RealtimeHandle } from "@/lib/realtime";
import { ApprovalsLiveSync } from "./ApprovalsLiveSync";

// =============================================================================
// #3738 — 새 승인 카드가 올라오면 「처리할 일」 쿼리가 바로 무효화된다.
// 이 시험은 ApprovalsLiveSync 의 구독·필터·합치기를 되돌리면 실패한다.
// =============================================================================

const IDS = vi.hoisted(() => ({
  ws: "00000000-0000-7000-8000-000000000001",
  self: "00000000-0000-7000-8000-000000000101",
  agent: "00000000-0000-7000-8000-000000000103",
  channel: "00000000-0000-7000-8000-00000000020a",
  dm: "00000000-0000-7000-8000-00000000020b",
}));

vi.mock("@/features/workspace/useWorkspace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/workspace/useWorkspace")>();
  return {
    ...actual,
    useChannels: () => ({
      groups: {
        channels: [{ id: IDS.channel, kind: "public", name: "ops", muted: true }],
        dms: [{ id: IDS.dm, kind: "dm", name: "", muted: false }],
      },
    }),
  };
});

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root | null = null;
let host: HTMLElement | null = null;
const handlers = new Map<string, (event: MessageNewEvent) => void>();
const subscribed = new Map<string, () => void>();
let stops = 0;

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  vi.useFakeTimers();
  handlers.clear();
  subscribed.clear();
  stops = 0;
});
afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  vi.useRealTimers();
});

function sessionValue(): SessionContextValue {
  const realtime = {
    subscribeChannel: (
      _ws: string,
      channelId: string,
      h: { onMessage: (e: MessageNewEvent) => void; onSubscribed: () => void }
    ) => {
      handlers.set(channelId, h.onMessage);
      subscribed.set(channelId, h.onSubscribed);
      return () => {
        stops += 1;
        handlers.delete(channelId);
      };
    },
  } as unknown as RealtimeHandle;
  return {
    session: {
      accessToken: "a",
      refreshToken: "r",
      member: { id: IDS.self, workspaceId: IDS.ws, kind: "human", displayName: "나", handle: "me" },
      realtimeWebSocketUrl: "wss://example.test/connection/websocket",
    },
    workspaceId: IDS.ws,
    realtime,
    connStatus: "connected",
    logout: () => undefined,
    replaceSessionMember: () => undefined,
  } as unknown as SessionContextValue;
}

function event(type: string): MessageNewEvent {
  return {
    type: "message.new",
    v: 1,
    ts: 1,
    seq: 1,
    payload: {
      id: "019F96A4-E717-7F82-9750-58B2D7D28226",
      channel_id: IDS.channel,
      seq: 1,
      type,
      author_member_id: IDS.agent,
      hlc_ts: 1,
      hlc_count: 0,
    },
  };
}

function mount(client: QueryClient) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(SessionProvider, { value: sessionValue() }, createElement(ApprovalsLiveSync))
      )
    );
  });
}

describe("ApprovalsLiveSync (#3738)", () => {
  it("음소거한 채널까지 구독한다 — 결정을 기다리는 일은 음소거를 따르지 않는다", () => {
    mount(new QueryClient());
    expect([...handlers.keys()].sort()).toEqual([IDS.channel, IDS.dm].sort());
  });

  it("approval_request 메시지가 오면 대기 목록을 한 번 무효화한다", () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    mount(client);
    act(() => {
      handlers.get(IDS.channel)?.(event("approval_request"));
      handlers.get(IDS.channel)?.(event("approval_request"));
      vi.advanceTimersByTime(300);
    });
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["approvals", IDS.ws] });
  });

  it("일반 메시지에는 반응하지 않는다", () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    mount(client);
    act(() => {
      handlers.get(IDS.channel)?.(event("text"));
      vi.advanceTimersByTime(300);
    });
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("구독이 (재)연결되면 놓친 프레임을 위해 한 번 다시 읽는다", () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    mount(client);
    act(() => {
      subscribed.get(IDS.channel)?.();
      subscribed.get(IDS.dm)?.();
      vi.advanceTimersByTime(300);
    });
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it("언마운트하면 구독을 모두 놓는다", () => {
    mount(new QueryClient());
    act(() => root?.unmount());
    root = null;
    expect(stops).toBe(2);
  });
});

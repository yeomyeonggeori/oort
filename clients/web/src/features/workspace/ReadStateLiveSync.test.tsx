// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import type { InboxEvent } from "@momo/core/features/inbox/serverInbox";
import type { RealtimeHandle } from "@/lib/realtime";
import { ReadStateLiveSync } from "./ReadStateLiveSync";

// =============================================================================
// #5660 — 나를 부른 새 글의 신호(`inbox_item.created`)가 오면 읽음 투영을 바로 다시 읽는다. 독 배지·메뉴 막대 점·탭 제목이
// 그 투영의 멘션 수를 읽는다. 이 시험은 구독·무효화·합치기·다시 붙음을 되돌리면 실패한다.
// =============================================================================

const IDS = vi.hoisted(() => ({
  ws: "00000000-0000-7000-8000-000000000001",
  self: "00000000-0000-7000-8000-000000000101",
}));

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root | null = null;
let host: HTMLElement | null = null;
let rail: { member: string; onEvent: (event: InboxEvent) => void; onResync: () => void } | null = null;
let followedRail: { member: string; onSignal: () => void; onResync: () => void } | null = null;
let stops = 0;

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  vi.useFakeTimers();
  rail = null;
  followedRail = null;
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
    subscribeInbox: (member: string, handlers: { onEvent: (event: InboxEvent) => void; onResync: () => void }) => {
      rail = { member, ...handlers };
      return () => {
        stops += 1;
        rail = null;
      };
    },
    subscribeFollowedUnread: (member: string, handlers: { onSignal: () => void; onResync: () => void }) => {
      followedRail = { member, ...handlers };
      return () => {
        stops += 1;
        followedRail = null;
      };
    },
  } as unknown as RealtimeHandle;
  return {
    session: {
      accessToken: "a",
      refreshToken: "r",
      member: { id: IDS.self, workspaceId: IDS.ws, kind: "human", displayName: "김도현", handle: "dohyun" },
      realtimeWebSocketUrl: "wss://example.test/connection/websocket",
    },
    workspaceId: IDS.ws,
    realtime,
    connStatus: "connected",
    logout: () => undefined,
    replaceSessionMember: () => undefined,
  } as unknown as SessionContextValue;
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
        createElement(SessionProvider, { value: sessionValue() }, createElement(ReadStateLiveSync))
      )
    );
  });
}

const readStateCalls = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.filter(
    ([filters]) => JSON.stringify((filters as { queryKey?: unknown } | undefined)?.queryKey) === JSON.stringify(["read-state", IDS.ws])
  ).length;

describe("ReadStateLiveSync (#5660)", () => {
  it("내 개인 채널을 듣는다", () => {
    mount(new QueryClient());
    expect(rail?.member).toBe(IDS.self);
  });

  it("나를 부른 새 글의 신호가 오면 합치는 창(0.25초)이 지난 뒤 읽음 투영을 한 번 무효화한다(몰려 와도 한 번)", () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    mount(client);
    act(() => {
      rail?.onEvent({ type: "inbox_item.created", itemId: "a" });
      rail?.onEvent({ type: "inbox_item.created", itemId: "b" });
      vi.advanceTimersByTime(249);
    });
    expect(readStateCalls(invalidate)).toBe(0);
    act(() => void vi.advanceTimersByTime(1));
    expect(readStateCalls(invalidate)).toBe(1);
    // 다른 쿼리는 건드리지 않는다.
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it("따라가는 스레드의 답글 신호(`followed_unread.updated`, 서버 #5667)도 같은 창으로 합쳐 한 번 무효화한다 (#5660)", () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    mount(client);
    expect(followedRail?.member).toBe(IDS.self);
    act(() => {
      followedRail?.onSignal();
      rail?.onEvent({ type: "inbox_item.created", itemId: "a" });
      followedRail?.onSignal();
      vi.advanceTimersByTime(249);
    });
    expect(readStateCalls(invalidate)).toBe(0);
    act(() => void vi.advanceTimersByTime(1));
    expect(readStateCalls(invalidate)).toBe(1);
  });

  it("다시 붙으면(끊긴 동안 온 신호는 다시 오지 않을 수 있다) 한 번 다시 읽는다", () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    mount(client);
    act(() => {
      rail?.onResync();
      vi.advanceTimersByTime(300);
    });
    expect(readStateCalls(invalidate)).toBe(1);
  });

  it("내려가면 구독을 풀고 남은 합치기 타이머도 거둔다", () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    mount(client);
    act(() => rail?.onEvent({ type: "inbox_item.created", itemId: "a" }));
    act(() => root?.unmount());
    root = null;
    act(() => void vi.advanceTimersByTime(1_000));
    expect(stops).toBe(2); // 인박스 신호·답글 신호 두 손잡이 모두
    expect(readStateCalls(invalidate)).toBe(0);
  });
});

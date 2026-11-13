// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Channel, ReadState } from "@momo/core/lib/api";
import { ReadStateLiveSync } from "@/features/workspace/ReadStateLiveSync";
import { DockBadge } from "./DockBadge";
import { reloadDesktopNotificationKindsForTest } from "./preference";
import { resetViewedThreadForTest, viewThread } from "./viewedThread";

// =============================================================================
// #5660 (owner 11-11 「켜줘」) · 서버 #5667 — 따라가는 스레드의 답글 몫이 맥의 독 배지(=메뉴 막대 점과 같은 수)에 닿는 길을 실제 훅으로 잠근다:
// 서버 신호 `followed_unread.updated` → 읽음 투영 다시 읽기(250ms 합치기) → 채널 줄의 `followedUnreadReplyCount` → 배지 수.
// 다른 기기에서 그 스레드를 읽으면 서버가 같은 신호를 보내고, 다시 읽은 투영의 0으로 표시가 꺼진다. 인박스 신호는 한 번도 쏘지 않는다
// (직접 따라가기만 누른 사람에게는 인박스 항목이 없다, migration 126).
// =============================================================================

const IDS = vi.hoisted(() => ({
  ws: "00000000-0000-7000-8000-000000000001",
  self: "00000000-0000-7000-8000-000000000101",
  channel: "00000000-0000-7000-8000-0000000000c1",
  root: "00000000-0000-7000-8000-0000000000e1",
}));

const hoisted = vi.hoisted(() => ({
  setDockBadge: vi.fn(async (_count: number) => true),
  followed: 0 as number | undefined,
  foreground: false,
  fetches: 0,
  signal: null as null | { onSignal: () => void; onResync: () => void },
}));

function row(): ReadState {
  const base: ReadState = {
    channelId: IDS.channel,
    lastReadSeq: 5,
    latestSeq: 5,
    unreadCount: 0,
    mentionCount: 0,
    markedUnreadBeforeSeq: null,
  };
  return hoisted.followed === undefined ? base : { ...base, followedUnreadReplyCount: hoisted.followed };
}

vi.mock("@momo/core/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@momo/core/lib/api")>()),
  fetchReadStates: async () => {
    hoisted.fetches += 1;
    return [row()];
  },
  listChannels: async (): Promise<Channel[]> => [
    { id: IDS.channel, workspaceId: IDS.ws, kind: "public", name: "디자인", muted: false },
  ],
}));
vi.mock("@/lib/tauri", () => ({
  isDesktop: () => true,
  setDockBadge: (n: number) => hoisted.setDockBadge(n),
}));
vi.mock("@/app/session", () => ({
  useSession: () => ({
    workspaceId: IDS.ws,
    session: { member: { id: IDS.self } },
    realtime: {
      subscribeFollowedUnread: (_member: string, handlers: { onSignal: () => void; onResync: () => void }) => {
        hoisted.signal = handlers;
        return () => {
          hoisted.signal = null;
        };
      },
    },
  }),
}));
vi.mock("@/features/inbox/useNeedsMe", () => ({ useNeedsMeCount: () => 0 }));
vi.mock("react-router-dom", () => ({ useLocation: () => ({ pathname: `/c/${IDS.channel}` }) }));
vi.mock("@/features/chat/useChannelViewingBeat", () => ({ useDocumentForeground: () => hoisted.foreground }));

const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root | null = null;
let host: HTMLElement | null = null;

beforeAll(() => {
  env.IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  hoisted.setDockBadge.mockClear();
  hoisted.followed = 0;
  hoisted.foreground = false;
  hoisted.fetches = 0;
  hoisted.signal = null;
  localStorage.clear();
  reloadDesktopNotificationKindsForTest(localStorage);
  resetViewedThreadForTest();
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  reloadDesktopNotificationKindsForTest(null);
  resetViewedThreadForTest();
});

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root?.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(ReadStateLiveSync),
        createElement(DockBadge)
      )
    )
  );
}

const lastBadge = () => hoisted.setDockBadge.mock.calls.at(-1)?.[0];

/** 쿼리가 풀리며 그리는 것까지 기다린다: 20ms씩 `act`로 흘려 보내고 조건을 본다(2초 안). */
async function settle(check: () => void) {
  const deadline = Date.now() + 2_000;
  for (;;) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    try {
      check();
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
    }
  }
}

async function badgeBecomes(n: number) {
  await settle(() => expect(lastBadge()).toBe(n));
}

describe("따라가는 스레드의 답글 → 독 배지·메뉴 막대 점 (#5660, 서버 #5667)", () => {
  it("뒤에 있는 동안 답글 신호 → 다시 읽어 켜지고, 다른 기기에서 그 스레드를 읽은 신호 → 다시 읽어 꺼진다", async () => {
    mount();
    await badgeBecomes(0);
    expect(hoisted.signal).not.toBeNull();
    const before = hoisted.fetches;

    // 따라가는 스레드에 남의 새 답글: 서버 값이 1이 되고 개인 채널로 신호(id만)가 온다.
    hoisted.followed = 1;
    await act(async () => hoisted.signal?.onSignal());
    await badgeBecomes(1);
    expect(hoisted.fetches).toBe(before + 1);

    // 폰에서 그 스레드를 읽었다: 서버 값이 0이 되고 같은 신호가 온다.
    hoisted.followed = 0;
    await act(async () => hoisted.signal?.onSignal());
    await badgeBecomes(0);
    expect(hoisted.fetches).toBe(before + 2);
  });

  it("옛 서버(필드 없음)는 신호가 와도 0이다: 이 몫이 없을 뿐 깨지지 않는다", async () => {
    hoisted.followed = undefined;
    mount();
    await badgeBecomes(0);
    const before = hoisted.fetches;
    await act(async () => hoisted.signal?.onSignal());
    await settle(() => expect(hoisted.fetches).toBe(before + 1));
    expect(lastBadge()).toBe(0);
  });

  it("앞에 있는 창이 그 채널의 스레드를 열어 두면 세지 않고, 닫으면 다시 센다", async () => {
    hoisted.followed = 2;
    hoisted.foreground = true;
    mount();
    await badgeBecomes(2);
    let close: () => void = () => undefined;
    act(() => {
      close = viewThread(IDS.channel.toUpperCase(), IDS.root);
    });
    await badgeBecomes(0);
    act(() => close());
    await badgeBecomes(2);
  });
});

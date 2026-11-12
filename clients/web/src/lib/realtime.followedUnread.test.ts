import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InboxEvent } from "@momo/core/features/inbox/serverInbox";

// #5660 · 서버 #5667(ADR-0124 증보 4): `followed_unread.updated`는 내 개인 채널로 온다. 실제 `createRealtime`의 배선을 잠근다 — 같은 채널
// 구독을 인박스 신호와 함께 쓰고(소켓·구독이 늘지 않는다), 이 신호만 듣고, 인박스 손잡이에는 넘기지 않는다.

type Handler = (ctx: { data?: unknown }) => void;

const mocks = vi.hoisted(() => ({
  publication: [] as Array<(ctx: { data?: unknown }) => void>,
  subscribed: [] as Array<() => void>,
  channels: [] as string[],
  newSubscriptions: 0,
}));

vi.mock("centrifuge", () => {
  class FakeCentrifuge {
    on(): void {}
    connect(): void {}
    disconnect(): void {}
    getSubscription(): null {
      return null;
    }
    newSubscription(name: string) {
      mocks.channels.push(name);
      mocks.newSubscriptions += 1;
      const sub = {
        state: "unsubscribed",
        on(event: string, fn: unknown) {
          if (event === "publication") mocks.publication.push(fn as Handler);
          if (event === "subscribed") mocks.subscribed.push(fn as () => void);
        },
        off(event: string, fn: unknown) {
          const list = event === "publication" ? mocks.publication : mocks.subscribed;
          const index = list.indexOf(fn as never);
          if (index >= 0) list.splice(index, 1);
        },
        subscribe() {
          sub.state = "subscribed";
        },
        unsubscribe() {
          sub.state = "unsubscribed";
        },
      };
      return sub;
    }
    removeSubscription(): void {}
  }
  return { Centrifuge: FakeCentrifuge };
});

const MEMBER = "00000000-0000-7000-8000-000000000101";

const FOLLOWED_FRAME = {
  type: "followed_unread.updated",
  v: 1,
  ts: 1_799_999_000_000,
  payload: {
    workspace_id: "00000000-0000-7000-8000-000000000001",
    member_id: MEMBER.toUpperCase(),
    channel_id: "00000000-0000-7000-8000-000000000201",
    root_id: "00000000-0000-7000-8000-0000000003E1",
  },
};

beforeEach(() => {
  mocks.publication = [];
  mocks.subscribed = [];
  mocks.channels = [];
  mocks.newSubscriptions = 0;
  vi.resetModules();
});

describe("the personal channel carries followed-thread reply signals (#5667, #5660)", () => {
  it("shares the inbox subscription, hears only its own frame, and resyncs on (re)subscribe", async () => {
    const { createRealtime } = await import("./realtime");
    const handle = createRealtime("ws://followed.invalid/connection/websocket", () => {});
    let signals = 0;
    let resyncs = 0;
    const inbox: InboxEvent[] = [];
    const stopFollowed = handle.subscribeFollowedUnread?.(MEMBER, {
      onSignal: () => (signals += 1),
      onResync: () => (resyncs += 1),
    });
    const stopInbox = handle.subscribeInbox?.(MEMBER, { onEvent: (event) => inbox.push(event), onResync: () => {} });

    expect(mocks.channels).toEqual([`user:read-state#${MEMBER.toUpperCase()}`]);
    expect(mocks.newSubscriptions).toBe(1);
    for (const emit of mocks.publication) {
      emit({ data: FOLLOWED_FRAME });
      emit({ data: { type: "inbox_item.created", v: 1, payload: { item_id: "X1" } } });
      emit({ data: { type: "scheduled_message.updated", v: 1, payload: {} } });
      emit({ data: "not a frame" });
    }
    expect(signals).toBe(1);
    // 인박스 손잡이는 이 신호를 받지 않는다(인박스 목록을 다시 읽을 까닭이 없다).
    expect(inbox).toEqual([{ type: "inbox_item.created", itemId: "X1" }]);

    for (const subscribed of mocks.subscribed) subscribed();
    expect(resyncs).toBe(1);

    stopFollowed?.();
    for (const emit of mocks.publication) emit({ data: FOLLOWED_FRAME });
    expect(signals).toBe(1);
    stopInbox?.();
  });
});

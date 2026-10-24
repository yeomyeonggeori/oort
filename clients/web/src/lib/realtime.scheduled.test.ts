import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InboxEvent } from "@momo/core/features/inbox/serverInbox";
import type { ScheduledMessageFrame } from "@momo/core/features/scheduled/events";

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

function scheduledFrameWire(overrides: Record<string, unknown> = {}) {
  return {
    type: "scheduled_message.updated",
    v: 1,
    ts: 1_799_999_000_000,
    payload: {
      workspace_id: "00000000-0000-7000-8000-000000000001",
      member_id: MEMBER.toUpperCase(),
      scheduled_message_id: "00000000-0000-7000-8000-0000000004A1",
      channel_id: "00000000-0000-7000-8000-000000000201",
      status: "failed",
      failure_reason: "sessions_ended",
      send_at_ms: 1_800_000_000_000,
      rev: 2,
      ...overrides,
    },
  };
}

beforeEach(() => {
  mocks.publication = [];
  mocks.subscribed = [];
  mocks.channels = [];
  mocks.newSubscriptions = 0;
  vi.resetModules();
});

describe("the personal channel carries scheduled-message signals (ADR-0208 D12)", () => {
  it("delivers a scheduled_message.updated frame, read by the core, on the member's personal channel", async () => {
    const { createRealtime } = await import("./realtime");
    const handle = createRealtime("ws://scheduled.invalid/connection/websocket", () => {});
    const seen: ScheduledMessageFrame[] = [];
    const stop = handle.subscribeScheduled?.(MEMBER, {
      onEvent: (frame) => seen.push(frame),
      onResync: () => {},
    });

    expect(mocks.channels).toEqual([`user:read-state#${MEMBER.toUpperCase()}`]);
    for (const emit of mocks.publication) emit({ data: scheduledFrameWire() });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      status: "failed",
      failureReason: "sessions_ended",
      rev: 2,
      scheduledMessageId: "00000000-0000-7000-8000-0000000004A1",
    });
    stop?.();
  });

  it("ignores every other frame of that channel: inbox and read-state signals are not scheduled signals", async () => {
    const { createRealtime } = await import("./realtime");
    const handle = createRealtime("ws://scheduled.invalid/connection/websocket", () => {});
    const seen: ScheduledMessageFrame[] = [];
    handle.subscribeScheduled?.(MEMBER, { onEvent: (frame) => seen.push(frame), onResync: () => {} });

    for (const emit of mocks.publication) {
      emit({ data: { type: "inbox_item.created", v: 1, payload: { item_id: "X" } } });
      emit({ data: { type: "read_state.updated", v: 1, payload: {} } });
      emit({ data: scheduledFrameWire({ status: "sending" }) });
      emit({ data: "not a frame" });
    }

    expect(seen).toEqual([]);
  });

  it("shares one subscription with the inbox signals and keeps the two readers apart", async () => {
    const { createRealtime } = await import("./realtime");
    const handle = createRealtime("ws://scheduled.invalid/connection/websocket", () => {});
    const scheduled: ScheduledMessageFrame[] = [];
    const inbox: InboxEvent[] = [];
    const stopScheduled = handle.subscribeScheduled?.(MEMBER, {
      onEvent: (frame) => scheduled.push(frame),
      onResync: () => {},
    });
    const stopInbox = handle.subscribeInbox?.(MEMBER, { onEvent: (event) => inbox.push(event), onResync: () => {} });

    // 한 채널 한 구독이다(`attach`가 세어 공유한다).
    expect(mocks.newSubscriptions).toBe(1);
    for (const emit of mocks.publication) {
      emit({ data: scheduledFrameWire() });
      emit({ data: { type: "inbox_item.created", v: 1, payload: { item_id: "X1" } } });
    }
    expect(scheduled.map((frame) => frame.status)).toEqual(["failed"]);
    expect(inbox).toEqual([{ type: "inbox_item.created", itemId: "X1" }]);

    // 하나가 놓아도 다른 하나의 구독은 살아 있다.
    stopScheduled?.();
    for (const emit of mocks.publication) emit({ data: { type: "inbox_item.created", v: 1, payload: { item_id: "X2" } } });
    expect(inbox).toHaveLength(2);
    stopInbox?.();
  });

  it("asks the caller to read again whenever the channel (re)subscribes", async () => {
    const { createRealtime } = await import("./realtime");
    const handle = createRealtime("ws://scheduled.invalid/connection/websocket", () => {});
    let resyncs = 0;
    const stop = handle.subscribeScheduled?.(MEMBER, { onEvent: () => {}, onResync: () => (resyncs += 1) });
    for (const fire of mocks.subscribed) fire();
    expect(resyncs).toBe(1);
    stop?.();
    // 놓은 뒤에는 부르지 않는다.
    for (const fire of mocks.subscribed) fire();
    expect(resyncs).toBe(1);
  });
});

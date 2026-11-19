import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageNewEvent } from "@momo/core/lib/realtimeEvents";

// 개인 채널로 옮겨 온 방 프레임 (ADR-0177 증보 2026-11-14 D17, #5825): 1:1 에서 상대가 나간 방의 하한 아래 옛 글에 대한 뒤늦은 이벤트는
// 방 채널이 아니라 볼 수 있는 멤버의 개인 채널로 온다. 방 구독이 그 프레임도 방 채널로 온 것과 같이 처리하는지, 다른 방의 것·개인 채널
// 본래의 신호는 넘기지 않는지, 멤버를 모르는 판(옛 호출)은 개인 채널을 듣지 않는지를 잰다.

type PublicationHandler = (ctx: { data?: unknown }) => void;

const mocks = vi.hoisted(() => ({
  byChannel: new Map<string, PublicationHandler[]>(),
  subscribed: [] as string[],
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
      const handlers = mocks.byChannel.get(name) ?? [];
      mocks.byChannel.set(name, handlers);
      const sub = {
        state: "unsubscribed",
        on(event: string, fn: unknown) {
          if (event === "publication") handlers.push(fn as PublicationHandler);
        },
        off(event: string, fn: unknown) {
          if (event !== "publication") return;
          const index = handlers.indexOf(fn as PublicationHandler);
          if (index >= 0) handlers.splice(index, 1);
        },
        subscribe() {
          sub.state = "subscribed";
          mocks.subscribed.push(name);
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

const WS = "00000000-0000-7000-8000-000000000001";
const ROOM = "00000000-0000-7000-8000-000000000302";
const OTHER = "00000000-0000-7000-8000-000000000303";
const ME = "00000000-0000-7000-8000-000000000101";
const PERSONAL = `user:read-state#${ME.toUpperCase()}`;
const roomName = (ch: string) => `ch:ws${WS.toUpperCase()}.${ch.toUpperCase()}`;

const edited = (room: string | null) => ({
  type: "message.edited",
  v: 1,
  ts: 1_800_000_000_000,
  seq: 3,
  payload: {
    id: "m-3",
    channel_id: ROOM,
    seq: 3,
    type: "text",
    body: "고친 옛 글",
    author_member_id: ME,
    hlc_ts: 1,
    hlc_count: 0,
  },
  ...(room === null ? {} : { room_channel: room }),
});

function emit(channel: string, data: unknown): void {
  for (const handler of [...(mocks.byChannel.get(channel) ?? [])]) handler({ data });
}

beforeEach(() => {
  mocks.byChannel = new Map();
  mocks.subscribed = [];
  vi.resetModules();
});

describe("개인 채널로 옮겨 온 방 프레임", () => {
  it("이 방의 것이면 방 채널로 온 것과 같이 처리하고, 다른 방의 것·room_channel 없는 신호는 넘기지 않는다", async () => {
    const { createRealtime } = await import("./realtime");
    const handle = createRealtime("ws://relay.invalid/connection/websocket", () => {}, ME);
    const seen: MessageNewEvent[] = [];
    const stop = handle.subscribeChannel(WS, ROOM, { onSubscribed: () => {}, onMessage: (event) => seen.push(event) });
    expect(mocks.subscribed).toContain(PERSONAL);

    emit(PERSONAL, edited(roomName(ROOM).toLowerCase())); // 대소문자를 가리지 않는다
    emit(PERSONAL, edited(roomName(OTHER)));
    emit(PERSONAL, { type: "inbox_item.created", v: 1, payload: { id: "i-1" } });
    emit(PERSONAL, edited(null));
    expect(seen.map((event) => event.payload.body)).toEqual(["고친 옛 글"]);

    // 방 채널로 온 것도 그대로다.
    emit(roomName(ROOM), edited(null));
    expect(seen).toHaveLength(2);

    stop();
    emit(PERSONAL, edited(roomName(ROOM)));
    expect(seen).toHaveLength(2);
  });

  it("멤버를 모르는 판은 개인 채널을 듣지 않는다(지금까지와 같다)", async () => {
    const { createRealtime } = await import("./realtime");
    const handle = createRealtime("ws://relay.invalid/connection/websocket", () => {});
    const seen: MessageNewEvent[] = [];
    handle.subscribeChannel(WS, ROOM, { onSubscribed: () => {}, onMessage: (event) => seen.push(event) });
    expect(mocks.subscribed).not.toContain(PERSONAL);
  });
});

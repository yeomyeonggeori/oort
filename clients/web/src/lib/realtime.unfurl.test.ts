import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UnfurlEvent } from "@momo/core/lib/realtimeEvents";

type PublicationHandler = (ctx: { data?: unknown }) => void;

const mocks = vi.hoisted(() => ({
  publication: [] as PublicationHandler[],
}));

vi.mock("centrifuge", () => {
  class FakeCentrifuge {
    on(): void {}
    connect(): void {}
    disconnect(): void {}
    getSubscription(): null {
      return null;
    }
    newSubscription() {
      const sub = {
        state: "unsubscribed",
        on(name: string, fn: unknown) {
          if (name === "publication") mocks.publication.push(fn as PublicationHandler);
        },
        off(name: string, fn: unknown) {
          if (name !== "publication") return;
          const index = mocks.publication.indexOf(fn as PublicationHandler);
          if (index >= 0) mocks.publication.splice(index, 1);
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

beforeEach(() => {
  mocks.publication = [];
  vi.resetModules();
});

describe("channel unfurl rail", () => {
  it("delivers both the live projection and its removal", async () => {
    const { createRealtime } = await import("./realtime");
    const handle = createRealtime("ws://unfurl.invalid/connection/websocket", () => {});
    const seen: UnfurlEvent[] = [];
    const stop = handle.subscribeChannel("w-1", "c-1", {
      onSubscribed: () => {},
      onMessage: () => {},
      onUnfurl: (event) => seen.push(event),
    });

    for (const emit of mocks.publication) {
      emit({
        data: {
          type: "message.unfurl",
          v: 1,
          ts: 1_700_000_000_000,
          seq: 9,
          payload: {
            message_id: "m-1",
            channel_id: "c-1",
            unfurls: [
              {
                id: "u-1",
                message_id: "m-1",
                url: "https://example.com",
                status: "ok",
              },
            ],
          },
        },
      });
      emit({
        data: {
          type: "message.unfurl.removed",
          v: 1,
          ts: 1_700_000_000_100,
          seq: 9,
          payload: { message_id: "m-1", channel_id: "c-1" },
        },
      });
    }

    expect(seen.map((event) => event.type)).toEqual([
      "message.unfurl",
      "message.unfurl.removed",
    ]);
    if (seen[0]?.type === "message.unfurl") {
      expect(seen[0].payload.unfurls[0]?.messageId).toBe("m-1");
    }
    stop();
  });
});

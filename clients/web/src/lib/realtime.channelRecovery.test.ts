import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SubscribedRecoveryContext } from "@momo/core/lib/realtimeEvents";

// Forwarding fact for subscribeChannel: the port must hand the handler
// both recovered and hasRecoveredPublications. Transport (what Centrifugo
// actually puts on `ch:` after truncated history) stays gate:resume.

type PublicationHandler = (ctx: { data?: unknown }) => void;
type SubscribedHandler = (ctx: SubscribedRecoveryContext) => void;

const mocks = vi.hoisted(() => ({
  subscribed: [] as SubscribedHandler[],
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
          if (name === "subscribed") mocks.subscribed.push(fn as SubscribedHandler);
          if (name === "publication") mocks.publication.push(fn as PublicationHandler);
        },
        off(name: string, fn: unknown) {
          if (name === "subscribed") {
            const index = mocks.subscribed.indexOf(fn as SubscribedHandler);
            if (index >= 0) mocks.subscribed.splice(index, 1);
          }
          if (name === "publication") {
            const index = mocks.publication.indexOf(fn as PublicationHandler);
            if (index >= 0) mocks.publication.splice(index, 1);
          }
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
  mocks.subscribed = [];
  mocks.publication = [];
  vi.resetModules();
});

async function subscribe(): Promise<{
  seen: SubscribedRecoveryContext[];
  stop: () => void;
}> {
  const { createRealtime } = await import("./realtime");
  const handle = createRealtime(
    "ws://recovery.invalid/connection/websocket",
    () => {}
  );
  const seen: SubscribedRecoveryContext[] = [];
  const stop = handle.subscribeChannel("w-1", "c-1", {
    onSubscribed: (ctx) => seen.push({ ...ctx }),
    onMessage: () => {},
  });
  return { seen, stop };
}

describe("subscribeChannel recovery context forwarding", () => {
  it("부분 복구 컨텍스트를 좁히지 않고 넘긴다", async () => {
    const { seen, stop } = await subscribe();
    const ctx: SubscribedRecoveryContext = {
      recovered: false,
      hasRecoveredPublications: true,
    };
    for (const fn of mocks.subscribed) fn(ctx);
    expect(seen).toEqual([
      { recovered: false, hasRecoveredPublications: true },
    ]);
    stop();
  });

  it("recovered true 도 그대로 넘긴다", async () => {
    const { seen, stop } = await subscribe();
    for (const fn of mocks.subscribed) {
      fn({ recovered: true, hasRecoveredPublications: true });
    }
    expect(seen).toEqual([
      { recovered: true, hasRecoveredPublications: true },
    ]);
    stop();
  });

  it("필드가 없는 컨텍스트를 recovered:false 로 다시 만들지 않는다", async () => {
    const { seen, stop } = await subscribe();
    for (const fn of mocks.subscribed) fn({});
    expect(seen).toEqual([{}]);
    expect(seen[0]).not.toHaveProperty("recovered");
    expect(seen[0]).not.toHaveProperty("hasRecoveredPublications");
    stop();
  });
});

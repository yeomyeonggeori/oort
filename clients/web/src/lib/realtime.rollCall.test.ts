import { beforeEach, describe, expect, it, vi } from "vitest";

// The workspace roll-call rail (ADR-0160 ②, #4692): a subscription held only to be
// COUNTED. These tests read what the rail asks Centrifugo for (the channel, its
// options, when it is joined and left), which is the whole of its contract: it has
// no handler, so there is nothing else to observe.

const mocks = vi.hoisted(() => ({
  subscriptions: [] as Array<{
    name: string;
    options: Record<string, unknown>;
    state: string;
    unsubscribedTimes: number;
  }>,
}));

vi.mock("centrifuge", () => {
  class FakeCentrifuge {
    on(): void {}
    connect(): void {}
    disconnect(): void {}
    getSubscription(): null {
      return null;
    }
    newSubscription(name: string, options: Record<string, unknown>) {
      const record = { name, options, state: "unsubscribed", unsubscribedTimes: 0 };
      mocks.subscriptions.push(record);
      return {
        get state() {
          return record.state;
        },
        on(): void {},
        off(): void {},
        subscribe(): void {
          record.state = "subscribed";
        },
        unsubscribe(): void {
          record.state = "unsubscribed";
          record.unsubscribedTimes += 1;
        },
      };
    }
    removeSubscription(): void {}
  }
  return { Centrifuge: FakeCentrifuge };
});

const WS = "5a3209bf-023b-45f9-bf76-d28f83b16e0b";
const OTHER_WS = "00000000-0000-7000-8000-0000000000aa";

beforeEach(() => {
  mocks.subscriptions = [];
  vi.resetModules();
});

async function handle() {
  const { createRealtime } = await import("./realtime");
  return createRealtime("ws://rollcall.invalid/connection/websocket", () => {});
}

describe("the workspace roll-call rail (#4692)", () => {
  it("joins `online:ws<WORKSPACE>` in the server's upper case, without recovery or positioning", async () => {
    const realtime = await handle();
    realtime.joinOnlineRollCall?.(WS);

    expect(mocks.subscriptions).toHaveLength(1);
    const [rollCall] = mocks.subscriptions;
    expect(rollCall?.name).toBe(`online:ws${WS.toUpperCase()}`);
    expect(rollCall?.state).toBe("subscribed");
    // `history_size: 0` — there is no past to recover, and asking for it would be a flag nobody reads.
    expect(rollCall?.options).toEqual({ recoverable: false, positioned: false });
  });

  it("leaving ends the subscription, and joining again after that subscribes afresh", async () => {
    const realtime = await handle();
    const leave = realtime.joinOnlineRollCall?.(WS);
    leave?.();
    expect(mocks.subscriptions[0]?.state).toBe("unsubscribed");

    realtime.joinOnlineRollCall?.(WS);
    expect(mocks.subscriptions.filter((s) => s.state === "subscribed")).toHaveLength(1);
  });

  it("two joins of one workspace share one subscription and the first leave does not end the other's", async () => {
    const realtime = await handle();
    const leaveFirst = realtime.joinOnlineRollCall?.(WS);
    const leaveSecond = realtime.joinOnlineRollCall?.(WS);
    expect(mocks.subscriptions).toHaveLength(1);

    leaveFirst?.();
    expect(mocks.subscriptions[0]?.state).toBe("subscribed");
    leaveFirst?.(); // a double cleanup must not release someone else's hold
    expect(mocks.subscriptions[0]?.state).toBe("subscribed");

    leaveSecond?.();
    expect(mocks.subscriptions[0]?.state).toBe("unsubscribed");
  });

  it("each workspace has its own roll-call, and none of them is a conversation rail", async () => {
    const realtime = await handle();
    realtime.joinOnlineRollCall?.(WS);
    realtime.joinOnlineRollCall?.(OTHER_WS);
    const names = mocks.subscriptions.map((s) => s.name);
    expect(names).toEqual([
      `online:ws${WS.toUpperCase()}`,
      `online:ws${OTHER_WS.toUpperCase()}`,
    ]);
    for (const name of names) {
      expect(name.split(".")).toHaveLength(1); // no `.<channel>` segment
    }
  });
});

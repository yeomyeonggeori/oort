import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// #5660: 돌아온 순간 소켓을 다시 열지 정하는 사실 하나 — 「소켓이 서버에게서 마지막으로 무언가 들은 시각」. centrifuge-js 는 서버 핑을
// 밖으로 알리지 않아서, `createRealtime`이 centrifuge 에 넘기는 웹소켓이 받은 것마다 시각을 적는다. 이 시험은 그 웹소켓이 실제로
// centrifuge 에 넘어가고(`websocket` 옵션), 받은 것이 있을 때만 시각이 움직이는지 고정한다.

const mocks = vi.hoisted(() => ({ options: null as Record<string, unknown> | null }));

vi.mock("centrifuge", () => {
  class FakeCentrifuge {
    constructor(_url: string, options: Record<string, unknown>) {
      mocks.options = options;
    }
    on(): void {}
    connect(): void {}
    disconnect(): void {}
    getSubscription(): null {
      return null;
    }
    removeSubscription(): void {}
  }
  return { Centrifuge: FakeCentrifuge };
});

/** 브라우저 웹소켓 흉내: 네트워크 없이 `message` 사건만 쏠 수 있다. */
class FakeSocket extends EventTarget {
  static last: FakeSocket | null = null;
  constructor(
    readonly url: string | URL,
    readonly protocols?: string | string[]
  ) {
    super();
    FakeSocket.last = this;
  }
}

beforeEach(() => {
  mocks.options = null;
  FakeSocket.last = null;
  vi.resetModules();
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-11T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("createRealtime 의 「마지막으로 들은 시각」 (#5660)", () => {
  it("받은 것이 없으면 null 이고, 소켓이 무언가 받을 때마다 그 시각이 된다", async () => {
    const { createRealtime } = await import("./realtime");
    const handle = createRealtime("ws://heard.invalid/connection/websocket", () => undefined);
    expect(handle.lastHeardAt?.()).toBeNull();

    const Socket = mocks.options?.websocket as (new (url: string) => EventTarget) | undefined;
    expect(typeof Socket).toBe("function");
    const socket = new Socket!("ws://heard.invalid/connection/websocket");
    expect(socket).toBeInstanceOf(FakeSocket); // 브라우저 웹소켓을 감싼 것이지 새로 만든 전송이 아니다

    expect(handle.lastHeardAt?.()).toBeNull(); // 열기만 해서는 들은 것이 아니다
    vi.setSystemTime(new Date("2026-11-11T12:00:25Z"));
    socket.dispatchEvent(new Event("message")); // 서버 핑
    expect(handle.lastHeardAt?.()).toBe(Date.parse("2026-11-11T12:00:25Z"));

    vi.setSystemTime(new Date("2026-11-11T12:00:50Z"));
    socket.dispatchEvent(new Event("open"));
    expect(handle.lastHeardAt?.()).toBe(Date.parse("2026-11-11T12:00:25Z"));
    socket.dispatchEvent(new Event("message"));
    expect(handle.lastHeardAt?.()).toBe(Date.parse("2026-11-11T12:00:50Z"));
  });

  it("웹소켓이 없는 곳에서는 centrifuge 가 스스로 고르게 둔다(옵션을 넘기지 않는다)", async () => {
    vi.stubGlobal("WebSocket", undefined);
    const { createRealtime } = await import("./realtime");
    const handle = createRealtime("ws://heard.invalid/connection/websocket", () => undefined);
    expect(mocks.options).not.toBeNull();
    expect("websocket" in mocks.options!).toBe(false);
    expect(handle.lastHeardAt?.()).toBeNull();
  });
});

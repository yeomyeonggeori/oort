import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../lib/api";
import {
  VIEWING_BEAT_INTERVAL_MS,
  holdChannelViewing,
  resetViewingBeatForTests,
  type ForegroundPort,
  type ViewingBeatDeps,
} from "./viewingBeat";

function fakeForeground(initial = true) {
  let fg = initial;
  const subs = new Set<(f: boolean) => void>();
  const port: ForegroundPort = {
    isForeground: () => fg,
    subscribe: (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
  };
  return {
    port,
    set(next: boolean) {
      fg = next;
      subs.forEach((cb) => cb(next));
    },
    subscribers: () => subs.size,
  };
}

let send: ReturnType<typeof vi.fn>;
let deps: ViewingBeatDeps;

beforeEach(() => {
  vi.useFakeTimers();
  resetViewingBeatForTests();
  send = vi.fn(async () => {});
  deps = {
    send,
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
    serverKey: () => "https://oort.test",
  };
});
afterEach(() => {
  vi.useRealTimers();
});

const tick = async (ms: number) => {
  await vi.advanceTimersByTimeAsync(ms);
};

describe("viewing beat", () => {
  it("보내는 주기는 15초이고 20초 상한 안이다", async () => {
    expect(VIEWING_BEAT_INTERVAL_MS).toBeLessThanOrEqual(20_000);
    const fg = fakeForeground();
    holdChannelViewing("w", "c", fg.port, deps);
    expect(send).toHaveBeenCalledTimes(1);
    await tick(VIEWING_BEAT_INTERVAL_MS - 1);
    expect(send).toHaveBeenCalledTimes(1);
    await tick(1);
    expect(send).toHaveBeenCalledTimes(2);
    await tick(VIEWING_BEAT_INTERVAL_MS);
    expect(send).toHaveBeenCalledTimes(3);
    expect(send).toHaveBeenCalledWith("w", "c");
  });

  it("앱이 백그라운드로 가면 멈추고 앞으로 돌아오면 바로 한 번 보내고 다시 돈다", async () => {
    const fg = fakeForeground();
    holdChannelViewing("w", "c", fg.port, deps);
    await tick(VIEWING_BEAT_INTERVAL_MS);
    expect(send).toHaveBeenCalledTimes(2);
    fg.set(false);
    await tick(VIEWING_BEAT_INTERVAL_MS * 4);
    expect(send).toHaveBeenCalledTimes(2);
    fg.set(true);
    expect(send).toHaveBeenCalledTimes(3);
    await tick(VIEWING_BEAT_INTERVAL_MS);
    expect(send).toHaveBeenCalledTimes(4);
  });

  it("처음부터 백그라운드이면 보내지 않는다", async () => {
    const fg = fakeForeground(false);
    holdChannelViewing("w", "c", fg.port, deps);
    await tick(VIEWING_BEAT_INTERVAL_MS * 3);
    expect(send).not.toHaveBeenCalled();
  });

  it("화면을 떠나면(해제) 멈추고 구독도 푼다", async () => {
    const fg = fakeForeground();
    const release = holdChannelViewing("w", "c", fg.port, deps);
    release();
    await tick(VIEWING_BEAT_INTERVAL_MS * 3);
    expect(send).toHaveBeenCalledTimes(1);
    expect(fg.subscribers()).toBe(0);
    release();
  });

  it("같은 채널을 두 번 마운트해도 타이머는 하나이고, 둘 다 떠나야 멈춘다", async () => {
    const fg = fakeForeground();
    const a = holdChannelViewing("w", "C", fg.port, deps);
    const b = holdChannelViewing("w", "c", fg.port, deps);
    expect(send).toHaveBeenCalledTimes(1);
    await tick(VIEWING_BEAT_INTERVAL_MS);
    expect(send).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);
    a();
    await tick(VIEWING_BEAT_INTERVAL_MS);
    expect(send).toHaveBeenCalledTimes(3);
    b();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("옛 서버(404·405)면 조용히 멈추고 다시 시도하지 않는다", async () => {
    for (const status of [404, 405]) {
      resetViewingBeatForTests();
      send.mockReset();
      send.mockRejectedValue(new ApiError(status, "nope"));
      const fg = fakeForeground();
      holdChannelViewing("w", "c", fg.port, deps);
      await tick(VIEWING_BEAT_INTERVAL_MS * 4);
      expect(send).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      // 앞뒤 전환이나 다른 채널 마운트도 같은 서버에는 다시 보내지 않는다.
      fg.set(false);
      fg.set(true);
      holdChannelViewing("w", "other", fg.port, deps);
      await tick(VIEWING_BEAT_INTERVAL_MS * 2);
      expect(send).toHaveBeenCalledTimes(1);
      vi.clearAllTimers();
    }
  });

  it("네트워크 실패는 삼키고 다음 주기에 다시 보낸다", async () => {
    send.mockRejectedValueOnce(new TypeError("offline"));
    const fg = fakeForeground();
    holdChannelViewing("w", "c", fg.port, deps);
    await tick(0);
    expect(send).toHaveBeenCalledTimes(1);
    await tick(VIEWING_BEAT_INTERVAL_MS);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("그 밖의 HTTP 오류(403·500)도 멈추지 않고 다음 주기에 다시 보낸다", async () => {
    send.mockRejectedValue(new ApiError(500, "boom"));
    const fg = fakeForeground();
    holdChannelViewing("w", "c", fg.port, deps);
    await tick(VIEWING_BEAT_INTERVAL_MS * 2);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("응답이 끝내 오지 않아도 30초 뒤 주기에는 다시 보낸다", async () => {
    send.mockImplementationOnce(() => new Promise<void>(() => {}));
    const fg = fakeForeground();
    holdChannelViewing("w", "c", fg.port, deps);
    await tick(VIEWING_BEAT_INTERVAL_MS);
    expect(send).toHaveBeenCalledTimes(1);
    await tick(VIEWING_BEAT_INTERVAL_MS);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("응답이 늦으면 겹쳐 보내지 않는다", async () => {
    let resolve: () => void = () => {};
    send.mockImplementationOnce(
      () => new Promise<void>((r) => (resolve = r))
    );
    const fg = fakeForeground();
    holdChannelViewing("w", "c", fg.port, deps);
    await tick(VIEWING_BEAT_INTERVAL_MS);
    expect(send).toHaveBeenCalledTimes(1);
    resolve();
    await tick(VIEWING_BEAT_INTERVAL_MS);
    expect(send).toHaveBeenCalledTimes(2);
  });
});

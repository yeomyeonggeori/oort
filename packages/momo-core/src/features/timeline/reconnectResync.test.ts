import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createReconnectResync, resyncReactionMap, RESYNC_SETTLE_MS } from "./reconnectResync";

// #5885 — 재연결 뒤 다시 읽기의 차례(웹 · 폰이 같이 쓴다). 화면 장면(웹 `useTimeline.reconnectResync.test.tsx`, 폰
// `reconnectResync.test.tsx`)이 「첫 구독 0 · 겹친 재연결 1 · 맞춤」을 지킨다. 여기는 장면이 닿지 않는 두 갈래만:
// 읽는 **중에** 다시 붙으면 끝난 뒤 한 번 더(그 사이의 변경 · 망이 흔들려 실패한 앞 읽기), 그리고 반응 칩의 차례.

describe("createReconnectResync", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("읽는 중에 다시 붙으면 겹쳐 읽지 않고, 끝난 뒤(실패여도) 한 번 더 읽는다", async () => {
    const flights: { resolve: () => void; reject: (e: Error) => void }[] = [];
    const run = vi.fn(
      () =>
        new Promise<void>((resolve, reject) => {
          flights.push({ resolve, reject });
        })
    );
    const resync = createReconnectResync(run);
    resync.reconnected();
    await vi.advanceTimersByTimeAsync(RESYNC_SETTLE_MS);
    expect(run).toHaveBeenCalledTimes(1);

    resync.reconnected();
    resync.reconnected();
    await vi.advanceTimersByTimeAsync(RESYNC_SETTLE_MS * 4);
    expect(run).toHaveBeenCalledTimes(1); // 진행 중에는 겹치지 않는다

    flights[0].reject(new Error("망 끊김"));
    await vi.advanceTimersByTimeAsync(RESYNC_SETTLE_MS);
    expect(run).toHaveBeenCalledTimes(2); // 한 번 더, 한 번만

    flights[1].resolve();
    await vi.advanceTimersByTimeAsync(RESYNC_SETTLE_MS * 4);
    expect(run).toHaveBeenCalledTimes(2);
    resync.dispose();
  });
});

describe("resyncReactionMap", () => {
  it("스냅샷이 이기되, 남은 칩은 지금 차례를 지키고 같으면 같은 객체다", () => {
    const current = { m1: { "👍": ["b", "a"], "🎉": ["a"] } };
    expect(resyncReactionMap(current, { M1: { "🎉": ["A"], "👍": ["A", "B"] } })).toBe(current);
    const next = resyncReactionMap(current, { M1: { "🎉": ["A"], "👍": ["A", "C"] } });
    expect(Object.keys(next.m1)).toEqual(["👍", "🎉"]);
    expect(next.m1["👍"]).toEqual(["a", "c"]);
    expect(next.m1["🎉"]).toBe(current.m1["🎉"]);
  });
});

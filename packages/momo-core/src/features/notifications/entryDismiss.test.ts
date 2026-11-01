import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createEntryDismissBus,
  dismissTemporarySurfaces,
  entryDismissSubscribers,
  onEntryDismiss,
  onEntryHold,
} from "./entryDismiss";

// 알림 입구가 임시 표면을 걷는 방송 (#4667). 폰·웹의 구독 훅과 시트·대화상자 시험은 이 규칙 위에 선다.

describe("createEntryDismissBus", () => {
  it("구독자를 구독한 순서대로 한 번씩 부르고, 푼 구독은 부르지 않는다", () => {
    const bus = createEntryDismissBus();
    const calls: string[] = [];
    bus.subscribe(() => calls.push("a"));
    const stopB = bus.subscribe(() => calls.push("b"));
    bus.subscribe(() => calls.push("c"));
    stopB();
    stopB(); // 두 번 풀어도 안전하다.
    bus.dismiss();
    expect(calls).toEqual(["a", "c"]);
    bus.dismiss();
    expect(calls).toEqual(["a", "c", "a", "c"]);
  });

  it("같은 함수를 두 번 구독하면 구독은 둘이고, 하나를 풀어도 다른 하나는 남는다", () => {
    const bus = createEntryDismissBus();
    const listener = vi.fn();
    const stopFirst = bus.subscribe(listener);
    bus.subscribe(listener);
    expect(bus.size()).toBe(2);
    stopFirst();
    bus.dismiss();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("구독자가 던져도 나머지는 모두 불리고, 던진 것은 다시 던져진다(삼키지 않는다)", () => {
    const rethrown: unknown[] = [];
    const bus = createEntryDismissBus((error) => rethrown.push(error));
    const after = vi.fn();
    const boom = new Error("닫는 길이 깨졌다");
    bus.subscribe(() => {
      throw boom;
    });
    bus.subscribe(after);
    expect(() => bus.dismiss()).not.toThrow();
    expect(after).toHaveBeenCalledTimes(1);
    expect(rethrown).toEqual([boom]);
  });

  it("맡기는 구독자는 구독 순서와 상관없이 닫는 구독자보다 먼저 불린다 — 닫는 길이 시트를 걷기 전에 글을 맡긴다", () => {
    const bus = createEntryDismissBus();
    const calls: string[] = [];
    // 닫는 쪽을 먼저 구독한다(자식 효과가 부모보다 먼저 서는 실제 순서).
    bus.subscribe(() => calls.push("close-1"));
    bus.hold(() => calls.push("hold-1"));
    bus.subscribe(() => calls.push("close-2"));
    bus.hold(() => calls.push("hold-2"));
    bus.dismiss();
    expect(calls).toEqual(["hold-1", "hold-2", "close-1", "close-2"]);
  });

  it("맡기는 구독자가 던져도 닫는 구독자는 모두 불린다", () => {
    const rethrown: unknown[] = [];
    const bus = createEntryDismissBus((error) => rethrown.push(error));
    const close = vi.fn();
    const boom = new Error("맡기기가 깨졌다");
    bus.hold(() => {
      throw boom;
    });
    bus.subscribe(close);
    bus.dismiss();
    expect(close).toHaveBeenCalledTimes(1);
    expect(rethrown).toEqual([boom]);
  });

  it("방송 도중 앞 구독자가 풀어 버린 구독은 부르지 않는다 — 이미 걷힌 표면에 닫으라고 하지 않는다", () => {
    const bus = createEntryDismissBus();
    const later = vi.fn();
    let stopLater = () => {};
    bus.subscribe(() => stopLater());
    stopLater = bus.subscribe(later);
    bus.dismiss();
    expect(later).not.toHaveBeenCalled();
  });

  it("기본 처리는 던진 오류를 다음 틱에 다시 던진다 — 전역 오류 처리기가 본다", () => {
    vi.useFakeTimers();
    try {
      const bus = createEntryDismissBus();
      const boom = new Error("다음 틱");
      bus.subscribe(() => {
        throw boom;
      });
      expect(() => bus.dismiss()).not.toThrow();
      expect(() => vi.runAllTimers()).toThrow(boom);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("앱의 방송 하나", () => {
  const stops: Array<() => void> = [];
  afterEach(() => {
    for (const stop of stops.splice(0)) stop();
  });

  it("`onEntryDismiss` 로 구독한 표면이 `dismissTemporarySurfaces` 한 번에 닫히고, 풀면 더는 닫히지 않는다", () => {
    const before = entryDismissSubscribers();
    const calls: string[] = [];
    const stop = onEntryDismiss(() => calls.push("close"));
    const stopHold = onEntryHold(() => calls.push("hold"));
    stops.push(stop, stopHold);
    expect(entryDismissSubscribers()).toBe(before + 2);
    dismissTemporarySurfaces();
    expect(calls).toEqual(["hold", "close"]);
    stop();
    stopHold();
    expect(entryDismissSubscribers()).toBe(before);
    dismissTemporarySurfaces();
    expect(calls).toEqual(["hold", "close"]);
  });
});

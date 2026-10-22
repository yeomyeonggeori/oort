import { describe, expect, it, vi } from "vitest";
import { createSystemScheme, type MediaLike, type SystemScheme } from "./systemScheme";

// AP-1a(#4186) AC 7: 시스템 스킴은 브라우저에서는 미디어 질의만, 데스크탑에서는 네이티브 창
// 신호까지 듣는다. 두 신호원을 인자로 받는 공장이라 진짜 브라우저·셸 없이 규칙을 잰다.

class FakeMedia implements MediaLike {
  listeners = new Set<(event: { matches: boolean }) => void>();
  constructor(public matches: boolean) {}
  addEventListener(_type: "change", listener: (event: { matches: boolean }) => void): void {
    this.listeners.add(listener);
  }
  removeEventListener(_type: "change", listener: (event: { matches: boolean }) => void): void {
    this.listeners.delete(listener);
  }
  fire(matches: boolean): void {
    this.matches = matches;
    for (const listener of [...this.listeners]) listener({ matches });
  }
}

/** 네이티브 신호원 가짜: 구독마다 핸들러와 해제 함수를 기록한다. */
function fakeNative() {
  const handlers: Array<(scheme: SystemScheme) => void> = [];
  const unlisten = vi.fn();
  const native = vi.fn((handler: (scheme: SystemScheme) => void) => {
    handlers.push(handler);
    return Promise.resolve(unlisten);
  });
  return { native, handlers, unlisten };
}

const flush = () => new Promise<void>((done) => setTimeout(done, 0));

describe("브라우저: 미디어 질의만 듣는다", () => {
  it("아무도 말하지 않았으면 질의를 매번 새로 읽는다", () => {
    const media = new FakeMedia(true);
    const store = createSystemScheme({ media: () => media });
    expect(store.get()).toBe("dark");
    media.matches = false;
    expect(store.get()).toBe("light");
  });

  it("질의가 없는 환경은 라이트다", () => {
    expect(createSystemScheme({ media: () => null }).get()).toBe("light");
  });

  it("change 이벤트가 값을 바꾸고 구독자를 깨운다", () => {
    const media = new FakeMedia(false);
    const store = createSystemScheme({ media: () => media });
    const listener = vi.fn();
    const off = store.subscribe(listener);
    media.fire(true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.get()).toBe("dark");
    media.fire(false);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(store.get()).toBe("light");
    off();
  });

  it("구독을 풀면 질의에서 리스너가 빠진다", () => {
    const media = new FakeMedia(false);
    const store = createSystemScheme({ media: () => media });
    const off = store.subscribe(() => {});
    expect(media.listeners.size).toBe(1);
    off();
    expect(media.listeners.size).toBe(0);
  });

  it("네이티브 신호원이 없으면 아무것도 부르지 않는다 (native를 주지 않았다)", () => {
    const media = new FakeMedia(false);
    const store = createSystemScheme({ media: () => media });
    expect(() => store.subscribe(() => {})()).not.toThrow();
  });
});

describe("네이티브 신호원은 구독하는 순간의 셸 판정을 따른다", () => {
  it("판정이 거짓이면 신호원이 있어도 열지 않는다 (브라우저 탭)", () => {
    const { native } = fakeNative();
    const store = createSystemScheme({ media: () => new FakeMedia(false), native, nativeEnabled: () => false });
    store.subscribe(() => {})();
    expect(native).not.toHaveBeenCalled();
  });

  it("판정은 모듈을 만들 때가 아니라 구독마다 다시 묻는다", () => {
    const { native } = fakeNative();
    let desktop = false;
    const enabled = vi.fn(() => desktop);
    const store = createSystemScheme({ media: () => new FakeMedia(false), native, nativeEnabled: enabled });
    expect(enabled).not.toHaveBeenCalled();
    store.subscribe(() => {})();
    expect(native).not.toHaveBeenCalled();
    desktop = true;
    store.subscribe(() => {})();
    expect(enabled).toHaveBeenCalledTimes(2);
    expect(native).toHaveBeenCalledTimes(1);
  });

  it("판정이 던지면 닫힌 것으로 보고 미디어 질의로 계속 간다", () => {
    const { native } = fakeNative();
    const media = new FakeMedia(false);
    const store = createSystemScheme({
      media: () => media,
      native,
      nativeEnabled: () => {
        throw new Error("[vitest] No isDesktop export is defined on the mock");
      },
    });
    const listener = vi.fn();
    const off = store.subscribe(listener);
    media.fire(true);
    expect(native).not.toHaveBeenCalled();
    expect(listener).toHaveBeenCalledTimes(1);
    off();
  });
});

describe("데스크탑: 네이티브 창 신호도 듣는다", () => {
  it("구독할 때 네이티브 신호원을 한 번 연다", () => {
    const { native } = fakeNative();
    const store = createSystemScheme({ media: () => new FakeMedia(false), native });
    store.subscribe(() => {});
    expect(native).toHaveBeenCalledTimes(1);
  });

  it("네이티브가 말한 값이 미디어 질의가 아직 말하지 않은 값을 이긴다 (WKWebView의 change 누락)", async () => {
    const media = new FakeMedia(false); // 질의는 아직 라이트라고 한다
    const { native, handlers } = fakeNative();
    const store = createSystemScheme({ media: () => media, native });
    const listener = vi.fn();
    store.subscribe(listener);
    await flush();
    handlers[0]("dark");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.get()).toBe("dark");
    expect(media.matches).toBe(false);
  });

  it("마지막으로 말한 쪽이 이긴다: 네이티브 다음에 질의, 그 다음에 다시 네이티브", async () => {
    const media = new FakeMedia(false);
    const { native, handlers } = fakeNative();
    const store = createSystemScheme({ media: () => media, native });
    store.subscribe(() => {});
    await flush();
    handlers[0]("dark");
    expect(store.get()).toBe("dark");
    media.fire(false);
    expect(store.get()).toBe("light");
    handlers[0]("dark");
    expect(store.get()).toBe("dark");
  });

  it("구독을 풀면 네이티브 해제 함수를 부르고 그 뒤의 신호는 무시한다", async () => {
    const { native, handlers, unlisten } = fakeNative();
    const store = createSystemScheme({ media: () => new FakeMedia(false), native });
    const listener = vi.fn();
    const off = store.subscribe(listener);
    await flush();
    off();
    expect(unlisten).toHaveBeenCalledTimes(1);
    handlers[0]("dark");
    expect(listener).not.toHaveBeenCalled();
  });

  it("해제 함수가 구독이 풀린 뒤에 도착해도 곧바로 돌려준다 (새는 리스너가 없다)", async () => {
    const unlisten = vi.fn();
    let resolve!: (value: () => void) => void;
    const native = vi.fn(() => new Promise<() => void>((done) => (resolve = done)));
    const store = createSystemScheme({ media: () => new FakeMedia(false), native });
    const off = store.subscribe(() => {});
    off();
    expect(unlisten).not.toHaveBeenCalled();
    resolve(unlisten);
    await flush();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("네이티브 신호원이 거절하거나 던져도 미디어 질의로 계속 간다", async () => {
    for (const native of [
      vi.fn(() => Promise.reject(new Error("no permission"))),
      vi.fn((): Promise<() => void> => {
        throw new Error("sync failure");
      }),
    ]) {
      const media = new FakeMedia(false);
      const store = createSystemScheme({ media: () => media, native });
      const listener = vi.fn();
      const off = store.subscribe(listener);
      await flush();
      media.fire(true);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(store.get()).toBe("dark");
      off();
    }
  });
});

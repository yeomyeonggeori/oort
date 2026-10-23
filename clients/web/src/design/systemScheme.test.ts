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

describe("구독 공백: 듣는 이가 없는 사이의 변화를 기억이 가리지 않는다 (design-review H-1)", () => {
  it("발화 → 마지막 구독 해제 → 질의 값 변경 → get()은 질의를 새로 읽는다", () => {
    const media = new FakeMedia(false);
    const store = createSystemScheme({ media: () => media });
    const off = store.subscribe(() => {});
    media.fire(true); // 설정 화면이 열려 있는 동안 OS가 다크로
    expect(store.get()).toBe("dark");
    off(); // 화면을 떠난다
    media.matches = false; // 듣는 이가 없는 사이에 OS가 라이트로 돌아온다(이벤트는 아무도 못 듣는다)
    expect(store.get()).toBe("light");
    store.subscribe(() => {})(); // 화면을 다시 연다
    expect(store.get()).toBe("light");
  });

  it("네이티브 발화도 같다: 구독이 풀리면 질의가 다시 진실이다", async () => {
    const media = new FakeMedia(false);
    const { native, handlers } = fakeNative();
    const store = createSystemScheme({ media: () => media, native });
    const off = store.subscribe(() => {});
    await flush();
    handlers[0]("dark");
    expect(store.get()).toBe("dark");
    off();
    expect(store.get()).toBe("light");
  });

  it("구독이 둘이면 마지막 하나가 풀릴 때까지 기억을 쥔다", () => {
    const media = new FakeMedia(false);
    const store = createSystemScheme({ media: () => media });
    const offA = store.subscribe(() => {});
    const offB = store.subscribe(() => {});
    media.fire(true);
    offA();
    media.matches = false; // B가 아직 듣고 있으니 기억을 쥐는 것이 맞다(B는 이 변화도 듣는다)
    expect(store.get()).toBe("dark");
    offB();
    expect(store.get()).toBe("light");
  });

  it("해제를 두 번 불러도 구독 수가 음수로 몰리지 않는다", () => {
    const media = new FakeMedia(false);
    const store = createSystemScheme({ media: () => media });
    const offA = store.subscribe(() => {});
    const offB = store.subscribe(() => {});
    offA();
    offA();
    media.fire(true);
    expect(store.get()).toBe("dark"); // B가 듣고 있다
    offB();
    media.matches = false;
    expect(store.get()).toBe("light"); // 마지막 구독이 풀렸으니 기억은 버려졌다
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

describe("구독이 여럿일 때: 한 신호원의 말은 열려 있는 모든 듣는 이에게 간다 (AP-4 #4191 캡처가 드러낸 결함)", () => {
  // 구독마다 자기 미디어 질의를 갖고, 질의는 만들어진 뒤의 변화만 쏜다. 변화 직후에 열린 구독의 질의는 그 변화를 못 듣는다.
  // 먼저 열려 있던 구독의 질의가 말해 기억이 바뀌어도 나중 구독의 듣는 이가 깨지 않으면 그 구독은 낡은 값에 머문다.
  it("먼저 열린 구독의 질의가 말하면, 변화 뒤에 열려 그 변화를 못 들은 구독의 듣는 이도 깨어난다", () => {
    const first = new FakeMedia(false);
    let current = first;
    const store = createSystemScheme({ media: () => current });
    const earlier = vi.fn();
    const offEarlier = store.subscribe(earlier); // 첫 질의로 연다

    first.fire(true); // OS가 다크가 되었다: 기억은 다크.
    expect(store.get()).toBe("dark");

    // OS가 다시 라이트가 된 직후 새 구독이 열린다. 새 질의는 이미 라이트에서 태어나 그 변화를 쏘지 않는다.
    current = new FakeMedia(false);
    const later = vi.fn();
    const offLater = store.subscribe(later);
    first.matches = false;
    for (const listener of [...first.listeners]) listener({ matches: false }); // 먼저 열린 질의만 말한다

    expect(store.get()).toBe("light");
    expect(earlier).toHaveBeenCalledTimes(2);
    expect(later, "나중 구독의 듣는 이도 깨어난다 (수정 전에는 한 번도 깨지 않았다)").toHaveBeenCalledTimes(1);
    offEarlier();
    offLater();
  });

  it("같은 값을 두 구독의 질의가 되풀이해 말해도 각 듣는 이는 한 번만 깨어난다", () => {
    const shared = new FakeMedia(false);
    const store = createSystemScheme({ media: () => shared });
    const a = vi.fn();
    const b = vi.fn();
    const offA = store.subscribe(a);
    const offB = store.subscribe(b);
    shared.fire(true); // 두 구독의 리스너가 같은 질의에서 차례로 불린다
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    shared.fire(false);
    expect(a).toHaveBeenCalledTimes(2);
    expect(b).toHaveBeenCalledTimes(2);
    offA();
    offB();
  });

  it("해제한 구독의 듣는 이는 더 깨우지 않는다 (남은 구독만 깬다)", () => {
    const media = new FakeMedia(false);
    const store = createSystemScheme({ media: () => media });
    const stay = vi.fn();
    const leave = vi.fn();
    const offStay = store.subscribe(stay);
    const offLeave = store.subscribe(leave);
    offLeave();
    media.fire(true);
    expect(leave).not.toHaveBeenCalled();
    expect(stay).toHaveBeenCalledTimes(1);
    offStay();
  });

  it("네이티브 신호도 열려 있는 모든 듣는 이를 깨운다 (신호를 받은 구독이 하나여도)", async () => {
    const media = new FakeMedia(false);
    const { native, handlers } = fakeNative();
    const store = createSystemScheme({ media: () => media, native });
    const a = vi.fn();
    const offA = store.subscribe(a);
    await flush();
    // 둘째 구독은 네이티브 핸들러를 따로 받지만, 여기서는 첫째 핸들러 하나만 말한다.
    const b = vi.fn();
    const offB = store.subscribe(b);
    await flush();
    handlers[0]?.("dark");
    expect(store.get()).toBe("dark");
    expect(a).toHaveBeenCalledTimes(1);
    expect(b, "네이티브 핸들러를 따로 받은 구독도 같은 말에 깨어난다").toHaveBeenCalledTimes(1);
    offA();
    offB();
  });
});

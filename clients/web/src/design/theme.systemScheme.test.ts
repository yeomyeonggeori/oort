import { afterEach, describe, expect, it, vi } from "vitest";

// AP-1a(#4186) AC 7, 스토어 층: `theme.ts`가 데스크탑에서만 네이티브 신호원을 연결한다.
// 공장의 규칙 자체는 systemScheme.test.ts가, 네이티브 이벤트의 모양은 lib/tauri.systemTheme.test.ts가 잰다.

class FakeMedia {
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

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("@/lib/tauri");
  vi.unstubAllGlobals();
});

async function loadTheme(desktop: boolean) {
  vi.resetModules();
  const native = vi.fn((_handler: (scheme: "light" | "dark") => void) => Promise.resolve(() => {}));
  vi.doMock("@/lib/tauri", () => ({ isDesktop: () => desktop, onSystemThemeChanged: native }));
  const media = new FakeMedia(false);
  vi.stubGlobal("window", { matchMedia: () => media });
  const theme = await import("./theme");
  return { theme, native, media };
}

describe("theme.ts의 시스템 스킴 연결", () => {
  it("브라우저 탭: 미디어 질의만 듣고 네이티브 신호원은 열지 않는다", async () => {
    const { theme, native, media } = await loadTheme(false);
    const listener = vi.fn();
    const off = theme.subscribeSystemScheme(listener);
    expect(native).not.toHaveBeenCalled();
    expect(theme.systemScheme()).toBe("light");
    media.fire(true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(theme.systemScheme()).toBe("dark");
    off();
    expect(media.listeners.size).toBe(0);
  });

  it("`@/lib/tauri`를 통째로 비운 모의에서도 모듈 로드와 구독이 터지지 않는다 (로드 중에 셸 판정을 읽지 않는다)", async () => {
    // 이 스토어는 앱 거의 모든 곳이 가져간다. 로드 중에 `isDesktop()`을 부르면 그것을 부분 모의한
    // 시험(workSurfaceEntryPoints.test.tsx 등)의 모의 초기화 순서에 걸려 스위트가 로드조차 못 한다.
    vi.resetModules();
    vi.doMock("@/lib/tauri", () => ({}));
    const media = new FakeMedia(false);
    vi.stubGlobal("window", { matchMedia: () => media });
    const theme = await import("./theme");
    const listener = vi.fn();
    expect(() => theme.subscribeSystemScheme(listener)()).not.toThrow();
    const off = theme.subscribeSystemScheme(listener);
    media.fire(true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(theme.systemScheme()).toBe("dark");
    off();
  });

  it("데스크탑 셸: 네이티브 신호원도 열고, 그 신호가 값을 바꾼다", async () => {
    const { theme, native, media } = await loadTheme(true);
    const listener = vi.fn();
    theme.subscribeSystemScheme(listener);
    expect(native).toHaveBeenCalledTimes(1);
    // 질의는 아직 라이트인데 네이티브 창이 다크라고 알린다(WKWebView가 change를 안 쏘는 경우).
    native.mock.calls[0][0]("dark");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(theme.systemScheme()).toBe("dark");
    expect(media.matches).toBe(false);
  });
});

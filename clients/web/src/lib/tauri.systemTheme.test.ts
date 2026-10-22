import { afterEach, describe, expect, it, vi } from "vitest";

// AP-1a(#4186) AC 7: `onSystemThemeChanged`는 데스크탑에서만 네이티브 창 이벤트를 열고, 브라우저
// 탭에서는 `@tauri-apps/api/window`를 요청조차 하지 않는다.

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("./env");
  vi.doUnmock("@tauri-apps/api/window");
});

describe("onSystemThemeChanged", () => {
  it("브라우저 탭: 즉시 no-op으로 풀리고 window API 모듈을 요청하지 않는다", async () => {
    vi.resetModules();
    const windowModule = vi.fn(() => ({
      getCurrentWindow: () => {
        throw new Error("a browser tab must not touch the Tauri window API");
      },
    }));
    vi.doMock("@tauri-apps/api/window", windowModule);
    vi.doMock("./env", async (original) => ({ ...(await original<typeof import("./env")>()), IS_TAURI: false }));
    const { onSystemThemeChanged, isDesktop } = await import("./tauri");
    expect(isDesktop()).toBe(false);
    const handler = vi.fn();
    const unlisten = await onSystemThemeChanged(handler);
    expect(typeof unlisten).toBe("function");
    expect(() => unlisten()).not.toThrow();
    expect(windowModule).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it("데스크탑: 현재 창의 theme-changed 이벤트를 듣고 payload를 light·dark로 옮긴다", async () => {
    vi.resetModules();
    const unlistenNative = vi.fn();
    const native: { emit: ((event: { payload: unknown }) => void) | null } = { emit: null };
    const onThemeChanged = vi.fn((listener: (event: { payload: unknown }) => void) => {
      native.emit = listener;
      return Promise.resolve(unlistenNative);
    });
    vi.doMock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ onThemeChanged }) }));
    vi.doMock("./env", async (original) => ({ ...(await original<typeof import("./env")>()), IS_TAURI: true }));
    const { onSystemThemeChanged, isDesktop } = await import("./tauri");
    expect(isDesktop()).toBe(true);

    const handler = vi.fn();
    const unlisten = await onSystemThemeChanged(handler);
    expect(onThemeChanged).toHaveBeenCalledTimes(1);
    native.emit?.({ payload: "dark" });
    native.emit?.({ payload: "light" });
    native.emit?.({ payload: "high-contrast" });
    expect(handler.mock.calls.map((call) => call[0])).toEqual(["dark", "light", "light"]);
    unlisten();
    expect(unlistenNative).toHaveBeenCalledTimes(1);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

// #4591: `watchWindowFullscreen`은 데스크탑에서만 창의 전체 화면 상태를 읽고 크기 변화(전체 화면 진입·해제가 창 크기를
// 바꾼다)마다 다시 읽는다. 브라우저 탭에서는 `@tauri-apps/api/window`를 요청조차 하지 않는다.

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("./env");
  vi.doUnmock("@tauri-apps/api/window");
});

async function loadDesktop(isFullscreen: () => Promise<boolean>) {
  vi.resetModules();
  const resized: { fire: (() => void) | null } = { fire: null };
  const unlistenNative = vi.fn();
  const onResized = vi.fn((listener: () => void) => {
    resized.fire = listener;
    return Promise.resolve(unlistenNative);
  });
  vi.doMock("@tauri-apps/api/window", () => ({
    getCurrentWindow: () => ({ isFullscreen, onResized }),
  }));
  vi.doMock("./env", async (original) => ({ ...(await original<typeof import("./env")>()), IS_TAURI: true }));
  const { watchWindowFullscreen } = await import("./tauri");
  return { watchWindowFullscreen, resized, onResized, unlistenNative };
}

const flush = () => new Promise<void>((done) => setTimeout(done, 0));

describe("watchWindowFullscreen", () => {
  it("브라우저 탭: 즉시 no-op으로 풀리고 window API 모듈을 요청하지 않는다", async () => {
    vi.resetModules();
    const windowModule = vi.fn(() => ({
      getCurrentWindow: () => {
        throw new Error("a browser tab must not touch the Tauri window API");
      },
    }));
    vi.doMock("@tauri-apps/api/window", windowModule);
    vi.doMock("./env", async (original) => ({ ...(await original<typeof import("./env")>()), IS_TAURI: false }));
    const { watchWindowFullscreen } = await import("./tauri");
    const handler = vi.fn();
    const unlisten = await watchWindowFullscreen(handler);
    expect(typeof unlisten).toBe("function");
    expect(() => unlisten()).not.toThrow();
    expect(windowModule).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it("데스크탑: 처음 한 번 현재 상태를 알리고, 창 크기가 바뀔 때마다 다시 읽어 알린다", async () => {
    const states = [false, true, true, false];
    const isFullscreen = vi.fn(() => Promise.resolve(states.shift() ?? false));
    const { watchWindowFullscreen, resized, onResized } = await loadDesktop(isFullscreen);
    const handler = vi.fn();
    await watchWindowFullscreen(handler);
    expect(onResized).toHaveBeenCalledTimes(1);
    // 처음: 전체 화면이 아니다.
    expect(handler.mock.calls.map((call) => call[0])).toEqual([false]);
    for (let i = 0; i < 3; i += 1) {
      resized.fire?.();
      await flush();
    }
    // 크기가 바뀔 때마다 읽은 값을 그대로 알린다(진입, 같은 상태의 또 한 번, 해제).
    expect(handler.mock.calls.map((call) => call[0])).toEqual([false, true, true, false]);
    expect(isFullscreen).toHaveBeenCalledTimes(4);
  });

  it("해제하면 구독을 끊고, 해제 뒤에 끝나는 읽기는 알리지 않는다", async () => {
    let finishRead: (value: boolean) => void = () => {};
    let first = true;
    const isFullscreen = vi.fn(() => {
      if (first) {
        first = false;
        return Promise.resolve(false);
      }
      return new Promise<boolean>((done) => {
        finishRead = done;
      });
    });
    const { watchWindowFullscreen, resized, unlistenNative } = await loadDesktop(isFullscreen);
    const handler = vi.fn();
    const unlisten = await watchWindowFullscreen(handler);
    expect(handler).toHaveBeenCalledTimes(1);
    resized.fire?.(); // 읽는 중에
    unlisten(); // 해제
    expect(unlistenNative).toHaveBeenCalledTimes(1);
    finishRead(true); // 읽기가 해제 뒤에 끝난다
    await flush();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("읽는 동안 온 크기 변화는 한 번으로 합쳐 끝난 뒤 한 번만 다시 읽는다(창 가장자리를 끌 때 IPC가 쌓이지 않는다)", async () => {
    let release: (value: boolean) => void = () => {};
    let calls = 0;
    const isFullscreen = vi.fn(() => {
      calls += 1;
      if (calls === 1) return Promise.resolve(false);
      return new Promise<boolean>((done) => {
        release = done;
      });
    });
    const { watchWindowFullscreen, resized } = await loadDesktop(isFullscreen);
    const handler = vi.fn();
    await watchWindowFullscreen(handler);
    resized.fire?.(); // 읽기 시작(보류)
    resized.fire?.(); // 읽는 동안 온 것 둘은 합쳐진다
    resized.fire?.();
    await flush();
    expect(isFullscreen).toHaveBeenCalledTimes(2);
    release(true); // 첫 읽기가 끝나면 합쳐 둔 한 번이 이어서 읽는다
    await flush();
    expect(isFullscreen).toHaveBeenCalledTimes(3);
    release(false);
    await flush();
    expect(isFullscreen).toHaveBeenCalledTimes(3); // 그 뒤에 쌓인 것은 없다
    expect(handler.mock.calls.map((call) => call[0])).toEqual([false, true, false]);
  });

  it("읽기가 실패하면 마지막 상태를 유지한다: 알리지도, 던지지도 않는다", async () => {
    let calls = 0;
    const isFullscreen = vi.fn(() => {
      calls += 1;
      return calls === 1 ? Promise.resolve(true) : Promise.reject(new Error("window gone"));
    });
    const { watchWindowFullscreen, resized } = await loadDesktop(isFullscreen);
    const handler = vi.fn();
    await watchWindowFullscreen(handler);
    resized.fire?.();
    await flush();
    expect(handler.mock.calls.map((call) => call[0])).toEqual([true]);
  });
});

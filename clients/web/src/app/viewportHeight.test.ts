import { afterEach, describe, expect, it, vi } from "vitest";
import { trackViewportHeight } from "./viewportHeight";

// =============================================================================
// 셸 높이의 근거 (goal B9).
//
// 캡처 게이트는 **그려진 결과**를 잰다(컴포저의 아랫변이 보이는 높이 안인가). 여기서
// 재는 것은 그 앞의 계약이다: 어떤 사건에 다시 재는가, 몇 번 쓰는가, 없는 브라우저에서
// 무엇을 하는가. 셋 다 게이트가 볼 수 없는 것들이고, 셋 다 틀리면 실기기에서만 틀린다.
//
// 테스트 환경은 node라 window가 없다. 그래서 이 파일은 플랫폼을 세워 놓고 부른다 —
// visualViewport는 그 자체가 흉내낼 수 있는 작은 표면이다(height + 세 이벤트).
// =============================================================================

function stubPlatform(initialHeight: number) {
  const listeners = new Map<string, Set<() => void>>();
  const on = (target: string) => (type: string, fn: () => void) => {
    const key = `${target}:${type}`;
    if (!listeners.has(key)) listeners.set(key, new Set());
    listeners.get(key)!.add(fn);
  };
  const off = (target: string) => (type: string, fn: () => void) => {
    listeners.get(`${target}:${type}`)?.delete(fn);
  };

  const properties = new Map<string, string>();
  const viewport = {
    height: initialHeight,
    addEventListener: on("vv"),
    removeEventListener: off("vv"),
  };

  let pending: (() => void) | null = null;
  const win = {
    visualViewport: viewport,
    addEventListener: on("win"),
    removeEventListener: off("win"),
    requestAnimationFrame: (fn: () => void) => {
      pending = fn;
      return 1;
    },
    cancelAnimationFrame: () => {
      pending = null;
    },
  };

  vi.stubGlobal("window", win);
  vi.stubGlobal("document", {
    documentElement: {
      style: {
        setProperty: (name: string, value: string) => properties.set(name, value),
        removeProperty: (name: string) => properties.delete(name),
      },
    },
  });
  vi.stubGlobal("requestAnimationFrame", win.requestAnimationFrame);
  vi.stubGlobal("cancelAnimationFrame", win.cancelAnimationFrame);

  return {
    viewport,
    properties,
    listenerCount: (key: string) => listeners.get(key)?.size ?? 0,
    fire: (key: string) => {
      for (const fn of listeners.get(key) ?? []) fn();
    },
    /** 브라우저가 다음 프레임을 그린다. */
    frame: () => {
      const fn = pending;
      pending = null;
      fn?.();
    },
    hasPendingFrame: () => pending !== null,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("trackViewportHeight", () => {
  it("첫 렌더 전에 이미 답을 갖는다", () => {
    const platform = stubPlatform(744);
    trackViewportHeight();
    // 프레임을 기다리지 않는다: 기다리면 컴포저가 있는 첫 프레임이 844px 셸 안에서
    // 한 번 그려지고, 그 한 프레임이 성재가 본 화면이다.
    expect(platform.properties.get("--app-viewport-height")).toBe("744px");
  });

  it("보이는 높이가 줄면 그만큼 줄어든다 (하단 툴바·키보드)", () => {
    const platform = stubPlatform(844);
    trackViewportHeight();
    expect(platform.properties.get("--app-viewport-height")).toBe("844px");

    platform.viewport.height = 744; // 사파리 하단 툴바
    platform.fire("vv:resize");
    platform.frame();
    expect(platform.properties.get("--app-viewport-height")).toBe("744px");

    platform.viewport.height = 407; // 그 위에 가상 키보드
    platform.fire("vv:resize");
    platform.frame();
    expect(platform.properties.get("--app-viewport-height")).toBe("407px");
  });

  it("툴바가 접히는 동안 오는 scroll에도 다시 잰다", () => {
    const platform = stubPlatform(744);
    trackViewportHeight();

    platform.viewport.height = 844;
    platform.fire("vv:scroll");
    platform.frame();
    expect(platform.properties.get("--app-viewport-height")).toBe("844px");
  });

  it("한 프레임에 한 번만 쓴다", () => {
    const platform = stubPlatform(844);
    trackViewportHeight();

    // 사파리는 툴바가 움직이는 동안 이 사건들을 수십 번 울린다. 매번 커스텀 속성을
    // 쓰면 그 자체가 레이아웃을 그만큼 다시 계산하게 만든다.
    platform.viewport.height = 744;
    platform.fire("vv:resize");
    platform.fire("vv:resize");
    platform.fire("vv:scroll");
    platform.frame();
    expect(platform.properties.get("--app-viewport-height")).toBe("744px");
    expect(platform.hasPendingFrame()).toBe(false);
  });

  it("소수점을 흘리지 않는다", () => {
    const platform = stubPlatform(743.5);
    trackViewportHeight();
    expect(platform.properties.get("--app-viewport-height")).toBe("744px");
  });

  it("해제하면 구독도 값도 남기지 않는다", () => {
    const platform = stubPlatform(744);
    const stop = trackViewportHeight();
    expect(platform.listenerCount("vv:resize")).toBe(1);
    expect(platform.listenerCount("vv:scroll")).toBe(1);
    expect(platform.listenerCount("win:orientationchange")).toBe(1);

    stop();
    expect(platform.listenerCount("vv:resize")).toBe(0);
    expect(platform.listenerCount("vv:scroll")).toBe(0);
    expect(platform.listenerCount("win:orientationchange")).toBe(0);
    // 값이 남으면 tokens.css의 기본값(100dvh)으로 돌아가지 못한다.
    expect(platform.properties.has("--app-viewport-height")).toBe(false);
  });

  it("visualViewport가 없는 브라우저에서는 아무것도 하지 않는다", () => {
    const properties = new Map<string, string>();
    vi.stubGlobal("window", {
      addEventListener: () => {},
      removeEventListener: () => {},
    });
    vi.stubGlobal("document", {
      documentElement: {
        style: {
          setProperty: (name: string, value: string) => properties.set(name, value),
          removeProperty: (name: string) => properties.delete(name),
        },
      },
    });

    // 없는 API를 흉내내는 것보다 이전 답(`100dvh`)으로 남는 편이 낫다.
    expect(() => trackViewportHeight()()).not.toThrow();
    expect(properties.size).toBe(0);
  });
});

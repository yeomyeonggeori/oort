import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

// #4591: 셸이 창의 전체 화면 상태를 루트 표지(`data-window-fullscreen`)로 옮긴다. CSS가 그 표지로 신호등 자리 80px을 접는다.

const watch = vi.hoisted(() => ({
  handler: null as ((fullscreen: boolean) => void) | null,
  unsubscribe: vi.fn(),
  resolveSubscription: null as ((off: () => void) => void) | null,
}));

vi.mock("@/lib/tauri", () => ({
  watchWindowFullscreen: (handler: (fullscreen: boolean) => void) => {
    watch.handler = handler;
    return new Promise<() => void>((resolve) => {
      watch.resolveSubscription = resolve;
    });
  },
}));

import { FULLSCREEN_ATTRIBUTE, installDesktopFullscreenMark } from "./desktopFullscreen";

afterEach(() => {
  watch.handler = null;
  watch.resolveSubscription = null;
  watch.unsubscribe.mockReset();
});

const flush = () => new Promise<void>((done) => setTimeout(done, 0));

/** DOM 없이 표지만 기록하는 루트. 시험이 읽는 것은 속성 하나뿐이다. */
function fakeRoot() {
  const attributes = new Map<string, string>();
  return {
    setAttribute: (name: string, value: string) => void attributes.set(name, value),
    removeAttribute: (name: string) => void attributes.delete(name),
    hasAttribute: (name: string) => attributes.has(name),
  };
}

describe("installDesktopFullscreenMark (#4591)", () => {
  it("전체 화면이면 표지를 찍고, 풀리면 걷는다", () => {
    const root = fakeRoot();
    installDesktopFullscreenMark(root);
    expect(root.hasAttribute(FULLSCREEN_ATTRIBUTE)).toBe(false);
    watch.handler?.(true);
    expect(root.hasAttribute(FULLSCREEN_ATTRIBUTE)).toBe(true);
    watch.handler?.(false);
    expect(root.hasAttribute(FULLSCREEN_ATTRIBUTE)).toBe(false);
  });

  it("표지 이름은 CSS가 읽는 이름과 같다", () => {
    expect(FULLSCREEN_ATTRIBUTE).toBe("data-window-fullscreen");
    const tokens = readFileSync(
      fileURLToPath(new URL("../design/tokens.css", import.meta.url)),
      "utf8"
    );
    expect(tokens).toContain(`:root[${FULLSCREEN_ATTRIBUTE}] {`);
  });

  it("해제하면 구독을 끊고 표지를 걷고, 그 뒤의 알림은 무시한다", async () => {
    const root = fakeRoot();
    const stop = installDesktopFullscreenMark(root);
    watch.resolveSubscription?.(watch.unsubscribe);
    await flush();
    watch.handler?.(true);
    expect(root.hasAttribute(FULLSCREEN_ATTRIBUTE)).toBe(true);
    stop();
    expect(watch.unsubscribe).toHaveBeenCalledTimes(1);
    expect(root.hasAttribute(FULLSCREEN_ATTRIBUTE)).toBe(false);
    watch.handler?.(true); // 해제 뒤에 늦게 온 알림
    expect(root.hasAttribute(FULLSCREEN_ATTRIBUTE)).toBe(false);
  });

  it("구독이 끝나기 전에 해제하면, 도착한 구독을 즉시 끊는다(새는 리스너가 없다)", async () => {
    const root = fakeRoot();
    const stop = installDesktopFullscreenMark(root);
    stop();
    expect(watch.unsubscribe).not.toHaveBeenCalled();
    watch.resolveSubscription?.(watch.unsubscribe);
    await flush();
    expect(watch.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("main.tsx가 데스크탑 셸에서만 설치한다", () => {
    const main = readFileSync(fileURLToPath(new URL("../main.tsx", import.meta.url)), "utf8");
    expect(main).toMatch(/if \(IS_TAURI\) installDesktopFullscreenMark\(\);/);
    expect(main).toContain('from "@/lib/desktopFullscreen"');
  });
});

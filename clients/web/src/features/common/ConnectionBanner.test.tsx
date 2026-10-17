// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import type { RealtimeHandle, RealtimeStatus } from "@/lib/realtime";
import {
  RETRY_WINDOW_MS,
  SUSTAINED_DOWN_MS,
} from "@momo/core/features/common/connectionAlert";
import { ConnectionBanner } from "./ConnectionBanner";

/**
 * 연결 배너의 오르트 로더 (#3961). 어느 연결 상태에서 로더가 도는지, 어느 상태에서
 * 같은 마크가 멈춰 서는지를 잠근다. 이 배너는 지금까지 전용 시험이 없었다.
 *
 * 규칙은 한 줄이다: 지금 실제로 다시 연결을 시도하는 동안만 돈다.
 *   never-connected · dropped            도는 중 (centrifuge 재연결 루프)
 *   다시 연결을 누른 뒤 retry running     계속 돈다
 *   retry failed (「다시 연결하지 못했습니다」) 멈춘다: 문장이 실패를 말하는데 마크가 진행을 말하면 거짓이다
 *   browser-offline                      멈춘다: 브라우저가 망이 없다고 했고, 다시 연결 버튼도 없다
 *
 * red proof (이 파일이 지키는 것):
 *   - `reconnecting` 에서 `retry !== "failed"` 를 지우면 → 「실패 뒤에는 멈춘다」가 붉다
 *   - `reconnecting` 에서 browser-offline 제외를 지우면 → 「브라우저 오프라인은 멈춘다」가 붉다
 *   - 아이콘을 다시 PlugZap 으로 → 「로더 노출」 단정들과 「신호 하나」가 붉다
 */

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

let root: Root | null = null;
let host: HTMLElement | null = null;
const reconnect = vi.fn();

function stubReducedMotion(reduced: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: reduced,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
}

function mount(connStatus: RealtimeStatus, { realtime = true } = {}): HTMLElement {
  const value = {
    session: {},
    workspaceId: "w",
    realtime: realtime ? ({ reconnect } as unknown as RealtimeHandle) : null,
    connStatus,
    logout: () => undefined,
    replaceSessionMember: () => undefined,
  } as unknown as SessionContextValue;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <SessionProvider value={value}>
        <ConnectionBanner />
      </SessionProvider>
    );
  });
  return host;
}

const banner = () => document.querySelector<HTMLElement>('[data-testid="connection-banner"]');
const loader = () => document.querySelector<HTMLElement>("[data-oort-loader]");
const press = () => {
  const button = [...document.querySelectorAll("button")].find((b) => b.textContent === "다시 연결");
  expect(button, "다시 연결 버튼").toBeDefined();
  act(() => button!.click());
};
const advance = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

beforeEach(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  stubReducedMotion(false);
  reconnect.mockReset();
  Object.defineProperty(window.navigator, "onLine", { configurable: true, value: true });
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  host?.remove();
  root = null;
  host = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("배너가 서는 때", () => {
  it("연결돼 있으면 배너도 로더도 없다", () => {
    mount("connected");
    advance(SUSTAINED_DOWN_MS * 2);
    expect(banner()).toBeNull();
    expect(loader()).toBeNull();
  });

  it("레일이 15초 안 올라오면 배너가 서고 로더가 돈다 (never-connected)", () => {
    mount("connecting");
    advance(SUSTAINED_DOWN_MS - 1);
    expect(banner()).toBeNull();
    advance(1);
    expect(banner()).not.toBeNull();
    expect(banner()!.textContent).toContain("실시간 연결을 아직 맺지 못했습니다");
    expect(loader()).not.toBeNull();
    expect(loader()!.dataset.motion).toBe("full");
    expect(loader()!.dataset.oortLoader).toBe("mark");
  });

  it("연결이 끊긴 레일도 15초 뒤 로더가 돈다 (dropped)", () => {
    mount("disconnected");
    advance(SUSTAINED_DOWN_MS);
    expect(banner()!.textContent).toContain("실시간 연결이 끊겼습니다");
    expect(loader()!.dataset.motion).toBe("full");
  });
});

describe("로더가 곧 신호다 (신호 하나)", () => {
  it("로더는 배너의 아이콘 자리 안에 있고 장식이다", () => {
    mount("connecting");
    advance(SUSTAINED_DOWN_MS);
    const icon = loader()!.parentElement!;
    expect(icon.getAttribute("aria-hidden")).toBe("true");
    expect(banner()!.contains(icon)).toBe(true);
  });

  it("옛 플러그 아이콘은 없다: 아이콘 자리에 신호가 둘이 아니다", () => {
    mount("connecting");
    advance(SUSTAINED_DOWN_MS);
    expect(banner()!.querySelector("svg.lucide-plug-zap")).toBeNull();
    // 배너 안의 SVG 는 로더의 링 하나뿐이다.
    expect(banner()!.querySelectorAll("svg")).toHaveLength(1);
    expect(banner()!.querySelector("svg.oort-loader-ring")).not.toBeNull();
  });

  it("문장은 그대로다: 로더는 곁들일 뿐 문구를 바꾸지 않는다", () => {
    mount("connecting");
    advance(SUSTAINED_DOWN_MS);
    expect(banner()!.textContent).toContain(
      "실시간 연결을 아직 맺지 못했습니다. 새 메시지는 채널을 다시 열어야 도착합니다."
    );
  });
});

describe("다시 연결", () => {
  it("누르면 재연결을 부르고 버튼이 「연결 중」이 되며 로더는 계속 돈다", () => {
    mount("connecting");
    advance(SUSTAINED_DOWN_MS);
    press();
    expect(reconnect).toHaveBeenCalledTimes(1);
    const button = banner()!.querySelector("button")!;
    expect(button.textContent).toBe("연결 중");
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(loader()!.dataset.motion).toBe("full");
  });

  it("6초 안에 안 붙으면 문장이 실패를 말하고, 그때 같은 마크가 멈춰 선다", () => {
    mount("connecting");
    advance(SUSTAINED_DOWN_MS);
    press();
    advance(RETRY_WINDOW_MS - 1);
    expect(loader()!.dataset.motion).toBe("full");
    advance(1);
    expect(banner()!.textContent).toContain("다시 연결하지 못했습니다");
    expect(loader()!.dataset.motion).toBe("still");
    // 멈춘 마크는 같은 마크다(자리가 바뀌거나 사라지지 않는다).
    expect(loader()!.dataset.oortLoader).toBe("mark");
  });

  it("실패 뒤 다시 누르면 다시 돈다", () => {
    mount("connecting");
    advance(SUSTAINED_DOWN_MS);
    press();
    advance(RETRY_WINDOW_MS);
    expect(loader()!.dataset.motion).toBe("still");
    press();
    expect(loader()!.dataset.motion).toBe("full");
    expect(reconnect).toHaveBeenCalledTimes(2);
  });
});

describe("브라우저 오프라인", () => {
  it("대기 없이 배너가 서고, 로더는 멈춰 있으며, 다시 연결 버튼이 없다", () => {
    Object.defineProperty(window.navigator, "onLine", { configurable: true, value: false });
    mount("connecting");
    expect(banner()).not.toBeNull();
    expect(banner()!.textContent).toContain("네트워크가 끊겼습니다");
    expect(loader()!.dataset.motion).toBe("still");
    expect(banner()!.querySelector("button")).toBeNull();
  });

  it("오프라인 이벤트가 오면 그 순간 멈춘 마크로 선다", () => {
    mount("connected");
    expect(banner()).toBeNull();
    act(() => {
      Object.defineProperty(window.navigator, "onLine", { configurable: true, value: false });
      window.dispatchEvent(new Event("offline"));
    });
    expect(loader()!.dataset.motion).toBe("still");
  });
});

describe("동작 줄이기", () => {
  it("OS 설정이 켜져 있으면 도는 상태도 reduced 로 선다", () => {
    stubReducedMotion(true);
    mount("connecting");
    advance(SUSTAINED_DOWN_MS);
    expect(loader()!.dataset.motion).toBe("reduced");
  });
});

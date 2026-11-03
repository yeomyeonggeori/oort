// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import type { RealtimeHandle, RealtimeStatus } from "@/lib/realtime";
import { ConnectionBanner } from "./ConnectionBanner";
import { ConnectionProvider } from "./connectionModel";

/**
 * 위쪽 연결 띠 (#5220, #5201 S-B). 이 띠는 연결 카드가 설 자리가 없는 폭(서랍·접힌 목록 열)에서만 서고
 * (그 가름은 `showsConnectionBanner`, 코어 `screenState.test.ts`가 카드와 서로의 여집합임을 잰다), 서면
 * 카드와 **같은 판정**(`presentConnection`)을 그린다. 여기서는 띠 자체가 그리는 것을 잰다.
 *
 * 로더는 오르트 로더(#3961)이고 규칙은 한 줄이다: 지금 실제로 다시 붙이는 동안만 돈다.
 *   연결 중 · 실시간만 끊김 · 서버에 닿지 못함   도는 중(자동으로 다시 시도한다)
 *   기기 오프라인                                  멈춘다(진행 중인 것이 없고 단추도 없다)
 *   방금 돌아옴                                    확인 표시(로더가 아니다)
 * 옛 띠가 갖던 「누른 뒤 6초 안에 못 붙으면 다시 연결하지 못했습니다」 상태는 없다: 누르면 모델이 「연결 중」으로
 * 이어 새 10초를 세고, 그래도 안 붙으면 다시 「끊김」이 선다.
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

function session(connStatus: RealtimeStatus): SessionContextValue {
  return {
    session: {},
    workspaceId: "w",
    realtime: { reconnect } as unknown as RealtimeHandle,
    connStatus,
    logout: () => undefined,
    replaceSessionMember: () => undefined,
  } as unknown as SessionContextValue;
}

function render(connStatus: RealtimeStatus) {
  act(() => {
    root!.render(
      <SessionProvider value={session(connStatus)}>
        <ConnectionProvider>
          <ConnectionBanner />
        </ConnectionProvider>
      </SessionProvider>
    );
  });
}

const banner = () => document.querySelector<HTMLElement>('[data-testid="connection-banner"]');
const region = () => banner()?.parentElement ?? null;
const loader = () => document.querySelector<HTMLElement>("[data-oort-loader]");
const action = () => [...document.querySelectorAll("button")].find((b) => b.closest('[data-testid="connection-banner"]'));
const advance = (ms: number) => act(() => void vi.advanceTimersByTime(ms));
const setOnLine = (online: boolean) =>
  Object.defineProperty(window.navigator, "onLine", { configurable: true, value: online });

/** 오래 붙어 있던 건강한 소켓에서 시작한다. */
function mountHealthy() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  render("connected");
  advance(60_000);
  expect(banner()).toBeNull();
}

beforeEach(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-03T04:00:00Z"));
  stubReducedMotion(false);
  reconnect.mockReset();
  setOnLine(true);
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  host?.remove();
  root = null;
  host = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("띠가 서는 때", () => {
  it("연결돼 있으면 띠도 로더도 없다", () => {
    mountHealthy();
    advance(60_000);
    expect(banner()).toBeNull();
    expect(loader()).toBeNull();
  });

  it("소켓이 끊기면 1초는 침묵, 1초부터 「연결 중」(로더, 단추 없음), 10초부터 「끊김」(단추 있음)", () => {
    mountHealthy();
    render("disconnected");
    advance(999);
    expect(banner()).toBeNull();
    advance(1);
    expect(region()!.dataset.tone).toBe("connecting");
    expect(loader()!.dataset.motion).toBe("full");
    expect(action()).toBeUndefined();
    advance(9_000);
    expect(region()!.dataset.tone).toBe("down");
    expect(action()).toBeDefined();
    expect(loader()!.dataset.motion).toBe("full");
  });
});

describe("로더가 곧 신호다 (신호 하나)", () => {
  it("로더는 띠의 아이콘 자리 안에 있고 장식이다", () => {
    mountHealthy();
    render("disconnected");
    advance(10_000);
    const icon = loader()!.closest('[aria-hidden="true"]');
    expect(icon).not.toBeNull();
    expect(banner()!.contains(icon)).toBe(true);
    expect(loader()!.dataset.oortLoader).toBe("mark");
  });

  it("기기 오프라인은 같은 마크가 멈춰 선다(단추도 없다)", () => {
    mountHealthy();
    act(() => {
      setOnLine(false);
      window.dispatchEvent(new Event("offline"));
    });
    expect(region()!.dataset.tone).toBe("offline");
    expect(loader()!.dataset.motion).toBe("still");
    expect(action()).toBeUndefined();
  });

  it("동작 줄이기에서도 도는 자리는 도는 자리다: 회전 대신 숨(reduced)", () => {
    stubReducedMotion(true);
    mountHealthy();
    render("disconnected");
    advance(10_000);
    expect(loader()!.dataset.motion).toBe("reduced");
  });

  it("방금 돌아오면 로더가 아니라 확인 표시가 2초 선다", () => {
    mountHealthy();
    render("disconnected");
    advance(10_000);
    render("connected");
    expect(region()!.dataset.tone).toBe("recovered");
    expect(loader()).toBeNull();
    expect(banner()!.querySelector('[data-connection-mark="check"]')).not.toBeNull();
    advance(2_000);
    expect(banner()).toBeNull();
  });
});

describe("「지금 다시 연결」", () => {
  it("누르면 소켓을 다시 열고 띠는 「연결 중」으로 이어지며 초점은 띠가 받는다", () => {
    mountHealthy();
    render("disconnected");
    advance(10_000);
    act(() => action()!.click());
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(region()!.dataset.tone).toBe("connecting");
    expect(action()).toBeUndefined();
    expect(document.activeElement).toBe(region());
  });
});

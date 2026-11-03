// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import type { RealtimeStatus } from "@/lib/realtime";
import { useOffline } from "./useOffline";

/**
 * `useOffline()`은 「지금 쓰기(보내기·올리기·승인)를 막아야 하나」의 한 곳이다(#5220, #5201 결정 ③).
 *
 * 쓰기는 REST이고 소켓은 수신용이라, 실시간(소켓)만 끊겼다고 막지 않는다. 막는 것은 기기 오프라인과
 * 서버에 닿지 못함이 **확정**일 때뿐이다. 이 파일의 첫 판은 옛 정의(`connStatus === "disconnected"`이면
 * 오프라인)에서 단정으로 붉었다.
 */

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

let root: Root | null = null;
let host: HTMLElement | null = null;

function Probe() {
  return <span data-testid="offline">{String(useOffline())}</span>;
}

function sessionValue(connStatus: RealtimeStatus): SessionContextValue {
  return {
    session: {},
    workspaceId: "w",
    realtime: null,
    connStatus,
    logout: () => undefined,
    replaceSessionMember: () => undefined,
  } as unknown as SessionContextValue;
}

function mount(connStatus: RealtimeStatus) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <SessionProvider value={sessionValue(connStatus)}>
        <Probe />
      </SessionProvider>
    );
  });
}

const offline = () => document.querySelector('[data-testid="offline"]')!.textContent;

beforeEach(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
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
});

describe("useOffline: 실시간만 끊김은 쓰기를 막지 않는다 (결정 ③)", () => {
  it("소켓이 disconnected여도 기기·서버가 멀쩡하면 오프라인이 아니다", () => {
    mount("disconnected");
    expect(offline()).toBe("false");
    act(() => void vi.advanceTimersByTime(11_000));
    expect(offline()).toBe("false");
  });

  it("소켓이 아직 connecting이어도 오프라인이 아니다", () => {
    mount("connecting");
    act(() => void vi.advanceTimersByTime(11_000));
    expect(offline()).toBe("false");
  });
});

describe("useOffline: 기기가 오프라인이면 막는다", () => {
  it("브라우저가 오프라인이라고 하면 즉시 막힌다", () => {
    Object.defineProperty(window.navigator, "onLine", { configurable: true, value: false });
    mount("connected");
    expect(offline()).toBe("true");
  });
});

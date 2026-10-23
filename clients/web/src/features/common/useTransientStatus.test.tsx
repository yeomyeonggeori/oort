// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TRANSIENT_STATUS_HOLD_MS, useTransientStatus } from "./useTransientStatus";

// =============================================================================
// 3초 상태줄의 문장 (ADR-0182 ②, 예약 UI 명세 0.3). 팔레트(`usePaletteStatus`)와 입력창·목록이 같은 타이머를 쓴다.
// =============================================================================

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let mountedRoot: Root | null = null;
let host: HTMLElement | null = null;
let api: ReturnType<typeof useTransientStatus> | null = null;

function Probe() {
  api = useTransientStatus();
  return null;
}
const state = () => {
  if (api === null) throw new Error("not mounted");
  return api;
};

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement("div");
  document.body.append(host);
  mountedRoot = createRoot(host);
  act(() => mountedRoot?.render(createElement(Probe)));
});
afterEach(() => {
  if (mountedRoot) act(() => mountedRoot?.unmount());
  mountedRoot = null;
  host?.remove();
  host = null;
  api = null;
  vi.useRealTimers();
});

describe("useTransientStatus", () => {
  it("문장을 3초 동안만 쥐고 비운다", () => {
    expect(TRANSIENT_STATUS_HOLD_MS).toBe(3_000);
    expect(state().status).toBeNull();
    act(() => state().announce("내일 오전 9:00에 보낼게요"));
    expect(state().status).toBe("내일 오전 9:00에 보낼게요");
    act(() => vi.advanceTimersByTime(2_999));
    expect(state().status).toBe("내일 오전 9:00에 보낼게요");
    act(() => vi.advanceTimersByTime(1));
    expect(state().status).toBeNull();
  });

  it("3초 안에 다시 말하면 문장이 바뀌고 3초가 처음부터다", () => {
    act(() => state().announce("첫 문장"));
    act(() => vi.advanceTimersByTime(2_000));
    act(() => state().announce("둘째 문장"));
    act(() => vi.advanceTimersByTime(2_000));
    expect(state().status).toBe("둘째 문장");
    act(() => vi.advanceTimersByTime(1_000));
    expect(state().status).toBeNull();
  });

  it("announce(null)과 clear()는 즉시 비우고 타이머도 멈춘다", () => {
    act(() => state().announce("문장"));
    act(() => state().clear());
    expect(state().status).toBeNull();
    act(() => state().announce("다른 문장"));
    act(() => state().announce(null));
    expect(state().status).toBeNull();
    // 멈춘 타이머가 뒤늦게 새 문장을 지우지 않는다.
    act(() => state().announce("새 문장"));
    act(() => vi.advanceTimersByTime(2_999));
    expect(state().status).toBe("새 문장");
  });

  it("언마운트하면 타이머도 끝난다(떨어진 뒤에 상태를 바꾸지 않는다)", () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => undefined);
    act(() => state().announce("문장"));
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
    expect(vi.getTimerCount()).toBe(0);
    act(() => vi.advanceTimersByTime(5_000));
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

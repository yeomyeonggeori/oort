// @vitest-environment jsdom
// #4063 (ADR-0204 증보 3): 웹·데스크탑 「보고 있음」 신호의 배선. 주기·옛 서버 규칙
// 본체는 core(viewingBeat.test.ts)가 재고, 여기서는 탭 가시성·포커스와 마운트 해제를 잰다.
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const send = vi.hoisted(() => vi.fn());
vi.mock("@momo/core/lib/api", async (orig) => ({
  ...(await orig<typeof import("@momo/core/lib/api")>()),
  touchChannelViewing: send,
}));

const desktop = vi.hoisted(() => ({ on: false }));
vi.mock("@/lib/tauri", async (orig) => ({
  ...(await orig<typeof import("@/lib/tauri")>()),
  isDesktop: () => desktop.on,
}));

import { resetViewingBeatForTests } from "@momo/core/features/readState/viewingBeat";
import { useChannelViewingBeat, useDocumentForeground } from "./useChannelViewingBeat";

let visibility: "visible" | "hidden" = "visible";
let focused = true;

beforeEach(() => {
  vi.useFakeTimers();
  resetViewingBeatForTests();
  send.mockReset();
  send.mockResolvedValue(undefined);
  visibility = "visible";
  focused = true;
  desktop.on = false;
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useChannelViewingBeat", () => {
  it("탭이 가려지면 멈추고 다시 보이면 바로 보낸다", async () => {
    renderHook(() => useChannelViewingBeat("w", "c"));
    expect(send).toHaveBeenCalledTimes(1);
    visibility = "hidden";
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    await act(async () => void (await vi.advanceTimersByTimeAsync(60_000)));
    expect(send).toHaveBeenCalledTimes(1);
    visibility = "visible";
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("창이 포커스를 잃으면 멈추고 되찾으면 다시 보낸다", async () => {
    renderHook(() => useChannelViewingBeat("w", "c"));
    focused = false;
    act(() => void window.dispatchEvent(new Event("blur")));
    await act(async () => void (await vi.advanceTimersByTimeAsync(60_000)));
    expect(send).toHaveBeenCalledTimes(1);
    focused = true;
    act(() => void window.dispatchEvent(new Event("focus")));
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("채널 화면을 떠나면 멈추고, 채널이 null이면 보내지 않는다", async () => {
    const { unmount } = renderHook(() => useChannelViewingBeat("w", "c"));
    unmount();
    await act(async () => void (await vi.advanceTimersByTimeAsync(60_000)));
    expect(send).toHaveBeenCalledTimes(1);
    renderHook(() => useChannelViewingBeat("w", null));
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("같은 채널이 두 번 마운트돼도 타이머는 하나다", async () => {
    renderHook(() => useChannelViewingBeat("w", "c"));
    renderHook(() => useChannelViewingBeat("w", "c"));
    expect(send).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    await act(async () => void (await vi.advanceTimersByTimeAsync(15_000)));
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("데스크탑은 hasFocus()가 false여도 처음부터 보낸다(이벤트로만 추적)", async () => {
    desktop.on = true;
    focused = false;
    renderHook(() => useChannelViewingBeat("w", "c"));
    expect(send).toHaveBeenCalledTimes(1);
    act(() => void window.dispatchEvent(new Event("blur")));
    await act(async () => void (await vi.advanceTimersByTimeAsync(60_000)));
    expect(send).toHaveBeenCalledTimes(1);
    act(() => void window.dispatchEvent(new Event("focus")));
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe("useDocumentForeground (#5032)", () => {
  it("스레드가 열려 있을 때만(enabled) 창 앞뒤를 따라간다 — 꺼 두면 구독이 없고 늘 앞이다", () => {
    const windowAdd = vi.spyOn(window, "addEventListener");
    const documentAdd = vi.spyOn(document, "addEventListener");
    const listened = () => [...windowAdd.mock.calls, ...documentAdd.mock.calls].map(([name]) => name);
    const { result, rerender } = renderHook(({ on }) => useDocumentForeground(on), { initialProps: { on: false } });
    expect(listened()).not.toContain("blur");
    expect(listened()).not.toContain("focus");
    expect(listened()).not.toContain("visibilitychange");
    expect(result.current).toBe(true);
    // 창이 이미 뒤에 있는 채 켜면(알림에서 스레드가 열린다) 켜는 순간의 값으로 시작한다.
    focused = false;
    rerender({ on: true });
    expect(listened()).toContain("blur");
    expect(result.current).toBe(false);
    focused = true;
    act(() => void window.dispatchEvent(new Event("focus")));
    expect(result.current).toBe(true);
    // 끄면 구독을 풀고 늘 앞이다.
    focused = false;
    act(() => void window.dispatchEvent(new Event("blur")));
    expect(result.current).toBe(false);
    rerender({ on: false });
    expect(result.current).toBe(true);
  });
});

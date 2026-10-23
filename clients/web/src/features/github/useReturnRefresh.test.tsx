// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useReturnRefresh } from "./useReturnRefresh";

// 브라우저에 일을 맡기고 돌아온 데스크탑 창이 앞으로 오면 한 번 다시 읽는다(#4220).

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Harness({ active, onReturn }: { active: boolean; onReturn: () => void }) {
  useReturnRefresh(active, onReturn);
  return null;
}

let root: Root | null = null;
let host: HTMLElement | null = null;
let visibility: DocumentVisibilityState = "visible";

function render(active: boolean, onReturn: () => void) {
  if (!host) {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  }
  act(() => root?.render(createElement(Harness, { active, onReturn })));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-22T09:00:00Z"));
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
});
afterEach(() => {
  if (root) act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.useRealTimers();
  Reflect.deleteProperty(document, "visibilityState");
});

const focus = () => act(() => void window.dispatchEvent(new Event("focus")));
const visible = () => act(() => void document.dispatchEvent(new Event("visibilitychange")));

describe("useReturnRefresh", () => {
  it("켜지 않으면 리스너가 없다", () => {
    const onReturn = vi.fn();
    render(false, onReturn);
    focus();
    visible();
    expect(onReturn).not.toHaveBeenCalled();
  });

  it("켜면 창 포커스가 돌아올 때 부른다", () => {
    const onReturn = vi.fn();
    render(true, onReturn);
    focus();
    expect(onReturn).toHaveBeenCalledTimes(1);
  });

  it("보임으로 돌아온 신호도 부르고, 숨음은 부르지 않는다", () => {
    const onReturn = vi.fn();
    render(true, onReturn);
    visibility = "hidden";
    visible();
    expect(onReturn).not.toHaveBeenCalled();
    visibility = "visible";
    visible();
    expect(onReturn).toHaveBeenCalledTimes(1);
  });

  it("창이 앞으로 올 때 연달아 오는 신호는 한 번으로 센다", () => {
    const onReturn = vi.fn();
    render(true, onReturn);
    focus();
    visible();
    focus();
    expect(onReturn).toHaveBeenCalledTimes(1);
    act(() => void vi.advanceTimersByTime(800));
    focus();
    expect(onReturn).toHaveBeenCalledTimes(2);
  });

  it("끄거나 내리면 리스너를 걷는다", () => {
    const onReturn = vi.fn();
    render(true, onReturn);
    render(false, onReturn);
    act(() => void vi.advanceTimersByTime(800));
    focus();
    expect(onReturn).not.toHaveBeenCalled();
    render(true, onReturn);
    act(() => root?.unmount());
    root = null;
    act(() => void vi.advanceTimersByTime(800));
    focus();
    expect(onReturn).not.toHaveBeenCalled();
  });

  it("다시 그려 바뀐 콜백을 쓴다", () => {
    const first = vi.fn();
    const second = vi.fn();
    render(true, first);
    render(true, second);
    focus();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});

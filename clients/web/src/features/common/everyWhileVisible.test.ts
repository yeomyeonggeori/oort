// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { everyWhileVisible } from "./everyWhileVisible";

let visibility: "visible" | "hidden" = "visible";
const setVisibility = (next: "visible" | "hidden") => {
  visibility = next;
  document.dispatchEvent(new Event("visibilitychange"));
};

beforeEach(() => {
  vi.useFakeTimers();
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
});

afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
});

describe("everyWhileVisible (#5660: 숨은 창에서 돌 필요 없는 주기 읽기)", () => {
  it("보이는 동안은 30초마다 부른다", () => {
    const run = vi.fn();
    const stop = everyWhileVisible(run, 30_000);
    vi.advanceTimersByTime(90_000);
    expect(run).toHaveBeenCalledTimes(3);
    stop();
  });

  it("숨은 10분 동안은 한 번도 부르지 않고, 다시 보이는 순간 한 번 부른 뒤 주기로 돌아간다", () => {
    const run = vi.fn();
    const stop = everyWhileVisible(run, 30_000);
    setVisibility("hidden");
    vi.advanceTimersByTime(600_000);
    expect(run).not.toHaveBeenCalled();
    setVisibility("visible");
    expect(run).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(30_000);
    expect(run).toHaveBeenCalledTimes(2);
    stop();
  });

  it("건너뛴 차례가 없으면 다시 보여도 따로 부르지 않는다(잠깐 숨었다 돌아옴)", () => {
    const run = vi.fn();
    const stop = everyWhileVisible(run, 30_000);
    setVisibility("hidden");
    vi.advanceTimersByTime(10_000);
    setVisibility("visible");
    expect(run).not.toHaveBeenCalled();
    stop();
  });

  it("멈춘 뒤에는 시계도 보임 사건도 부르지 않는다", () => {
    const run = vi.fn();
    const stop = everyWhileVisible(run, 30_000);
    setVisibility("hidden");
    vi.advanceTimersByTime(30_000);
    stop();
    setVisibility("visible");
    vi.advanceTimersByTime(90_000);
    expect(run).not.toHaveBeenCalled();
  });
});

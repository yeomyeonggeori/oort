// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitReadCommand, GitReadResult } from "@momo/core/features/workbench/gitRead";
import { PANE_GIT_REFRESH_MS, usePaneGit } from "./usePaneGit";

// 로컬 칸의 git 주기 읽기는 창이 보이는 동안만 돈다 (#5660: 데스크탑 웹뷰는 창을 치운 뒤에도 돈다). 다시 보이면 한 번 읽는다.

const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root | null = null;
let host: HTMLElement | null = null;
let visibility: "visible" | "hidden" = "visible";
const calls: string[] = [];
const read = (command: GitReadCommand, pty: number): Promise<GitReadResult> => {
  calls.push(`${command}:${pty}`);
  return Promise.resolve({ outcome: "noUpstream" } as GitReadResult);
};
const PANES = [["p1", 1]] as const;

function Probe() {
  usePaneGit(PANES, { read });
  return null;
}

async function settle(ms = 0) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  });
}

function setVisibility(next: "visible" | "hidden") {
  visibility = next;
  act(() => void document.dispatchEvent(new Event("visibilitychange")));
}

beforeAll(() => {
  env.IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  vi.useFakeTimers();
  calls.length = 0;
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.useRealTimers();
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
});

describe("usePaneGit 주기 읽기 (#5660)", () => {
  it("숨은 동안은 칸의 git 을 다시 읽지 않고, 다시 보이면 한 번 읽는다", async () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root?.render(createElement(Probe)));
    await settle();
    const first = calls.length;
    expect(first).toBeGreaterThan(0);

    await settle(PANE_GIT_REFRESH_MS);
    const perRead = calls.length - first;
    expect(perRead).toBeGreaterThan(0); // 보이는 동안의 한 차례

    setVisibility("hidden");
    const hiddenFrom = calls.length;
    await settle(10 * PANE_GIT_REFRESH_MS);
    expect(calls.length).toBe(hiddenFrom);

    setVisibility("visible");
    await settle();
    expect(calls.length).toBe(hiddenFrom + perRead);
  });
});

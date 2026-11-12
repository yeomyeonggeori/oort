// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RESTART_QUIET_MS, type LocalWorkFacts } from "@momo/core/features/workbench/localWork";
import type { PaneSignal, PaneStatusInput } from "@momo/core/features/workbench/paneStatus";

// 업데이트 뒤 자동 다시 시작이 이 맥의 로컬 작업을 끊지 않는가 (#5661, owner 2026-11-11). 실제 저장소 + 실제 카드에
// 가짜 시계와 가짜 「로컬 작업」 원천을 물린다. 판정은 코어(`localWork.ts`), 여기는 그 판정이 다시 시작을 실제로 막고 푸는지 잰다.

const tauri = vi.hoisted(() => ({
  check: vi.fn(),
  install: vi.fn(),
  relaunch: vi.fn(),
  onProgress: vi.fn(),
}));

vi.mock("@/lib/tauri", () => ({
  isDesktop: () => true,
  appVersion: () => Promise.resolve("0.1.45"),
  desktopUpdater: {
    check: tauri.check,
    install: tauri.install,
    relaunch: tauri.relaunch,
    onProgress: tauri.onProgress,
  },
}));

import { BEFORE_RELAUNCH_EVENT } from "./relaunchFlush";
import { UpdateButton } from "./UpdateButton";
import {
  RESTART_GATE_TICK_MS,
  installUpdate,
  resetUpdateStoreForTest,
  startUpdateWatch,
  type LocalWorkSource,
} from "./store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const UPDATE = { version: "0.1.46", currentVersion: "0.1.45", notes: null, publishedAt: null };

const pane = (signal: PaneSignal | null): PaneStatusInput => ({ phase: "running", exitCode: null, exitSignal: null, signal });
const NONE: LocalWorkFacts = { panes: [], workHost: { running: false }, hostSessions: null };

let facts: LocalWorkFacts = NONE;
const source: LocalWorkSource = { refresh: vi.fn(async () => undefined), read: () => facts };

let stop: (() => void) | null = null;
let root: Root | null = null;
let host: HTMLElement | null = null;

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

const byId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

/** 새 판을 묻고 받아 설치까지 끝낸다(알약을 누른 것과 같다). */
async function installWith(start: LocalWorkFacts): Promise<void> {
  facts = start;
  stop = startUpdateWatch({ localWork: source });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(createElement(UpdateButton)));
  await advance(0);
  await act(async () => {
    await installUpdate();
  });
  await advance(0);
}

beforeEach(() => {
  vi.useFakeTimers({ now: Date.UTC(2026, 10, 11, 3, 0, 0) });
  resetUpdateStoreForTest();
  for (const fn of Object.values(tauri)) fn.mockReset();
  tauri.check.mockResolvedValue(UPDATE);
  tauri.install.mockResolvedValue(undefined);
  tauri.onProgress.mockResolvedValue(() => undefined);
  facts = NONE;
});

afterEach(() => {
  stop?.();
  stop = null;
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  vi.useRealTimers();
});

describe("업데이트 뒤 다시 시작의 문 (저장소)", () => {
  it("로컬 작업이 없으면 설치가 끝나자마자 3초 카운트다운 뒤에 다시 시작한다", async () => {
    await installWith(NONE);
    expect(byId("update-card-subline")?.textContent).toContain("3초 뒤");
    await advance(2_999);
    expect(tauri.relaunch).not.toHaveBeenCalled();
    await advance(1);
    expect(tauri.relaunch).toHaveBeenCalledTimes(1);
  });

  it("칸이 일하는 동안은 기다리고 끊길 것을 한 줄로 말한다. 끝난 뒤 쉬는 상태가 2분 이어지면 그때 다시 시작한다", async () => {
    await installWith({ ...NONE, panes: [pane("working"), pane("waiting-permission")] });
    expect(byId("update-card-now")?.getAttribute("data-hold")).toBe("true");
    expect(byId("update-card-title")?.textContent).toBe("Restarts when your work ends");
    expect(byId("update-card-subline")?.textContent).toBe("Restarting now stops: 2 terminal panes");
    await advance(30 * 60 * 1000);
    expect(tauri.relaunch).not.toHaveBeenCalled();

    facts = { ...NONE, panes: [pane("turn-done"), pane("ready")] };
    await advance(RESTART_GATE_TICK_MS);
    // 쉬는 시간 동안에는 끊길 것이 없으니 부제가 없다.
    expect(byId("update-card-subline")).toBeNull();
    await advance(RESTART_QUIET_MS - RESTART_GATE_TICK_MS);
    expect(tauri.relaunch).not.toHaveBeenCalled();
    await advance(RESTART_GATE_TICK_MS + 3_000);
    expect(tauri.relaunch).toHaveBeenCalledTimes(1);
  });

  it("모르면(작업 데몬을 못 읽음) 끊지 않는다", async () => {
    await installWith({ ...NONE, workHost: null });
    await advance(60 * 60 * 1000);
    expect(tauri.relaunch).not.toHaveBeenCalled();
    expect(byId("update-card-subline")?.textContent).toBe("Restarting now stops: work that could not be checked");
  });

  it("카운트다운 중에 작업 세션이 시작되면 다시 기다린다", async () => {
    await installWith(NONE);
    await advance(1_000);
    facts = { ...NONE, workHost: { running: true }, hostSessions: [{ status: "running" }] };
    await advance(10_000);
    expect(tauri.relaunch).not.toHaveBeenCalled();
    expect(byId("update-card-subline")?.textContent).toBe("Restarting now stops: 1 work session");
  });

  it("「지금 다시 시작」은 기다리지 않고, 쓰던 글을 먼저 내린 뒤 한 번만 다시 시작한다", async () => {
    const order: string[] = [];
    const onFlush = () => order.push("flush");
    window.addEventListener(BEFORE_RELAUNCH_EVENT, onFlush);
    tauri.relaunch.mockImplementation(async () => {
      order.push("relaunch");
    });
    await installWith({ ...NONE, panes: [pane(null)] });
    await act(async () => {
      byId("update-card-now")?.click();
      await Promise.resolve();
    });
    await advance(RESTART_QUIET_MS * 3);
    window.removeEventListener(BEFORE_RELAUNCH_EVENT, onFlush);
    expect(order).toEqual(["flush", "relaunch"]);
  });
});

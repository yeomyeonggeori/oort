// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 켜 둔 데스크탑 앱의 업데이트 확인이 실제 저장소에서 도는가 (#5661): 뜰 때·벽시계 6시간·창이 돌아올 때 묻고, 실패는 연결 기록에
// 남기고, 확인하지 않는 판은 「최신」이라고 하지 않는다.

const tauri = vi.hoisted(() => ({
  check: vi.fn(),
  install: vi.fn(),
  relaunch: vi.fn(),
  onProgress: vi.fn(),
}));

vi.mock("@/lib/tauri", () => ({
  isDesktop: () => true,
  appVersion: () => Promise.resolve("0.1.42"),
  desktopUpdater: {
    check: tauri.check,
    install: tauri.install,
    relaunch: tauri.relaunch,
    onProgress: tauri.onProgress,
  },
}));

import { readConnectionDiag, resetConnectionDiagForTest } from "@/features/common/connectionDiag";
import { UPDATER_DISABLED } from "./model";
import { RECHECK_INTERVAL_MS, SCHEDULE_TICK_MS, WAKE_RECHECK_GAP_MS } from "./schedule";
import { UpdateSection } from "./UpdateSection";
import { resetUpdateStoreForTest, startUpdateWatch, useUpdateState } from "./store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const UPDATE = { version: "0.1.45", currentVersion: "0.1.42", notes: null, publishedAt: null };

let stop: (() => void) | null = null;
let root: Root | null = null;
let host: HTMLElement | null = null;

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function kinds(): string[] {
  return readConnectionDiag().map((entry) => entry.kind);
}

beforeEach(() => {
  vi.useFakeTimers({ now: Date.UTC(2026, 10, 5, 3, 9, 0) });
  window.localStorage.clear();
  resetConnectionDiagForTest();
  resetUpdateStoreForTest();
  tauri.check.mockReset();
  tauri.onProgress.mockResolvedValue(() => undefined);
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

function StateProbe() {
  const state = useUpdateState();
  return createElement("output", { "data-testid": "probe" }, state.kind);
}

function render(node: ReturnType<typeof createElement>): HTMLElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root?.render(node));
  return host;
}

describe("업데이트 확인 일정 — 저장소 (#5661)", () => {
  it("뜰 때 묻고, 그 뒤 새 판이 올라오면 벽시계 6시간 + 한 칸 안에 알아챈다", async () => {
    tauri.check.mockResolvedValue(null);
    const view = render(createElement(StateProbe));
    stop = startUpdateWatch();
    await flush();
    expect(tauri.check).toHaveBeenCalledTimes(1);
    expect(view.querySelector('[data-testid="probe"]')?.textContent).toBe("current");

    // 새 판이 피드에 올라왔다.
    tauri.check.mockResolvedValue(UPDATE);
    await advance(RECHECK_INTERVAL_MS - SCHEDULE_TICK_MS);
    expect(tauri.check).toHaveBeenCalledTimes(1);
    await advance(2 * SCHEDULE_TICK_MS);
    expect(tauri.check).toHaveBeenCalledTimes(2);
    expect(view.querySelector('[data-testid="probe"]')?.textContent).toBe("available");
  });

  it("창이 다시 보이면(30분이 지났을 때) 곧바로 묻는다", async () => {
    tauri.check.mockResolvedValue(null);
    stop = startUpdateWatch();
    await flush();
    await advance(WAKE_RECHECK_GAP_MS);
    expect(tauri.check).toHaveBeenCalledTimes(1);
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await flush();
    expect(tauri.check).toHaveBeenCalledTimes(2);
  });

  it("확인 실패는 숨기지 않는다: 상태는 실패, 연결 기록에 시각과 종류가 남는다", async () => {
    tauri.check.mockRejectedValue(new Error("error sending request for url"));
    const view = render(createElement(StateProbe));
    stop = startUpdateWatch();
    await flush();
    expect(view.querySelector('[data-testid="probe"]')?.textContent).toBe("failed");
    expect(kinds()).toEqual(["update.check.failed"]);
    // 기록에는 종류 낱말만: 오류 문장은 들어가지 않는다.
    expect(JSON.stringify(readConnectionDiag())).not.toContain("error sending request");
  });

  it("확인하지 않는 판은 「최신」이 아니라 「확인 안 함」이고, 연결 기록에는 실행마다 한 번만 남는다", async () => {
    tauri.check.mockRejectedValue(UPDATER_DISABLED);
    const view = render(createElement(UpdateSection));
    stop = startUpdateWatch();
    await flush();
    const status = view.querySelector('[data-testid="update-status"]');
    expect(status?.getAttribute("data-update-state")).toBe("off");
    expect(status?.textContent).not.toContain("최신");
    expect(view.textContent).not.toContain("가장 최신");
    expect(view.textContent).not.toContain("앱이 스스로 새 버전으로 바꿔요");
    // 묻지 않는 판에 「업데이트 확인」 단추는 거짓 약속이다.
    expect(view.querySelector('[data-testid="update-check"]')).toBeNull();
    expect(view.querySelector('[data-testid="update-last-checked"]')).toBeNull();

    await advance(RECHECK_INTERVAL_MS + SCHEDULE_TICK_MS);
    expect(tauri.check).toHaveBeenCalledTimes(2);
    expect(kinds()).toEqual(["update.check.off"]);
  });

  it("설정 > 업데이트는 마지막으로 물은 시각을 보인다", async () => {
    tauri.check.mockResolvedValue(null);
    const view = render(createElement(UpdateSection));
    stop = startUpdateWatch();
    await flush();
    expect(view.querySelector('[data-testid="update-last-checked"]')?.textContent).toBeTruthy();
  });
});

// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({
  check: vi.fn(),
  install: vi.fn(),
  relaunch: vi.fn(),
  onProgress: vi.fn(),
}));

vi.mock("@/lib/tauri", () => ({
  isDesktop: () => true,
  appVersion: () => Promise.resolve("0.1.27"),
  desktopUpdater: {
    check: tauri.check,
    install: tauri.install,
    relaunch: tauri.relaunch,
    onProgress: tauri.onProgress,
  },
}));

import { RELAUNCH_COUNTDOWN_SECONDS, type UpdateState } from "./model";
import { BEFORE_RELAUNCH_EVENT } from "./relaunchFlush";
import { UpdateButton } from "./UpdateButton";
import {
  checkForUpdate,
  installUpdate,
  resetUpdateStoreForTest,
  seedUpdateStateForTest,
} from "./store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const UPDATE = {
  version: "0.1.28",
  currentVersion: "0.1.27",
  notes: null,
  publishedAt: null,
};

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  resetUpdateStoreForTest();
  for (const fn of Object.values(tauri)) fn.mockReset();
  tauri.onProgress.mockResolvedValue(() => undefined);
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  vi.useRealTimers();
});

function mount(): HTMLElement {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(createElement(UpdateButton));
  });
  return host;
}

const pill = () => document.querySelector<HTMLButtonElement>('[data-testid="update-pill"]');
const card = () => document.querySelector<HTMLElement>('[data-testid="update-card"]');
const byId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

function seed(state: UpdateState, countdown: number | null = null) {
  act(() => seedUpdateStateForTest(state, countdown));
}

const installFailed: UpdateState = {
  kind: "failed",
  phase: "install",
  message: "업데이트를 설치하지 못했어요. 지금 쓰던 버전은 그대로예요.",
  detail: "boom",
  update: null,
};

describe("업데이트 알약: 상태 → UI (성재 결재 2026-10-16)", () => {
  it("없을 때는 아무것도 그리지 않는다: 아직 모름·확인 중·최신·확인 실패(오프라인)", () => {
    mount();
    for (const state of [
      { kind: "idle" },
      { kind: "checking" },
      { kind: "current" },
      { ...installFailed, phase: "check" },
    ] as UpdateState[]) {
      seed(state);
      expect(pill()).toBeNull();
    }
  });

  it("새 버전: 「업데이트」 알약과 해요체 툴팁, 점은 없다", () => {
    mount();
    seed({ kind: "available", update: UPDATE });
    expect(pill()?.textContent).toBe("업데이트");
    expect(byId("update-pill-tooltip")?.textContent).toBe(
      "0.1.28로 업데이트할 수 있어요. 누르면 받고 다시 실행해요."
    );
    expect(pill()?.getAttribute("aria-describedby")).toBe(byId("update-pill-tooltip")?.id);
    expect(pill()?.getAttribute("aria-label")).toContain("0.1.28로 업데이트할 수 있어요");
    expect(document.querySelector('[data-testid="update-badge"]')).toBeNull();
    // 닫기·나중에 같은 거절 단추는 어디에도 없다.
    expect(host?.querySelectorAll("button").length).toBe(1);
  });

  it("받는 중: 툴팁이 퍼센트를 말하고, 길이를 모르면 퍼센트가 없다", () => {
    mount();
    seed({ kind: "installing", update: UPDATE, downloaded: 26, total: 100 });
    expect(byId("update-pill-tooltip")?.textContent).toBe("받는 중 26%");
    seed({ kind: "installing", update: UPDATE, downloaded: 26, total: null });
    expect(byId("update-pill-tooltip")?.textContent).toBe("받는 중이에요.");
  });

  it("설치 실패: 알약이 남아 다시 확인을 권한다", () => {
    mount();
    seed(installFailed);
    expect(pill()).not.toBeNull();
    expect(byId("update-pill-tooltip")?.textContent).toBe(
      "업데이트하지 못했어요. 눌러서 다시 확인해요."
    );
  });
});

describe("업데이트 카드", () => {
  it("새 버전 알약을 누르면 받기를 시작하고 카드가 게이지를 보인다", async () => {
    tauri.install.mockImplementation(() => new Promise(() => undefined));
    mount();
    seed({ kind: "available", update: UPDATE });
    await act(async () => {
      pill()?.click();
      await Promise.resolve();
    });
    expect(tauri.install).toHaveBeenCalledTimes(1);
    expect(card()).not.toBeNull();
    expect(byId("update-card-title")?.textContent).toBe("새 버전을 받는 중");
    expect(byId("update-card-subline")?.textContent).toBe("앱은 그대로 쓸 수 있어요");
    // 툴팁은 카드가 열리면 물러난다.
    expect(byId("update-pill-tooltip")).toBeNull();
  });

  it("게이지: 길이를 알면 value/max 속성, 모르면 value 없는 불확정 막대", () => {
    mount();
    seed({ kind: "installing", update: UPDATE, downloaded: 11_100_000, total: 42_600_000 });
    act(() => pill()?.click());
    const bar = () => card()?.querySelector("progress") as HTMLProgressElement;
    expect(bar().getAttribute("value")).toBe("11100000");
    expect(bar().getAttribute("max")).toBe("42600000");
    expect(card()?.textContent).toContain("11.1 / 42.6 MB");
    expect(card()?.textContent).toContain("26%");
    // CSP: 인라인 스타일이 없다.
    expect(card()?.querySelector("[style]")).toBeNull();
    seed({ kind: "installing", update: UPDATE, downloaded: 3_000_000, total: null });
    expect(bar().hasAttribute("value")).toBe(false);
    expect(card()?.textContent).not.toContain("%");
  });

  it("카드는 롤 dialog 이고 열리면 초점이 카드 안으로 간다", async () => {
    mount();
    seed({ kind: "installing", update: UPDATE, downloaded: 1, total: 2 });
    await act(async () => {
      pill()?.click();
      await Promise.resolve();
    });
    expect(card()?.getAttribute("role")).toBe("dialog");
    expect(card()?.getAttribute("aria-label")).toBe("앱 업데이트");
    expect(card()?.contains(document.activeElement)).toBe(true);
  });

  it("실패: 이유 줄과 「다시 확인」, 누르면 checkForUpdate 를 부른다", async () => {
    tauri.check.mockResolvedValue(null);
    mount();
    seed(installFailed);
    act(() => pill()?.click());
    expect(byId("update-card-title")?.textContent).toBe("업데이트하지 못했어요");
    expect(byId("update-card-subline")?.textContent).toContain("그대로예요");
    await act(async () => {
      byId("update-card-recheck")?.click();
      await Promise.resolve();
    });
    expect(tauri.check).toHaveBeenCalledTimes(1);
  });

  it("다시 확인이 또 실패해도(오프라인) 카드는 열린 채 결과를 보인다", async () => {
    tauri.check.mockRejectedValue(new Error("offline"));
    mount();
    seed(installFailed);
    act(() => pill()?.click());
    await act(async () => {
      await checkForUpdate();
    });
    expect(card()).not.toBeNull();
    expect(byId("update-card-title")?.textContent).toBe("업데이트하지 못했어요");
  });
});

describe("자동 다시 실행 (store 가 시계를 쥔다)", () => {
  async function finishInstall() {
    tauri.check.mockResolvedValue(UPDATE);
    tauri.install.mockResolvedValue(undefined);
    await act(async () => {
      await checkForUpdate();
      await installUpdate();
    });
  }

  it("설치가 끝나면 3초 카운트다운 뒤에 한 번 다시 실행한다", async () => {
    vi.useFakeTimers();
    mount();
    await finishInstall();
    expect(RELAUNCH_COUNTDOWN_SECONDS).toBe(3);
    expect(byId("update-card-title")?.textContent).toBe("곧 다시 실행돼요");
    expect(byId("update-card-subline")?.textContent).toContain("3초 뒤");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(byId("update-card-subline")?.textContent).toContain("2초 뒤");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1999);
    });
    expect(tauri.relaunch).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(tauri.relaunch).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(tauri.relaunch).toHaveBeenCalledTimes(1);
  });

  it("「지금」은 기다리지 않고 한 번만 다시 실행하고 남은 시계를 치운다", async () => {
    vi.useFakeTimers();
    mount();
    await finishInstall();
    await act(async () => {
      byId("update-card-now")?.click();
      await Promise.resolve();
    });
    expect(tauri.relaunch).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(tauri.relaunch).toHaveBeenCalledTimes(1);
  });

  it("카드를 닫아도 시계는 계속 돌고 다시 실행한다", async () => {
    vi.useFakeTimers();
    mount();
    await finishInstall();
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(tauri.relaunch).toHaveBeenCalledTimes(1);
  });

  it("다시 실행하기 전에 쓰던 글을 저장하라는 신호를 먼저, 동기로 보낸다", async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const onFlush = () => order.push("flush");
    window.addEventListener(BEFORE_RELAUNCH_EVENT, onFlush);
    tauri.relaunch.mockImplementation(async () => {
      order.push("relaunch");
    });
    mount();
    await finishInstall();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    window.removeEventListener(BEFORE_RELAUNCH_EVENT, onFlush);
    expect(order).toEqual(["flush", "relaunch"]);
  });

  it("다시 실행이 실패하면 설치 상태와 「지금」을 남긴다", async () => {
    vi.useFakeTimers();
    tauri.relaunch.mockRejectedValue(new Error("nope"));
    mount();
    await finishInstall();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(byId("update-card-title")?.textContent).toBe("다시 실행해 주세요");
    expect(byId("update-card-now")).not.toBeNull();
  });
});

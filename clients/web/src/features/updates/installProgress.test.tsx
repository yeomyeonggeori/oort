// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// #4019: 2026-10-16 staging update run, the gauge sat on 「0 B」. Every other
// updates test seeds the store directly or mocks `onProgress` as a no-op, so
// nothing ever drove a shell progress event through `installUpdate` into the
// rendered gauge. This file does: it captures the handler `installUpdate`
// registers with `desktopUpdater.onProgress` and plays the shell's events.

const tauri = vi.hoisted(() => ({
  check: vi.fn(),
  install: vi.fn(),
  relaunch: vi.fn(),
  onProgress: vi.fn(),
}));

vi.mock("@/lib/tauri", () => ({
  isDesktop: () => true,
  appVersion: () => Promise.resolve("0.1.28"),
  desktopUpdater: {
    check: tauri.check,
    install: tauri.install,
    relaunch: tauri.relaunch,
    onProgress: tauri.onProgress,
  },
}));

import { UpdateButton } from "./UpdateButton";
import { UpdateSection } from "./UpdateSection";
import { installUpdate, resetUpdateStoreForTest, seedUpdateStateForTest } from "./store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const UPDATE = {
  version: "0.1.28-staging.2",
  currentVersion: "0.1.28-staging.1",
  notes: null,
  publishedAt: null,
};

type Handler = (progress: { downloaded: number; total: number | null }) => void;

let emit: Handler = () => {
  throw new Error("installUpdate never subscribed to onProgress");
};
let finishInstall: () => void = () => {};
let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  resetUpdateStoreForTest();
  tauri.check.mockReset();
  tauri.relaunch.mockReset();
  tauri.install.mockReset();
  tauri.onProgress.mockReset();
  tauri.onProgress.mockImplementation((handler: Handler) => {
    emit = handler;
    return Promise.resolve(() => undefined);
  });
  tauri.install.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finishInstall = resolve;
      })
  );
});

afterEach(async () => {
  await act(async () => {
    finishInstall();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  resetUpdateStoreForTest();
});

async function mount(component: typeof UpdateSection | typeof UpdateButton): Promise<HTMLElement> {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(createElement(component));
    await Promise.resolve();
  });
  return host;
}

async function startInstall(): Promise<void> {
  await act(async () => {
    seedUpdateStateForTest({ kind: "available", update: UPDATE });
    void installUpdate();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const gauge = (el: ParentNode) => el.querySelector("progress") as HTMLProgressElement | null;
const text = (el: ParentNode, id: string) =>
  el.querySelector(`[data-testid="${id}"]`)?.textContent ?? "";

describe("업데이트 받는 중 게이지: shell 진행 이벤트가 화면까지 간다 (#4019)", () => {
  it("설정: 첫 이벤트 전에는 「0 B」가 아니라 「받는 중」이고 불확정 막대다", async () => {
    const el = await mount(UpdateSection);
    await startInstall();
    expect(tauri.install).toHaveBeenCalledTimes(1);
    expect(text(el, "update-progress")).toBe("받는 중");
    expect(text(el, "update-progress")).not.toContain("0 B");
    expect(gauge(el)).not.toBeNull();
    expect(gauge(el)?.hasAttribute("value")).toBe(false);
  });

  it("설정: 길이를 아는 이벤트가 오면 value/max 와 「x / y MB (n%)」로 움직인다", async () => {
    const el = await mount(UpdateSection);
    await startInstall();
    act(() => emit({ downloaded: 2_500_000, total: 10_000_000 }));
    expect(gauge(el)?.getAttribute("value")).toBe("2500000");
    expect(gauge(el)?.getAttribute("max")).toBe("10000000");
    expect(text(el, "update-progress")).toBe("2.5 / 10.0 MB (25%)");
    act(() => emit({ downloaded: 7_500_000, total: 10_000_000 }));
    expect(gauge(el)?.getAttribute("value")).toBe("7500000");
    expect(text(el, "update-progress")).toBe("7.5 / 10.0 MB (75%)");
  });

  it("설정: 길이 없는 응답(total=null)은 바이트 대신 「받는 중」, 값 없는 막대, % 없음", async () => {
    const el = await mount(UpdateSection);
    await startInstall();
    act(() => emit({ downloaded: 3_200_000, total: null }));
    expect(text(el, "update-progress")).toBe("받는 중");
    expect(text(el, "update-progress")).not.toMatch(/MB|KB|\bB\b|%/);
    expect(gauge(el)?.hasAttribute("value")).toBe(false);
  });

  it("사이드바 카드: 같은 이벤트가 알약 카드의 게이지도 움직인다", async () => {
    await mount(UpdateButton);
    await startInstall();
    const pill = document.querySelector('[data-testid="update-pill"]') as HTMLButtonElement;
    await act(async () => {
      pill.click();
      await Promise.resolve();
    });
    const card = () => document.querySelector('[data-testid="update-card"]') as HTMLElement;
    expect(card().textContent).toContain("받는 중");
    expect(card().textContent).not.toContain("0 B");
    act(() => emit({ downloaded: 5_000_000, total: 10_000_000 }));
    expect(gauge(card())?.getAttribute("value")).toBe("5000000");
    expect(card().textContent).toContain("5.0 / 10.0 MB");
    expect(card().textContent).toContain("50%");
  });

  it("끝난 설치(installed)의 뒤늦은 이벤트는 상태를 되돌리지 않는다", async () => {
    const el = await mount(UpdateSection);
    await startInstall();
    await act(async () => {
      finishInstall();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(el.querySelector('[data-testid="update-installed"]')).not.toBeNull();
    act(() => emit({ downloaded: 1, total: 2 }));
    expect(el.querySelector('[data-testid="update-installed"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="update-progress"]')).toBeNull();
  });
});

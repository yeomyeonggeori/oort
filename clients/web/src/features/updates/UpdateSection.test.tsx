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
  appVersion: () => Promise.resolve("0.1.19"),
  desktopUpdater: {
    check: tauri.check,
    install: tauri.install,
    relaunch: tauri.relaunch,
    onProgress: tauri.onProgress,
  },
}));

import { UpdateSection } from "./UpdateSection";
import {
  checkForUpdate,
  installUpdate,
  resetUpdateStoreForTest,
  startUpdateWatch,
} from "./store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const UPDATE = {
  version: "0.1.20",
  currentVersion: "0.1.19",
  notes: "인박스 필터가 새로고침 뒤에도 유지돼요.",
  publishedAt: "2026-10-07T09:00:00Z",
};

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  resetUpdateStoreForTest();
  tauri.check.mockReset();
  tauri.install.mockReset();
  tauri.relaunch.mockReset();
  tauri.onProgress.mockReset();
  tauri.onProgress.mockResolvedValue(() => undefined);
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

async function mount(): Promise<HTMLElement> {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(createElement(UpdateSection));
    await Promise.resolve();
  });
  return host;
}

const q = (el: HTMLElement, id: string) => el.querySelector(`[data-testid="${id}"]`);

describe("설정 > 업데이트 (#3578 S5a)", () => {
  it("모르는 상태에서는 확인 단추만 있고 현재 버전을 보여 준다", async () => {
    await act(async () => {
      startUpdateWatch();
      await Promise.resolve();
    });
    tauri.check.mockResolvedValue(null);
    const el = await mount();
    expect(el.textContent).toContain("0.1.19");
    expect(q(el, "update-check")).not.toBeNull();
    expect(q(el, "update-install")).toBeNull();
  });

  it("새 버전이 있으면 새 버전·공개일·노트와 설치 단추를 보인다", async () => {
    tauri.check.mockResolvedValue(UPDATE);
    await act(async () => {
      await checkForUpdate();
    });
    const el = await mount();
    expect(el.textContent).toContain("0.1.20");
    expect(el.textContent).toContain("공개일");
    expect(q(el, "update-notes")?.textContent).toContain("인박스 필터");
    expect(q(el, "update-status")?.textContent).toContain("새 버전 있음");
    expect(q(el, "update-install")).not.toBeNull();
  });

  it("설치가 끝나면 재시작 단추와 해요체 안내를 보인다", async () => {
    tauri.check.mockResolvedValue(UPDATE);
    tauri.install.mockResolvedValue(undefined);
    await act(async () => {
      await checkForUpdate();
      await installUpdate();
    });
    const el = await mount();
    expect(q(el, "update-installed")?.textContent).toContain("재시작하면 0.1.20(으)로 열려요");
    expect(q(el, "update-relaunch")).not.toBeNull();
  });

  it("확인에 실패하면 이유와 다시 시도를 보이고 문장은 해요체다", async () => {
    tauri.check.mockRejectedValue(new Error("network down"));
    await act(async () => {
      await checkForUpdate();
    });
    const el = await mount();
    const error = q(el, "update-error");
    expect(error?.textContent).toContain("업데이트 서버에 닿지 못했어요");
    expect(el.textContent).toContain("network down");
  });

  it("설치에 실패한 문장도 해요체다", async () => {
    tauri.check.mockResolvedValue(UPDATE);
    tauri.install.mockRejectedValue(new Error("signature mismatch"));
    await act(async () => {
      await checkForUpdate();
      await installUpdate();
    });
    const el = await mount();
    expect(q(el, "update-error")?.textContent).toContain("그대로예요");
  });

  it("어느 상태에서도 합쇼체(…습니다)가 화면에 없다", async () => {
    const seen: string[] = [];
    // 새 버전 → 설치 완료 → 실패 세 장면을 한 번씩 그린다.
    tauri.check.mockResolvedValue(UPDATE);
    tauri.install.mockResolvedValue(undefined);
    await act(async () => {
      await checkForUpdate();
    });
    seen.push((await mount()).textContent ?? "");
    await act(async () => {
      await installUpdate();
    });
    seen.push(host?.textContent ?? "");
    tauri.check.mockRejectedValue(new Error("x"));
    await act(async () => {
      await checkForUpdate();
    });
    seen.push(host?.textContent ?? "");
    expect(seen.every((text) => text.length > 0)).toBe(true);
    for (const text of seen) expect(text).not.toMatch(/습니다/);
  });
});

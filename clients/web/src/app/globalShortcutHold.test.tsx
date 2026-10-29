// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { InboxHotkeys } from "@/features/inbox/InboxHotkeys";
import { globalShortcutsHeld, holdGlobalShortcuts } from "./globalShortcutHold";

// 한 번만 보이는 값이 떠 있는 동안 창의 이동 단축키를 멈추는 걸이 (#4663, 보안·디자인 검수 High).
// 걸이 자체의 약속(건 만큼 풀어야 풀린다)과, 걸이를 읽는 **진짜 핸들러**(`InboxHotkeys`, ⌘⇧A)가 걸린 동안
// 물러서고 풀리면 다시 서는지를 잰다. 팔레트(`quickSwitcherCommands.test.tsx`)와 사이드바
// (`Sidebar.dm.test.tsx`)의 핸들러는 각자의 시험 파일에서 같은 걸이를 잰다.

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

let host: HTMLElement | null = null;
let root: Root | null = null;

function PathProbe() {
  return createElement("output", { "data-testid": "path" }, useLocation().pathname);
}

async function mountAt(path: string): Promise<void> {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      createElement(
        MemoryRouter,
        { initialEntries: [path] },
        createElement(PathProbe),
        createElement(InboxHotkeys)
      )
    );
    await Promise.resolve();
  });
}

const pathNow = () => host?.querySelector('[data-testid="path"]')?.textContent;

/** ⌘⇧A. 창이 받은 키가 기본 동작을 빼앗겼는지(`defaultPrevented`)를 돌려준다. */
async function pressOpenInbox(): Promise<boolean> {
  const event = new KeyboardEvent("keydown", {
    key: "A",
    metaKey: true,
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  });
  await act(async () => {
    window.dispatchEvent(event);
    await Promise.resolve();
  });
  return event.defaultPrevented;
}

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  host = null;
  root = null;
});

describe("전역 이동 단축키 멈춤 걸이", () => {
  it("걸지 않으면 서 있고, 걸면 멈추고, 풀면 다시 선다", () => {
    expect(globalShortcutsHeld()).toBe(false);
    const release = holdGlobalShortcuts();
    expect(globalShortcutsHeld()).toBe(true);
    release();
    expect(globalShortcutsHeld()).toBe(false);
  });

  it("건 만큼 풀어야 풀리고, 같은 걸이를 두 번 풀어도 다른 걸이를 풀지 않는다", () => {
    const first = holdGlobalShortcuts();
    const second = holdGlobalShortcuts();
    first();
    first();
    expect(globalShortcutsHeld()).toBe(true);
    second();
    expect(globalShortcutsHeld()).toBe(false);
  });
});

describe("받은 편지함 단축키(⌘⇧A)가 걸이를 읽는다", () => {
  it("걸지 않으면 받은 편지함으로 간다(장면이 진짜다)", async () => {
    await mountAt("/settings");
    expect(pathNow()).toBe("/settings");
    await pressOpenInbox();
    expect(pathNow()).toBe("/inbox");
  });

  it("걸린 동안은 가지 않고 키의 기본 동작도 빼앗지 않으며, 풀리면 다시 간다", async () => {
    await mountAt("/settings");
    const release = holdGlobalShortcuts();
    let prevented: boolean;
    try {
      prevented = await pressOpenInbox();
      expect(pathNow()).toBe("/settings");
    } finally {
      release();
    }
    expect(prevented).toBe(false);

    await pressOpenInbox();
    expect(pathNow()).toBe("/inbox");
  });
});

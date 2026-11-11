// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DockBadge } from "./DockBadge";
import {
  reloadDesktopNotificationKindsForTest,
  setDesktopNotificationKind,
} from "./preference";
import { setServerPause } from "./serverPause";

const hoisted = vi.hoisted(() => ({
  needsMe: 4,
  setDockBadge: vi.fn(async (_count: number) => true),
  pathname: "/",
  dm2Muted: false,
}));

vi.mock("@/lib/tauri", () => ({
  isDesktop: () => true,
  setDockBadge: (n: number) => hoisted.setDockBadge(n),
}));
vi.mock("@/app/session", () => ({ useSession: () => ({ workspaceId: "w" }) }));
vi.mock("@/features/inbox/useNeedsMe", () => ({ useNeedsMeCount: () => hoisted.needsMe }));
vi.mock("react-router-dom", () => ({ useLocation: () => ({ pathname: hoisted.pathname }) }));
vi.mock("@/features/workspace/useWorkspace", () => ({
  useChannels: () => ({
    groups: { channels: [], dms: [{ id: "dm1", muted: false }, { id: "dm2", muted: hoisted.dm2Muted }] },
  }),
  useReadStates: () => ({
    byChannel: new Map([
      ["dm1", { unreadCount: 2 }],
      ["dm2", { unreadCount: 3 }],
    ]),
  }),
}));
vi.mock("@momo/core/features/workspace/directory", () => ({
  unreadFor: (m: Map<string, { unreadCount: number }>, id: string) => m.get(id) ?? null,
}));

const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root | null = null;
let host: HTMLElement | null = null;

beforeAll(() => {
  env.IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  hoisted.needsMe = 4;
  hoisted.pathname = "/";
  hoisted.dm2Muted = false;
  hoisted.setDockBadge.mockClear();
  localStorage.clear();
  reloadDesktopNotificationKindsForTest(localStorage);
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  reloadDesktopNotificationKindsForTest(null);
  setServerPause(false);
});

function mount() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(createElement(DockBadge)));
}

describe("DockBadge (#3339)", () => {
  it("독 배지는 useNeedsMeCount에 안 읽은 DM의 수를 더한 수를 그린다 (#5660)", () => {
    mount();
    expect(hoisted.setDockBadge).toHaveBeenLastCalledWith(9); // 4 + DM 2 + 3
    hoisted.needsMe = 7;
    act(() => root?.render(createElement(DockBadge)));
    expect(hoisted.setDockBadge).toHaveBeenLastCalledWith(12);
  });

  it("DM 스위치를 끄면 needsMe 수 그대로이고, 독 배지를 끄면 0이다", () => {
    mount();
    act(() => setDesktopNotificationKind("dockDms", false, localStorage));
    expect(hoisted.setDockBadge).toHaveBeenLastCalledWith(4);
    act(() => setDesktopNotificationKind("dockDms", true, localStorage));
    expect(hoisted.setDockBadge).toHaveBeenLastCalledWith(9);
    act(() => setDesktopNotificationKind("dockBadge", false, localStorage));
    expect(hoisted.setDockBadge).toHaveBeenLastCalledWith(0);
  });

  it("예전 키(`dockDm: false`, 옛 기본값으로 저장된 것)는 읽지 않는다: owner 결정 뒤 기본은 켬이다 (#5660)", () => {
    localStorage.setItem("momo.web.notifications.v1", JSON.stringify({ dockDm: false, dockBadge: true }));
    reloadDesktopNotificationKindsForTest(localStorage);
    mount();
    expect(hoisted.setDockBadge).toHaveBeenLastCalledWith(9);
  });

  it("지금 앞에서 보고 있는 DM은 세지 않는다. 알림을 끈 DM은 센다 — 배지는 별개 원장이다 (#5660, ADR-0124 D2)", () => {
    hoisted.pathname = "/c/dm1";
    mount();
    expect(hoisted.setDockBadge).toHaveBeenLastCalledWith(7); // 4 + dm2 3
    hoisted.dm2Muted = true;
    act(() => root?.render(createElement(DockBadge)));
    expect(hoisted.setDockBadge).toHaveBeenLastCalledWith(7);
  });

  it("알림 일시 중지는 독 배지를 건드리지 않는다 — DM 몫까지 배지는 별개 원장이다 (#4197, #5660, ADR-0124 D4-A)", () => {
    setServerPause(true);
    mount();
    expect(hoisted.setDockBadge).toHaveBeenLastCalledWith(9);
    act(() => setServerPause(false));
    act(() => root?.render(createElement(DockBadge)));
    expect(hoisted.setDockBadge).toHaveBeenLastCalledWith(9);
  });
});

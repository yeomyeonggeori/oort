// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DockBadge } from "./DockBadge";
import {
  reloadDesktopNotificationKindsForTest,
  setDesktopNotificationKind,
} from "./preference";

const hoisted = vi.hoisted(() => ({
  needsMe: 4,
  setDockBadge: vi.fn(async (_count: number) => true),
}));

vi.mock("@/lib/tauri", () => ({
  isDesktop: () => true,
  setDockBadge: (n: number) => hoisted.setDockBadge(n),
}));
vi.mock("@/app/session", () => ({ useSession: () => ({ workspaceId: "w" }) }));
vi.mock("@/features/inbox/useNeedsMe", () => ({ useNeedsMeCount: () => hoisted.needsMe }));
vi.mock("@/features/workspace/useWorkspace", () => ({
  useChannels: () => ({ groups: { channels: [], dms: [{ id: "dm1" }, { id: "dm2" }] } }),
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
  hoisted.setDockBadge.mockClear();
  localStorage.clear();
  reloadDesktopNotificationKindsForTest(localStorage);
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  reloadDesktopNotificationKindsForTest(null);
});

function mount() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(createElement(DockBadge)));
}

describe("DockBadge (#3339)", () => {
  it("독 배지는 useNeedsMeCount와 같은 수를 그린다", () => {
    mount();
    expect(hoisted.setDockBadge).toHaveBeenLastCalledWith(4);
    hoisted.needsMe = 7;
    act(() => root?.render(createElement(DockBadge)));
    expect(hoisted.setDockBadge).toHaveBeenLastCalledWith(7);
  });

  it("기본값에서 안 읽은 DM(5)은 세지 않는다", () => {
    mount();
    expect(hoisted.setDockBadge).not.toHaveBeenCalledWith(9);
    expect(hoisted.setDockBadge).toHaveBeenLastCalledWith(4);
  });

  it("DM 합산을 켜면 더해지고, 독 배지를 끄면 0이다", () => {
    mount();
    act(() => setDesktopNotificationKind("dockDm", true, localStorage));
    expect(hoisted.setDockBadge).toHaveBeenLastCalledWith(9);
    act(() => setDesktopNotificationKind("dockBadge", false, localStorage));
    expect(hoisted.setDockBadge).toHaveBeenLastCalledWith(0);
  });
});

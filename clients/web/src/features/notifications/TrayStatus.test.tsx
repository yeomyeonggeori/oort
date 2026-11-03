// @vitest-environment jsdom

import { act, createElement, Fragment } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { onEntryDismiss } from "@momo/core/features/notifications/entryDismiss";
import type { AdeItem } from "@momo/core/features/work/adeControl";
import { holdGlobalShortcuts } from "@/app/globalShortcutHold";
import type { TrayStatusWire } from "@/lib/tauri";
import { DockBadge } from "./DockBadge";
import {
  reloadDesktopNotificationKindsForTest,
  setDesktopNotificationKind,
} from "./preference";
import { TrayStatus } from "./TrayStatus";

const hoisted = vi.hoisted(() => ({
  needsMe: 4,
  items: [] as unknown[],
  adeProvided: true,
  adeArgs: [] as unknown[][],
  setDockBadge: vi.fn(async (_count: number) => true),
  setTrayStatus: vi.fn(async (_status: unknown) => true),
  trayHandler: null as ((payload: unknown) => void) | null,
  unlistened: 0,
  navigate: vi.fn(),
  openNewDm: vi.fn(),
  openWorkPanel: vi.fn(),
}));

vi.mock("@/lib/tauri", () => ({
  isDesktop: () => true,
  setDockBadge: (n: number) => hoisted.setDockBadge(n),
  setTrayStatus: (s: unknown) => hoisted.setTrayStatus(s),
  onTrayAction: (handler: (payload: unknown) => void) => {
    hoisted.trayHandler = handler;
    return Promise.resolve(() => {
      hoisted.unlistened += 1;
    });
  },
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
vi.mock("@/features/ade/useAdeControl", () => ({
  useAdeControl: (...args: unknown[]) => {
    hoisted.adeArgs.push(args);
    return { items: hoisted.items };
  },
}));
vi.mock("@/features/capabilities/useSurfaceProvided", () => ({
  useSurfaceProvidedWhileOpen: (id: string) => id === "ade" && hoisted.adeProvided,
}));
vi.mock("react-router-dom", () => ({ useNavigate: () => hoisted.navigate }));
vi.mock("@/features/directory/useNewDm", () => ({ useOpenNewDm: () => hoisted.openNewDm }));
vi.mock("@/features/agents/workLogStore", () => ({
  openWorkPanel: (...args: unknown[]) => hoisted.openWorkPanel(...args),
}));

const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root | null = null;
let host: HTMLElement | null = null;

const UUID = "0a1b2c3d-0000-4000-8000-";
const run: AdeItem = {
  key: "run|r1|c1",
  kind: "run",
  state: "blocked",
  durability: "unknown",
  channelId: `${UUID}0000000000c1`,
  title: "김인턴",
  detail: "",
  runId: `${UUID}000000000001`,
  memberId: `${UUID}0000000000a1`,
};
const session: AdeItem = {
  key: "session|s1",
  kind: "session",
  state: "working",
  durability: "unknown",
  channelId: `${UUID}0000000000c2`,
  title: "codex",
  detail: "",
  sessionId: `${UUID}0000000000e1`,
};

beforeAll(() => {
  env.IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  hoisted.needsMe = 4;
  hoisted.items = [];
  hoisted.adeProvided = true;
  hoisted.adeArgs = [];
  hoisted.trayHandler = null;
  hoisted.unlistened = 0;
  for (const spy of [
    hoisted.setDockBadge,
    hoisted.setTrayStatus,
    hoisted.navigate,
    hoisted.openNewDm,
    hoisted.openWorkPanel,
  ]) {
    spy.mockClear();
  }
  localStorage.clear();
  reloadDesktopNotificationKindsForTest(localStorage);
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  reloadDesktopNotificationKindsForTest(null);
});

/** 독 배지와 메뉴 막대를 함께 올린다: 둘이 같은 수를 보는지 보려면 같은 트리에 있어야 한다. */
function mount() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  render();
}
function render() {
  act(() =>
    root?.render(createElement(Fragment, null, createElement(DockBadge), createElement(TrayStatus)))
  );
}
const lastStatus = () => hoisted.setTrayStatus.mock.lastCall?.[0] as TrayStatusWire;
const pick = (payload: unknown) => act(() => hoisted.trayHandler?.(payload));

describe("TrayStatus: 셸로 보내기 (#5193)", () => {
  it("메뉴 막대의 수는 독 배지가 그리는 수와 늘 같다 — 기본, DM 합산, 배지 끔", () => {
    mount();
    const both = () => [
      hoisted.setDockBadge.mock.lastCall?.[0],
      lastStatus().unread,
    ];
    expect(both()).toEqual([4, 4]);
    hoisted.needsMe = 7;
    render();
    expect(both()).toEqual([7, 7]);
    // DM 합산을 켜면 둘 다 더해지고(7 + 5), 독 배지를 끄면 둘 다 0이다.
    act(() => setDesktopNotificationKind("dockDm", true, localStorage));
    expect(both()).toEqual([12, 12]);
    act(() => setDesktopNotificationKind("dockBadge", false, localStorage));
    expect(both()).toEqual([0, 0]);
  });

  it("상태가 바뀔 때만 보낸다: 같은 내용으로 다시 그려도 부르지 않는다", () => {
    mount();
    expect(hoisted.setTrayStatus).toHaveBeenCalledTimes(1);
    render();
    render();
    expect(hoisted.setTrayStatus).toHaveBeenCalledTimes(1);
    hoisted.needsMe = 5;
    render();
    expect(hoisted.setTrayStatus).toHaveBeenCalledTimes(2);
    expect(lastStatus().unread).toBe(5);
    // 실행 중인 작업이 생겨도 한 번만 더 간다.
    hoisted.items = [run, session];
    render();
    render();
    expect(hoisted.setTrayStatus).toHaveBeenCalledTimes(3);
    expect(lastStatus().running.map((r) => r.title)).toEqual(["김인턴", "codex"]);
  });

  it("앱 셸이 내려가면 수 0·줄 없음·「새 메시지」 꺼짐으로 보낸다(낱말은 그대로)", () => {
    hoisted.items = [run];
    mount();
    expect(lastStatus()).toMatchObject({ unread: 4, compose: true });
    const labels = lastStatus().labels;
    act(() => root?.unmount());
    root = null;
    expect(lastStatus()).toEqual({ unread: 0, compose: false, labels, running: [], more: null });
  });
});

describe("TrayStatus: 메뉴에서 고른 것 (#5193)", () => {
  it("「새 메시지」는 겹친 표면을 걷고 새 DM 모달을 연다", async () => {
    mount();
    await act(async () => {});
    const order: string[] = [];
    const off = onEntryDismiss(() => order.push("dismiss"));
    hoisted.openNewDm.mockImplementation(() => order.push("open"));
    pick({ action: "new-message" });
    off();
    expect(order).toEqual(["dismiss", "open"]);
  });

  it("작업 줄은 마지막으로 보낸 줄의 작업으로 간다: 턴은 작업 패널, 세션은 ?work= 주소", async () => {
    hoisted.items = [run, session];
    mount();
    await act(async () => {});
    const [first, second] = lastStatus().running;
    // 메뉴 막대도 알림 배너처럼 새 입구다: 이동 직전에 겹친 임시 표면을 걷는다(줄마다 한 번).
    const dismissed: string[] = [];
    const off = onEntryDismiss(() => dismissed.push("dismiss"));
    pick({ action: "run", id: first?.id });
    expect(hoisted.openWorkPanel).toHaveBeenCalledWith(
      {
        runId: run.runId,
        memberId: run.memberId,
        channelId: run.channelId,
        origin: "ade",
      },
      null
    );
    expect(hoisted.navigate).not.toHaveBeenCalled();
    expect(dismissed).toEqual(["dismiss"]);
    pick({ action: "run", id: second?.id });
    off();
    expect(dismissed).toEqual(["dismiss", "dismiss"]);
    expect(hoisted.navigate).toHaveBeenCalledTimes(1);
    expect(hoisted.navigate.mock.calls[0]?.[0]).toBe(
      `/c/${encodeURIComponent(session.channelId)}?work=${session.sessionId}`
    );
  });

  it("보낸 적 없는 id·끝난 작업·깨진 페이로드는 아무 데도 보내지 않는다", async () => {
    hoisted.items = [run, session];
    mount();
    await act(async () => {});
    const firstId = lastStatus().running[0]?.id;
    const dismissed: string[] = [];
    const off = onEntryDismiss(() => dismissed.push("dismiss"));
    for (const bad of [
      { action: "run", id: "r99" },
      { action: "run", id: "../../settings" },
      { action: "run" },
      { action: "nope" },
      null,
      "new-message",
    ]) {
      pick(bad);
    }
    // 작업이 끝나 줄에서 빠진 뒤에 메뉴에 남아 있던 옛 줄을 누른다.
    hoisted.items = [session];
    render();
    pick({ action: "run", id: firstId });
    off();
    // 아무 데도 가지 않았으니 겹친 표면도 걷지 않는다(보이는 것을 이유 없이 닫지 않는다).
    expect(dismissed).toEqual([]);
    expect(hoisted.openWorkPanel).not.toHaveBeenCalled();
    expect(hoisted.navigate).not.toHaveBeenCalled();
    expect(hoisted.openNewDm).not.toHaveBeenCalled();
  });

  it("한 번만 보이는 값을 쥔 화면이 있으면 전역 단축키처럼 물러선다", async () => {
    hoisted.items = [session];
    mount();
    await act(async () => {});
    const id = lastStatus().running[0]?.id;
    const release = holdGlobalShortcuts();
    pick({ action: "new-message" });
    pick({ action: "run", id });
    expect(hoisted.openNewDm).not.toHaveBeenCalled();
    expect(hoisted.navigate).not.toHaveBeenCalled();
    release();
    pick({ action: "new-message" });
    expect(hoisted.openNewDm).toHaveBeenCalledTimes(1);
  });

  it("내려가면 구독을 푼다", async () => {
    mount();
    await act(async () => {});
    expect(hoisted.unlistened).toBe(0);
    act(() => root?.unmount());
    root = null;
    expect(hoisted.unlistened).toBe(1);
  });
});

describe("TrayStatus: 관제 표면 판정 (#5193)", () => {
  const lastAdeArgs = () => hoisted.adeArgs[hoisted.adeArgs.length - 1];

  // 관제 줄과 서랍은 `SurfaceGate` 뒤라 호스트가 없는 곳에서는 마운트되지 않는다. 셸에 늘 마운트된 이 컴포넌트는 같은 판정으로
  // 세션 읽기를 직접 꺼야 한다(안 그러면 호스트가 없는 워크스페이스에서도 원장을 20초마다 묻는다).
  it("관제 표면이 서 있을 때만 세션 읽기를 켠다", () => {
    hoisted.adeProvided = false;
    mount();
    expect(lastAdeArgs()).toEqual([false, false]);
    hoisted.adeProvided = true;
    render();
    expect(lastAdeArgs()).toEqual([false, true]);
  });
});

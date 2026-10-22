import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { SessionStatus } from "@momo/core/features/workbench/sessionList";
import { defaultWorkbenchLayout, focusPane, splitPane } from "@momo/core/features/workbench/layoutTree";
import { memoryLayoutStorage, readWorkbenchLayout, writeWorkbenchLayout } from "../useWorkbenchLayout";
import type { DesktopNotifyKind } from "@/features/notifications/preference";
import { createPaneAttention, focusStoredPane, type PaneObservation } from "./paneAttention";

// #2776: 「응답 필요」·「끝남」이 인박스 줄과 OS 알림으로 합류한다. 알림은 상태가
// 새로 될 때 한 번이고, 사람이 보고 있는 칸은 알리지 않는다.

function setup(
  focused = false,
  kindEnabled?: (kind: DesktopNotifyKind) => boolean,
  paused?: () => boolean
) {
  const notify = vi.fn();
  let t = 1_000;
  const store = createPaneAttention({
    notify,
    windowFocused: () => focused,
    now: () => t++,
    ...(kindEnabled ? { kindEnabled } : {}),
    ...(paused ? { paused } : {}),
  });
  const pane = (paneId: string, status: SessionStatus, index = 1): PaneObservation => ({
    paneId,
    index,
    name: "claude",
    status,
    signal: status === "waiting" ? "waiting-permission" : null,
  });
  return { store, notify, pane };
}

describe("paneAttention", () => {
  it("새로 기다림이 된 칸은 알림 한 번, 인박스 한 줄", () => {
    const { store, notify, pane } = setup();
    store.observe([pane("p1", "running")], null);
    expect(notify).not.toHaveBeenCalled();
    store.observe([pane("p1", "waiting", 3)], null);
    store.observe([pane("p1", "waiting", 3)], null);
    store.observe([pane("p1", "waiting", 3), pane("p2", "running", 4)], null);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith({
      kind: "waiting",
      title: "응답 필요",
      body: "3번 칸 · claude: 실행 허락을 기다려요",
      label: "3번 칸 · claude",
    });
    expect(store.entries().map((e) => [e.paneId, e.status])).toEqual([["p1", "waiting"]]);
  });

  it("끝남도 합류하고, 실행 중·멈춤은 아니다", () => {
    const { store, notify, pane } = setup();
    store.observe([pane("p1", "running"), pane("p2", "running")], null);
    store.observe([pane("p1", "done"), pane("p2", "stopped")], null);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith({
      kind: "done",
      title: "끝남",
      body: "1번 칸 · claude: 작업이 끝났어요",
      label: "1번 칸 · claude",
    });
    expect(store.entries().map((e) => e.paneId)).toEqual(["p1"]);
  });

  it("보고 있는 칸(창 포커스 + 활성 칸)은 알리지 않고 인박스에도 올리지 않는다", () => {
    const { store, notify, pane } = setup(true);
    store.observe([pane("p1", "running")], "p1");
    store.observe([pane("p1", "waiting")], "p1");
    expect(notify).not.toHaveBeenCalled();
    expect(store.entries()).toEqual([]);
  });

  it("종류를 끈 기기는 OS 알림만 건너뛰고 인박스 줄은 그대로 오른다 (#3339)", () => {
    const { store, notify, pane } = setup(false, (kind) => kind !== "work-mine-done");
    store.observe([pane("p1", "running"), pane("p2", "running")], null);
    store.observe([pane("p1", "done"), pane("p2", "waiting")], null);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]?.[0]).toMatchObject({ kind: "waiting" });
    expect(store.entries().map((e) => e.status).sort()).toEqual(["done", "waiting"]);
  });

  it("알림 일시 중지 중에는 OS 알림만 건너뛰고 인박스 줄은 그대로 오른다 (#4197)", () => {
    let paused = true;
    const { store, notify, pane } = setup(false, undefined, () => paused);
    store.observe([pane("p1", "running"), pane("p2", "running")], null);
    store.observe([pane("p1", "waiting"), pane("p2", "done")], null);
    // 배너는 0건이다. 인박스 줄(배지가 세는 원장)은 별개라 두 칸 다 선다 — 일시 중지는 알림을 멈출 뿐 일을 숨기지 않는다.
    expect(notify).not.toHaveBeenCalled();
    expect(store.entries().map((e) => [e.paneId, e.status]).sort()).toEqual([
      ["p1", "waiting"],
      ["p2", "done"],
    ]);
    // 풀리면 그다음 새 전이부터 다시 알린다. 일시 중지 중에 지나간 전이는 풀린 뒤에 되살리지 않는다.
    paused = false;
    store.observe([pane("p1", "waiting"), pane("p2", "done")], null);
    expect(notify).not.toHaveBeenCalled();
    store.observe([pane("p1", "running"), pane("p2", "done")], null);
    store.observe([pane("p1", "done"), pane("p2", "done")], null);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]?.[0]).toMatchObject({ kind: "done" });
  });

  it("창이 뒤에 있으면 활성 칸도 알린다", () => {
    const { store, notify, pane } = setup(false);
    store.observe([pane("p1", "running")], "p1");
    store.observe([pane("p1", "waiting")], "p1");
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("본 「끝남」, 상태가 바뀐 칸, 닫은 칸은 내리고, 본 「응답 필요」는 답할 때까지 남긴다", () => {
    const { store, pane } = setup();
    store.observe([pane("p1", "running"), pane("p2", "running"), pane("p3", "running")], null);
    store.observe([pane("p1", "waiting"), pane("p2", "done"), pane("p3", "waiting")], null);
    expect(store.entries()).toHaveLength(3);
    // p1(기다림)을 본다: 남는다. p2는 다시 실행 중: 내린다.
    store.observe([pane("p1", "waiting"), pane("p2", "running"), pane("p3", "waiting")], "p1");
    expect(store.entries().map((e) => e.paneId)).toEqual(["p1", "p3"]);
    // p1이 답을 받아 실행 중, p3 칸을 닫는다.
    store.observe([pane("p1", "running")], "p1");
    expect(store.entries()).toEqual([]);
    // 본 「끝남」은 내린다.
    store.observe([pane("p1", "done")], null);
    expect(store.entries().map((e) => e.status)).toEqual(["done"]);
    store.observe([pane("p1", "done")], "p1");
    expect(store.entries()).toEqual([]);
  });

  it("인박스에서 고른 칸이 저장된 배치의 활성 칸이 된다", () => {
    const split = splitPane(defaultWorkbenchLayout(), "p1", "row", { width: 4000, height: 4000 }).layout;
    const focused = focusPane(split, "p1");
    if (!focused.ok) throw new Error("focus");
    const layout = focused.layout;
    const storage = memoryLayoutStorage();
    writeWorkbenchLayout(storage, "dock", layout);
    expect(readWorkbenchLayout(storage, "dock").layout.focused).toBe("p1");
    expect(focusStoredPane("p2", storage, "dock")).toBe(true);
    expect(readWorkbenchLayout(storage, "dock").layout.focused).toBe("p2");
    expect(focusStoredPane("p9", storage, "dock")).toBe(false);
  });
});

describe("출처 규칙(core paneStatus.ts): 판정은 PTY 출력을 읽지 않는다 (ADR-0190 D4-b)", () => {
  const src = readFileSync(new URL("../../../../../../packages/momo-core/src/features/workbench/paneStatus.ts", import.meta.url), "utf8");

  it("판정 모듈은 생명주기(sessionList)만 import한다", () => {
    const imports = [...src.matchAll(/^import[^;]*from\s+"([^"]+)"/gm)].map((m) => m[1]);
    expect(imports).toEqual(["./sessionList"]);
  });

  it("판정 입력에 출력·제목·바이트 필드가 없다", () => {
    const body = src.slice(src.indexOf("export interface PaneStatusInput"), src.indexOf("export function derivePaneStatus"));
    expect(body).not.toMatch(/output|bytes|title|text|scrollback/i);
  });
});

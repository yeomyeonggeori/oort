import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { SessionStatus } from "@momo/core/features/workbench/sessionList";
import { defaultWorkbenchLayout, focusPane, splitPane } from "@momo/core/features/workbench/layoutTree";
import { memoryLayoutStorage, readWorkbenchLayout, writeWorkbenchLayout } from "../useWorkbenchLayout";
import type { DesktopNotifyKind } from "@/features/notifications/preference";
import { COALESCE_MS, createOsNotifier } from "@/features/notifications/osNotifier";
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

// design-review #5584 H1: 턴 실패 보고는 성공 모양(「끝남」·「작업이 끝났어요」)으로 알리지 않는다.
describe("paneAttention: 실패한 턴 (#5584 H1)", () => {
  const failed = (paneId: string, index = 3): PaneObservation => ({
    paneId,
    index,
    name: "빌드 스크립트 정리",
    status: "done",
    mark: "failed",
    signal: "turn-failed",
  });
  const finished = (paneId: string, index = 3): PaneObservation => ({ ...failed(paneId, index), mark: "done", signal: "turn-done" });
  const running = (paneId: string, index = 3): PaneObservation => ({ ...failed(paneId, index), status: "running", mark: "running", signal: "working" });

  it("알림은 「실패」·「오류로 끝났어요」 한 번, 인박스 줄의 표지도 실패", () => {
    const { store, notify } = setup();
    store.observe([running("p1")], null);
    store.observe([failed("p1")], null);
    store.observe([failed("p1")], null);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith({
      kind: "failed",
      title: "실패",
      body: "3번 칸 · 빌드 스크립트 정리: 오류로 끝났어요",
      label: "3번 칸 · 빌드 스크립트 정리",
    });
    const call = notify.mock.calls[0]![0] as { title: string; body: string };
    expect(call.title).not.toBe("끝남");
    expect(call.body).not.toContain("작업이 끝났어요");
    expect(store.entries().map((e) => [e.paneId, e.status, e.mark])).toEqual([["p1", "done", "failed"]]);
  });

  it("「끝남」 뒤에 곧바로 온 「실패」도 새로 알리고 줄을 바꾼다(실패가 묻히지 않는다)", () => {
    const { store, notify } = setup();
    store.observe([running("p1")], null);
    store.observe([finished("p1")], null);
    store.observe([failed("p1")], null);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls[1]![0]).toMatchObject({ title: "실패" });
    expect(store.entries().map((e) => e.mark)).toEqual(["failed"]);
  });

  // design-review #5584 r2 H1 (a): 1.2초 창에 함께 온 실패가 「작업 끝남 N건」으로 나갔다. 진짜 묶음(osNotifier)에
  // 이어 붙여 **보내지는 배너 원문**을 잰다: `notify`만 흉내 내면 묶음 단계가 보이지 않는다.
  describe("OS 배너 묶음(1.2초)에서도 실패는 실패다", () => {
    function wired() {
      vi.useFakeTimers();
      const send = vi.fn(async (_title: string, _body: string | undefined, _target: unknown) => true);
      const notifier = createOsNotifier({ send });
      let t = 1_000;
      const store = createPaneAttention({
        notify: (item) => notifier.offer(item),
        windowFocused: () => false,
        now: () => t++,
      });
      const banners = () => {
        vi.advanceTimersByTime(COALESCE_MS);
        return send.mock.calls.map(([title, body]) => ({ title, body }));
      };
      return { store, banners };
    }

    it("실패 + 끝남이 한 틱: 「실패」와 「끝남」 두 배너, 「작업 끝남 2건」이 아니다", () => {
      try {
        const { store, banners } = wired();
        store.observe([running("p3", 3), running("p4", 4)], null);
        store.observe([failed("p3", 3), { ...finished("p4", 4), name: "로그 회전 설정" }], null);
        const sent = banners();
        expect(sent).toHaveLength(2);
        expect(sent).toContainEqual({ title: "실패", body: "3번 칸 · 빌드 스크립트 정리: 오류로 끝났어요" });
        expect(sent).toContainEqual({ title: "끝남", body: "4번 칸 · 로그 회전 설정: 작업이 끝났어요" });
        expect(sent.map((b) => b.title)).not.toContain("작업 끝남 2건");
      } finally {
        vi.useRealTimers();
      }
    });

    it("실패 + 실패가 한 틱: 「실패 2건」, 끝남이라고 말하지 않는다", () => {
      try {
        const { store, banners } = wired();
        store.observe([running("p3", 3), running("p4", 4)], null);
        store.observe([failed("p3", 3), { ...failed("p4", 4), name: "로그 회전 설정" }], null);
        const sent = banners();
        expect(sent).toEqual([{ title: "실패 2건", body: "3번 칸 · 빌드 스크립트 정리, 4번 칸 · 로그 회전 설정" }]);
        expect(sent[0]!.title).not.toContain("끝남");
      } finally {
        vi.useRealTimers();
      }
    });

    it("실패 둘 + 끝남 하나: 실패는 「실패 2건」으로 따로 세고, 끝남은 그대로 「끝남」", () => {
      try {
        const { store, banners } = wired();
        store.observe([running("p2", 2), running("p3", 3), running("p4", 4)], null);
        store.observe([failed("p2", 2), failed("p3", 3), finished("p4", 4)], null);
        const titles = banners().map((b) => b.title).sort();
        expect(titles).toEqual(["끝남", "실패 2건"]);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("남은 「응답 필요」 줄은 기다림의 종류가 바뀌면 따라간다", () => {
    const { store, pane } = setup();
    store.observe([pane("p1", "running")], null);
    store.observe([pane("p1", "waiting")], null);
    store.observe([{ ...pane("p1", "waiting"), signal: "waiting-input" }], null);
    expect(store.entries().map((e) => e.signal)).toEqual(["waiting-input"]);
  });
});

describe("출처 규칙(core paneStatus.ts): 판정은 PTY 출력을 읽지 않는다 (ADR-0190 D4-b)", () => {
  const src = readFileSync(new URL("../../../../../../packages/momo-core/src/features/workbench/paneStatus.ts", import.meta.url), "utf8");

  it("판정 모듈은 생명주기(sessionList)와 조사 붙이기(출처 한 줄, #5584 M2)만 import한다", () => {
    const imports = [...src.matchAll(/^import[^;]*from\s+"([^"]+)"/gm)].map((m) => m[1]);
    expect(imports).toEqual(["../../lib/koreanParticle", "./sessionList"]);
  });

  it("판정 입력에 출력·제목·바이트 필드가 없다", () => {
    const body = src.slice(src.indexOf("export interface PaneStatusInput"), src.indexOf("export function derivePaneStatus"));
    expect(body).not.toMatch(/output|bytes|title|text|scrollback/i);
  });
});

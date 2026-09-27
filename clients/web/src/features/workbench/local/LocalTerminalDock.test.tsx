// @vitest-environment jsdom

import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkbenchPaneInfo } from "../WorkbenchGrid";
import { createLocalSessions, type LocalSessions, type MirrorTerminal } from "./localSessions";
import { dockSnapshot, resetDockStateForTest } from "./dockState";

// 도크의 키 경계를 실제 DOM 사건으로 잰다. 칸 안의 xterm은 같은 모양의
// 가짜(`.xterm` 안의 textarea)로 바꾼다: 여기서 재는 것은 xterm이 아니라
// 도크가 키를 누구에게 주는가다.

vi.mock("./LocalTerminalPane", () => ({
  localPaneTitle: () => "로컬 · 셸",
  runningPaneNotice: () => null,
  LocalTerminalPane: ({ pane, sessions }: { pane: WorkbenchPaneInfo; sessions: LocalSessions }) => {
    useEffect(() => {
      void sessions.ensure(pane.id, 80, 24);
    }, [pane.id, sessions]);
    return createElement(
      "div",
      { className: "xterm" },
      createElement("textarea", { "data-testid": `fake-xterm-${pane.id}`, className: "xterm-helper-textarea" })
    );
  },
}));

// 세션 목록의 git 읽기(#2855 `readWorkbenchGit`). PTY 1은 주 worktree, 2는 연결된
// worktree다. 목록이 부른 명령을 모두 적는다.
const gitCalls: string[] = [];
const GIT_WORKTREES = {
  kind: "worktrees",
  worktrees: [
    { folder: "momo", branch: "main", detached: false, locked: false, prunable: false },
    { folder: "2774-xterm", branch: "feat/2774-xterm", detached: false, locked: false, prunable: false },
  ],
};
vi.mock("@/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri")>()),
  detectLocalHarnesses: async () => [],
  readWorkbenchGit: async (command: string, ptyId: number) => {
    gitCalls.push(`${command}:${ptyId}`);
    const folder = ptyId === 1 ? "momo" : "2774-xterm";
    switch (command) {
      case "g1":
        return { outcome: "ok", value: { kind: "repo", name: folder } };
      case "g2":
        return { outcome: "ok", value: { kind: "branch", name: ptyId === 1 ? "main" : "feat/2774-xterm" } };
      case "g3":
        return { outcome: "ok", value: GIT_WORKTREES };
      case "g7":
        return ptyId === 1
          ? { outcome: "noUpstream" }
          : { outcome: "ok", value: { kind: "diff", files: [], totals: { files: 3, added: 128, deleted: 40, binary: 0 } } };
      default:
        return { outcome: "unknown" };
    }
  },
}));

const { LocalTerminalDock } = await import("./LocalTerminalDock");

function fakeSessions() {
  const kills: number[] = [];
  const mirror = (): MirrorTerminal => ({
    cols: 80,
    rows: 24,
    write: (_d, cb) => cb?.(),
    resize: () => undefined,
    dispose: () => undefined,
    onTitleChange: () => ({ dispose: () => undefined }),
  });
  let id = 1;
  const sessions = createLocalSessions({
    pty: {
      spawn: async () => id++,
      write: async () => undefined,
      resize: async () => undefined,
      kill: async (n) => void kills.push(n),
      ack: async () => undefined,
    },
    loadMirror: async () => ({ create: () => ({ mirror: mirror(), serialize: () => "" }) }),
    storage: () => null,
  });
  return { sessions, kills };
}

const reactAct = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root | null = null;
let host: HTMLElement | null = null;
let composer: HTMLTextAreaElement | null = null;
let windowKeys: string[] = [];
const onWindowKey = (event: KeyboardEvent) => windowKeys.push(`${event.metaKey ? "⌘" : ""}${event.key}`);

async function mount(sessions: LocalSessions, presentation?: "dock" | "tab") {
  host = document.createElement("main");
  document.body.append(host);
  composer = document.createElement("textarea");
  composer.setAttribute("data-testid", "composer");
  document.body.append(composer);
  root = createRoot(host);
  await act(async () => {
    root?.render(createElement(LocalTerminalDock, { sessions, platform: "mac", presentation }));
  });
}

function key(target: EventTarget, init: KeyboardEventInit) {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

function q(id: string) {
  return document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

beforeAll(() => {
  reactAct.IS_REACT_ACT_ENVIRONMENT = true;
  HTMLElement.prototype.scrollIntoView = () => undefined;
  HTMLElement.prototype.hasPointerCapture = () => false;
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});

beforeEach(() => {
  resetDockStateForTest();
  windowKeys = [];
  window.addEventListener("keydown", onWindowKey);
  try {
    window.localStorage.clear();
  } catch {
    /* jsdom storage */
  }
});

afterEach(() => {
  window.removeEventListener("keydown", onWindowKey);
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  composer?.remove();
});

describe("⌃` 도크 (ADR-0190 D5)", () => {
  it("한글 2벌식(key ₩)에서도 컴포저에서 ⌃`로 열고, 다시 누르면 닫고 캐럿을 돌려준다", async () => {
    const { sessions } = fakeSessions();
    await mount(sessions);
    composer!.focus();
    const open = key(composer!, { code: "Backquote", key: "₩", ctrlKey: true });
    expect(open.defaultPrevented).toBe(true);
    expect(dockSnapshot().open).toBe(true);
    await vi.waitFor(() => expect(q("local-terminal-dock")).not.toBeNull());
    // 컴포저에 ₩가 들어가지 않도록 창의 다른 처리기에도 가지 않는다.
    expect(windowKeys).toEqual([]);

    key(q("fake-xterm-p1") ?? document.body, { code: "Backquote", key: "₩", ctrlKey: true });
    expect(dockSnapshot().open).toBe(false);
    expect(q("local-terminal-dock")).toBeNull();
    expect(document.activeElement).toBe(composer);
  });

  it("⌃⇧`는 전체 화면으로 연다", async () => {
    const { sessions } = fakeSessions();
    await mount(sessions);
    key(document.body, { code: "Backquote", key: "~", ctrlKey: true, shiftKey: true });
    expect(dockSnapshot()).toMatchObject({ open: true, fullscreen: true });
    await vi.waitFor(() => expect(q("local-terminal-dock")?.hasAttribute("data-fullscreen")).toBe(true));
  });
});

describe("터미널 입력이 먼저", () => {
  async function openWithPane() {
    const { sessions, kills } = fakeSessions();
    await mount(sessions);
    key(document.body, { code: "Backquote", key: "`", ctrlKey: true });
    await vi.waitFor(() => expect(q("fake-xterm-p1")).not.toBeNull());
    await vi.waitFor(() => expect(sessions.getSnapshot().get("p1")?.phase).toBe("running"));
    return { sessions, kills, input: q("fake-xterm-p1")! };
  }

  it("터미널 안의 ⌘K·⌥↑·Esc는 앱 단축키 처리기에 닿지 않는다", async () => {
    const { input } = await openWithPane();
    key(input, { code: "KeyK", key: "k", metaKey: true });
    key(input, { code: "ArrowUp", key: "ArrowUp", altKey: true });
    key(input, { code: "Escape", key: "Escape" });
    expect(windowKeys).toEqual([]);
    // Esc는 도크를 닫지 않는다(vim).
    expect(dockSnapshot().open).toBe(true);
  });

  it("터미널 밖(컴포저)의 ⌘K는 그대로 앱에 간다", async () => {
    await openWithPane();
    key(composer!, { code: "KeyK", key: "k", metaKey: true });
    expect(windowKeys).toEqual(["⌘k"]);
  });

  it("터미널 안의 ⌘D는 격자가 받는다(표의 앱 키)", async () => {
    const { input } = await openWithPane();
    const event = key(input, { code: "KeyD", key: "ㅇ", metaKey: true });
    // jsdom에는 크기가 없어 격자가 「좁다」고 거부한다. 거부 문구가 떴다는 것이
    // 격자가 키를 받았다는 증거다.
    expect(event.defaultPrevented).toBe(true);
    await vi.waitFor(() =>
      expect(q("workbench-status")?.textContent).toContain("칸이 좁아 더 나눌 수 없습니다")
    );
  });

  it("⌘W는 실행 중인 칸을 바로 닫지 않고 확인을 받는다. 확인하면 프로세스를 끝내고 도크를 닫는다", async () => {
    const { input, kills } = await openWithPane();
    key(input, { code: "KeyW", key: "w", metaKey: true });
    await vi.waitFor(() => expect(q("local-terminal-close-confirm")).not.toBeNull());
    expect(kills).toEqual([]);
    act(() => q("local-terminal-close-confirm-ok")!.click());
    expect(kills).toEqual([1]);
    expect(dockSnapshot().open).toBe(false);
  });

  it("⌃⇧J는 기다리는 칸이 없다고 말한다", async () => {
    const { input } = await openWithPane();
    key(input, { code: "KeyJ", key: "J", ctrlKey: true, shiftKey: true });
    await vi.waitFor(() =>
      expect(q("workbench-notice")?.textContent).toBe("나를 기다리는 칸이 없습니다.")
    );
  });
});

describe("「내 작업」 탭 (#2854)", () => {
  it("도크가 닫혀 있어도 격자를 그리고, 도크 여닫이 단추 없이 제목이 「내 작업」이다", async () => {
    const { sessions } = fakeSessions();
    await mount(sessions, "tab");
    expect(dockSnapshot().open).toBe(false);
    await vi.waitFor(() => expect(q("fake-xterm-p1")).not.toBeNull());
    expect(q("my-work-tab")?.querySelector("h1")?.textContent).toBe("내 작업");
    expect(q("local-terminal-dock")).toBeNull();
    expect(q("local-terminal-fullscreen")).toBeNull();
    expect(q("local-terminal-dock-close")).toBeNull();
    // 세션 목록(#2856)이 펴져 있으면 「새 세션」은 목록 바닥에 있다(시안 ① `.newbtn`).
    expect(q("session-list-new")).not.toBeNull();
    expect(q("local-terminal-new")).toBeNull();
  });

  it("⌃`·⌃⇧`는 탭에서 도크를 열지 않는다(같은 칸이 두 번 붙지 않는다). 키는 터미널에 새지 않는다", async () => {
    const { sessions } = fakeSessions();
    await mount(sessions, "tab");
    await vi.waitFor(() => expect(q("fake-xterm-p1")).not.toBeNull());
    const toggle = key(q("fake-xterm-p1")!, { code: "Backquote", key: "`", ctrlKey: true });
    const full = key(document.body, { code: "Backquote", key: "~", ctrlKey: true, shiftKey: true });
    expect(toggle.defaultPrevented).toBe(true);
    expect(full.defaultPrevented).toBe(true);
    expect(dockSnapshot()).toMatchObject({ open: false, fullscreen: false });
  });

  it("마지막 칸을 닫아도 탭은 닫히지 않고 빈 칸 하나로 돌아간다. 도크 상태도 건드리지 않는다", async () => {
    const { sessions, kills } = fakeSessions();
    // 도크가 열린 채로 들어온 경우: 탭이 closeDock()을 부르면 여기서 false가 된다
    // (검수 #2927 N1 — 닫힌 도크로 시작하면 이 단정은 공허하다).
    resetDockStateForTest({ open: true });
    await mount(sessions, "tab");
    await vi.waitFor(() => expect(sessions.getSnapshot().get("p1")?.phase).toBe("running"));
    key(q("fake-xterm-p1")!, { code: "KeyW", key: "w", metaKey: true });
    await vi.waitFor(() => expect(q("local-terminal-close-confirm")).not.toBeNull());
    act(() => q("local-terminal-close-confirm-ok")!.click());
    expect(kills).toEqual([1]);
    expect(q("my-work-tab")).not.toBeNull();
    expect(dockSnapshot().open).toBe(true);
  });
});

describe("도는 칸 알림은 격자 상태 줄로 (R5 B-1)", () => {
  it("입력 거부가 저장 실패보다 먼저, 칸 번호와 함께", async () => {
    const { runningPaneNotice } = await vi.importActual<typeof import("./LocalTerminalPane")>("./LocalTerminalPane");
    const base = { program: { kind: "shell" as const }, title: null, exit: null, error: null, restored: false };
    const views = new Map([
      ["p1", { ...base, paneId: "p1", phase: "running" as const, inputNotice: null, storageFailed: true }],
      ["p2", { ...base, paneId: "p2", phase: "running" as const, inputNotice: "보내지 못했습니다.", storageFailed: false }],
      ["p3", { ...base, paneId: "p3", phase: "exited" as const, inputNotice: "x", storageFailed: true }],
    ]);
    expect(runningPaneNotice(views, ["p1", "p2", "p3"])).toBe("2번 칸: 보내지 못했습니다.");
    views.delete("p2");
    expect(runningPaneNotice(views, ["p1", "p3"])).toMatch(/^1번 칸의 화면을 저장하지 못했습니다/);
    expect(runningPaneNotice(new Map(), [])).toBeNull();
  });
});

// 두 칸(p1 | p2) 배치를 미리 둔다. jsdom에는 크기가 없어 ⌘D 분할이 거부된다.
function seedTwoPanes() {
  window.localStorage.setItem(
    "momo.web.workbench.layout.v1:dock",
    JSON.stringify({
      v: 1,
      root: {
        kind: "split",
        id: "s1",
        axis: "row",
        ratio: 0.5,
        first: { kind: "pane", id: "p1" },
        second: { kind: "pane", id: "p2" },
      },
      focused: "p1",
      maximized: null,
      seq: 3,
    })
  );
}

function rows() {
  return [...document.querySelectorAll<HTMLElement>("[data-testid='session-list-row']")];
}

describe("세션 목록 (#2856)", () => {
  beforeEach(() => {
    gitCalls.length = 0;
  });

  async function mountTwo() {
    seedTwoPanes();
    const { sessions } = fakeSessions();
    await mount(sessions, "tab");
    await vi.waitFor(() => expect(q("fake-xterm-p2")).not.toBeNull());
    await vi.waitFor(() => expect(rows()).toHaveLength(2));
    await vi.waitFor(() => expect(q("session-list")?.textContent).toContain("feat/2774-xterm"));
    return { sessions };
  }

  it("저장소 하나 → 머리 없음, worktree마다 세션 하나 → 평탄화, diff는 G7만. git 읽기는 G1·G2·G3·G7뿐", async () => {
    await mountTwo();
    expect(q("session-list-group")).toBeNull();
    expect(document.querySelectorAll("[data-testid='session-list-worktree']")).toHaveLength(0);
    const [first, second] = rows();
    expect(first!.textContent).toContain("main");
    expect(first!.textContent).toContain("기본");
    expect(second!.textContent).toContain("feat/2774-xterm");
    expect(second!.textContent).toContain("+128");
    expect(second!.textContent).toContain("−40");
    // 기준점이 없는 주 worktree에는 숫자가 없다.
    expect(first!.textContent).not.toMatch(/[+−]\d/);
    expect(q("session-list-repo")?.textContent).toContain("momo");
    expect(q("session-list-repo")?.textContent).toContain("2 worktree · 2 세션");
    expect(new Set(gitCalls.map((c) => c.split(":")[0]))).toEqual(new Set(["g1", "g2", "g3", "g7"]));
  });

  it("⌘J는 목록의 지금 칸 행으로, ↓와 ⌃2는 칸 2로 간다", async () => {
    await mountTwo();
    key(document.body, { code: "KeyJ", key: "j", metaKey: true });
    await vi.waitFor(() => expect(document.activeElement?.getAttribute("data-session-pane")).toBe("p1"));
    key(document.activeElement!, { code: "ArrowDown", key: "ArrowDown" });
    expect(document.activeElement?.getAttribute("data-session-pane")).toBe("p2");
    key(document.activeElement!, { code: "Digit2", key: "2", ctrlKey: true });
    await vi.waitFor(() => expect(document.activeElement).toBe(q("fake-xterm-p2")));
    expect(rows()[1]!.getAttribute("aria-current")).toBe("true");
    expect(rows()[0]!.hasAttribute("aria-current")).toBe(false);
  });

  it("행을 누르면 그 칸으로, 두 번 누르면 최대화", async () => {
    await mountTwo();
    act(() => rows()[1]!.click());
    await vi.waitFor(() => expect(document.activeElement).toBe(q("fake-xterm-p2")));
    act(() => {
      rows()[1]!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    await vi.waitFor(() =>
      expect(document.querySelector("[data-pane-id='p2']")?.hasAttribute("data-maximized")).toBe(true)
    );
  });

  it("필터 「나를 기다림」은 한 줄 + 「전부 보기」, 묶기 선택은 기억한다", async () => {
    await mountTwo();
    act(() => q("session-list-filter-waiting")!.click());
    expect(q("session-list-empty")?.textContent).toContain("나를 기다리는 세션이 없습니다.");
    expect(q("session-list-filter-waiting")?.getAttribute("aria-pressed")).toBe("true");
    act(() => q("session-list-show-all")!.click());
    expect(rows()).toHaveLength(2);
    expect(JSON.parse(window.localStorage.getItem("momo.web.workbench.sessionList.v1") ?? "{}")).toMatchObject({
      filter: "all",
    });
  });

  it("목록을 접으면 머리 줄에 펴기와 「새 세션」, ⌘J는 다시 펴고 행으로 간다", async () => {
    await mountTwo();
    act(() => q("session-list-collapse")!.click());
    expect(q("session-list")).toBeNull();
    expect(q("session-list-expand")).not.toBeNull();
    expect(q("local-terminal-new")).not.toBeNull();
    // 「내 작업」에서 ⌘J는 목록으로 간다. ⌘J를 내건 칸 목록 단추는 도크에만 있다(design-review H2).
    expect(q("local-terminal-jump")).toBeNull();
    expect(document.querySelectorAll("[aria-keyshortcuts='Meta+J']")).toHaveLength(1);
    // 접기는 기억하고, 펴기는 이번 실행에만 기억한다(M3).
    expect(window.localStorage.getItem("momo.web.workbench.sessionList.open.v1")).toBe("closed");
    key(document.body, { code: "KeyJ", key: "j", metaKey: true });
    await vi.waitFor(() => expect(q("session-list")).not.toBeNull());
    await vi.waitFor(() => expect(document.activeElement?.getAttribute("data-session-row")).toBe(""));
    expect(window.localStorage.getItem("momo.web.workbench.sessionList.open.v1")).toBeNull();
  });

});

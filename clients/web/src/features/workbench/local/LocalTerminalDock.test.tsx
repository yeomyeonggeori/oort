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

vi.mock("@/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri")>()),
  detectLocalHarnesses: async () => [],
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

async function mount(sessions: LocalSessions) {
  host = document.createElement("main");
  document.body.append(host);
  composer = document.createElement("textarea");
  composer.setAttribute("data-testid", "composer");
  document.body.append(composer);
  root = createRoot(host);
  await act(async () => {
    root?.render(createElement(LocalTerminalDock, { sessions, platform: "mac" }));
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

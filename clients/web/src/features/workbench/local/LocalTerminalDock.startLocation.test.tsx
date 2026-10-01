// @vitest-environment jsdom

import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalHarnessProbe } from "@momo/core/features/hostedAgents/detect";
import type { PtySpawnRequest } from "@/lib/tauri";
import { writeAiDefaults } from "@/features/settings/aiDefaultsStore";
import type { WorkbenchPaneInfo } from "../WorkbenchGrid";
import { createLocalSessions, type LocalSessions, type MirrorTerminal } from "./localSessions";
import { resetDockStateForTest } from "./dockState";
import {
  START_STORAGE_KEY,
  readStartState,
  type StartFolder,
  type StartState,
  type StartStorage,
} from "./startLocation";

// #2775: 새 세션 메뉴의 시작 위치(최근 프로젝트 · 폴더 고르기 · 홈에서 시작)와
// worktree 격리(기본 끔, git 저장소에서만). 셸에 무엇을 요청했는지(`pty.spawn`의
// cwd)와 worktree 생성 호출을 잰다.

vi.mock("./LocalTerminalPane", () => ({
  HARNESS_LABEL: { claude: "Claude Code", codex: "Codex", grok: "Grok" },
  localPaneTitle: () => "로컬 · 셸",
  runningPaneNotice: () => null,
  LocalTerminalPane: ({ pane, sessions }: { pane: WorkbenchPaneInfo; sessions: LocalSessions }) => {
    useEffect(() => {
      void sessions.ensure(pane.id, 80, 24);
    }, [pane.id, sessions]);
    return createElement("div", { className: "xterm" });
  },
}));

vi.mock("@/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri")>()),
  detectLocalHarnesses: async (): Promise<LocalHarnessProbe[]> => [
    { id: "claude", installed: true, auth: "logged_in" },
  ],
  harnessProfileList: async () => [],
  readWorkbenchGit: async () => ({ outcome: "unknown" }),
}));

const { LocalTerminalDock } = await import("./LocalTerminalDock");

const HOME_PLAIN: StartFolder = { path: "/Users/t/notes", name: "notes", repo: "none" };
const REPO: StartFolder = { path: "/Users/t/projects/oort", name: "oort", repo: "ready" };
const EMPTY_REPO: StartFolder = { path: "/Users/t/projects/fresh", name: "fresh", repo: "empty" };

function fakeSessions() {
  const spawns: PtySpawnRequest[] = [];
  const worktrees: string[] = [];
  let failWorktree: string | null = null;
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
      spawn: async (request) => {
        spawns.push(request);
        return id++;
      },
      write: async () => undefined,
      resize: async () => undefined,
      kill: async () => undefined,
      ack: async () => undefined,
    },
    worktree: async (repo) => {
      worktrees.push(repo);
      if (failWorktree !== null) throw new Error(failWorktree);
      return { path: "/Users/t/.oort/worktrees/oort/wt-1a2b3c4d" };
    },
    loadMirror: async () => ({ create: () => ({ mirror: mirror(), serialize: () => "" }) }),
    storage: () => null,
  });
  return {
    sessions,
    spawns,
    worktrees,
    failWorktreeWith: (message: string) => {
      failWorktree = message;
    },
  };
}

function memoryStorage(initial?: StartState): StartStorage & { value: () => StartState } {
  const map = new Map<string, string>();
  if (initial) map.set(START_STORAGE_KEY, JSON.stringify(initial));
  const storage: StartStorage = {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
  };
  return Object.assign(storage, { value: () => readStartState(storage) });
}

const reactAct = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root | null = null;
let host: HTMLElement | null = null;

function q(id: string) {
  return document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}
function all(id: string) {
  return [...document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
}

type StartSource = NonNullable<Parameters<typeof LocalTerminalDock>[0]["startSource"]>;

async function mount(sessions: LocalSessions, startSource: StartSource) {
  host = document.createElement("main");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      createElement(LocalTerminalDock, { sessions, platform: "mac", presentation: "tab", startSource })
    );
  });
}

async function openMenu() {
  const trigger = await vi.waitFor(() => {
    const found = q("session-list-new") ?? q("local-terminal-new");
    expect(found).not.toBeNull();
    return found!;
  });
  await act(async () => {
    trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
    trigger.click();
  });
  await vi.waitFor(() => expect(q("local-terminal-start-home")).not.toBeNull());
}

/** 메뉴 항목을 눌러 새 칸이 PTY를 하나 더 띄울 때까지 기다리고, 그 요청을 돌려준다. */
async function launch(spawns: PtySpawnRequest[], testId: string) {
  // 「내 작업」 탭은 첫 칸을 스스로 띄운다(홈의 셸). 그것이 끝난 뒤부터 센다.
  await vi.waitFor(() => expect(spawns.length).toBeGreaterThanOrEqual(1));
  const before = spawns.length;
  await act(async () => q(testId)!.click());
  await vi.waitFor(() => expect(spawns.length).toBe(before + 1));
  return spawns[spawns.length - 1]!;
}

const never = async () => {
  throw new Error("not used");
};

beforeAll(() => {
  reactAct.IS_REACT_ACT_ENVIRONMENT = true;
  HTMLElement.prototype.scrollIntoView = () => undefined;
  HTMLElement.prototype.hasPointerCapture = () => false;
  HTMLElement.prototype.setPointerCapture = () => undefined;
  HTMLElement.prototype.releasePointerCapture = () => undefined;
  if (typeof globalThis.PointerEvent === "undefined") {
    globalThis.PointerEvent = class PointerEvent extends MouseEvent {
      constructor(type: string, init?: MouseEventInit) {
        super(type, init);
      }
    } as unknown as typeof PointerEvent;
  }
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
  try {
    window.localStorage.clear();
  } catch {
    /* jsdom storage */
  }
  writeAiDefaults({});
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
});

describe("새 세션의 시작 위치 (#2775)", () => {
  it("메뉴에 홈에서 시작 · 최근 프로젝트 · 폴더 고르기를 보인다", async () => {
    const { sessions } = fakeSessions();
    const storage = memoryStorage({ choice: { kind: "home" }, recent: [REPO, HOME_PLAIN] });
    await mount(sessions, { pick: async () => null, inspect: never, storage });
    await openMenu();
    expect(q("local-terminal-start-home")?.textContent).toContain("홈에서 시작");
    expect(q("local-terminal-start-pick")?.textContent).toContain("폴더 고르기…");
    expect(document.body.textContent).toContain("최근 프로젝트");
    expect(all("local-terminal-start-recent").map((e) => e.textContent)).toEqual([
      expect.stringContaining("oort"),
      expect.stringContaining("notes"),
    ]);
    // 처음 쓰는 기기는 홈이 기본이다.
    expect(q("local-terminal-start-home")?.getAttribute("aria-checked")).toBe("true");
  });

  it("처음에는 홈에서 시작한다: cwd를 보내지 않는다", async () => {
    const { sessions, spawns } = fakeSessions();
    await mount(sessions, { pick: async () => null, inspect: never, storage: memoryStorage() });
    await openMenu();
    expect(all("local-terminal-start-recent")).toHaveLength(0);
    const request = await launch(spawns, "local-terminal-new-shell");
    expect(request).not.toHaveProperty("cwd");
  });

  it("마지막에 쓴 폴더가 기본이고, 그 폴더가 cwd로 간다", async () => {
    const { sessions, spawns } = fakeSessions();
    const storage = memoryStorage({ choice: { kind: "folder", folder: HOME_PLAIN }, recent: [HOME_PLAIN] });
    await mount(sessions, { pick: async () => null, inspect: async () => HOME_PLAIN, storage });
    await openMenu();
    expect(
      all("local-terminal-start-recent")[0]?.getAttribute("aria-checked")
    ).toBe("true");
    const request = await launch(spawns, "local-terminal-new-shell");
    expect(request.cwd).toBe(HOME_PLAIN.path);
    expect(request.program).toEqual({ kind: "shell" });
  });

  it("최근 프로젝트를 고르면 그 폴더가 새 기본이 되어 이 기기에 저장된다", async () => {
    const { sessions, spawns } = fakeSessions();
    const storage = memoryStorage({ choice: { kind: "home" }, recent: [HOME_PLAIN, REPO] });
    await mount(sessions, { pick: async () => null, inspect: async (p) => (p === REPO.path ? REPO : HOME_PLAIN), storage });
    await openMenu();
    await act(async () => all("local-terminal-start-recent")[1]!.click());
    // 메뉴는 열린 채로 고른 위치가 바뀐다(다음에 하네스를 고른다).
    expect(q("local-terminal-new-claude")).not.toBeNull();
    expect(q("local-terminal-start-label")?.textContent).toContain("oort");
    expect(storage.value().choice).toEqual({ kind: "folder", folder: REPO });
    const request = await launch(spawns, "local-terminal-new-claude");
    expect(request.cwd).toBe(REPO.path);
    expect(request.program).toEqual({ kind: "harness", id: "claude" });
    // 쓴 폴더가 최근 맨 앞으로 온다.
    expect(storage.value().recent[0]).toEqual(REPO);
  });

  it("폴더 고르기는 셸의 대화상자를 부르고, 고른 폴더가 기본·최근이 된다. 취소는 아무 일도 아니다", async () => {
    const { sessions, spawns } = fakeSessions();
    const storage = memoryStorage();
    const pick = vi.fn<() => Promise<StartFolder | null>>().mockResolvedValueOnce(null).mockResolvedValueOnce(HOME_PLAIN);
    await mount(sessions, { pick, inspect: async () => HOME_PLAIN, storage });
    await openMenu();
    await act(async () => q("local-terminal-start-pick")!.click());
    expect(pick).toHaveBeenCalledTimes(1);
    expect(storage.value().choice).toEqual({ kind: "home" });
    await act(async () => q("local-terminal-start-pick")!.click());
    expect(pick).toHaveBeenCalledTimes(2);
    expect(storage.value().choice).toEqual({ kind: "folder", folder: HOME_PLAIN });
    expect(storage.value().recent).toEqual([HOME_PLAIN]);
    const request = await launch(spawns, "local-terminal-new-shell");
    expect(request.cwd).toBe(HOME_PLAIN.path);
  });

  it("폴더 고르기가 거부되면 이유를 한 줄로 말하고 위치는 그대로다", async () => {
    const { sessions } = fakeSessions();
    const storage = memoryStorage();
    const pick = async () => {
      throw new Error("refused: folder is outside the home directory");
    };
    await mount(sessions, { pick, inspect: never, storage });
    await openMenu();
    await act(async () => q("local-terminal-start-pick")!.click());
    await vi.waitFor(() =>
      expect(q("workbench-notice")?.textContent ?? "").toContain("홈 폴더 안의 폴더만 고를 수 있어요")
    );
    expect(storage.value().choice).toEqual({ kind: "home" });
  });

  it("고른 폴더가 사라졌으면 홈으로 돌아가고 한 줄로 말한다", async () => {
    const { sessions, spawns } = fakeSessions();
    const storage = memoryStorage({ choice: { kind: "folder", folder: HOME_PLAIN }, recent: [HOME_PLAIN, REPO] });
    const inspect = async () => {
      throw new Error("refused: folder does not exist");
    };
    await mount(sessions, { pick: async () => null, inspect, storage });
    await vi.waitFor(() =>
      expect(q("workbench-notice")?.textContent ?? "").toContain("홈에서 시작해요")
    );
    expect(storage.value().choice).toEqual({ kind: "home" });
    expect(storage.value().recent).toEqual([REPO]);
    await openMenu();
    const request = await launch(spawns, "local-terminal-new-shell");
    expect(request).not.toHaveProperty("cwd");
  });
});

describe("worktree 격리 (#2775)", () => {
  const checkbox = () => q("local-terminal-start-worktree");

  it("기본은 끔이고, 홈에서는 이유와 함께 쓸 수 없다", async () => {
    const { sessions } = fakeSessions();
    await mount(sessions, { pick: async () => null, inspect: never, storage: memoryStorage() });
    await openMenu();
    expect(checkbox()?.textContent).toContain("새 worktree에서 격리");
    expect(checkbox()?.getAttribute("aria-checked")).toBe("false");
    expect(checkbox()?.getAttribute("aria-disabled")).toBe("true");
    expect(q("local-terminal-start-worktree-note")?.textContent).toBe("홈에서는 쓸 수 없어요");
  });

  it("git 저장소가 아닌 폴더에서는 이유와 함께 쓸 수 없다", async () => {
    const { sessions } = fakeSessions();
    const storage = memoryStorage({ choice: { kind: "folder", folder: HOME_PLAIN }, recent: [HOME_PLAIN] });
    await mount(sessions, { pick: async () => null, inspect: async () => HOME_PLAIN, storage });
    await openMenu();
    expect(checkbox()?.getAttribute("aria-disabled")).toBe("true");
    expect(q("local-terminal-start-worktree-note")?.textContent).toBe("git 저장소를 고르면 켤 수 있어요");
  });

  it("커밋이 없는 저장소는 이유와 함께 쓸 수 없다", async () => {
    const { sessions } = fakeSessions();
    const storage = memoryStorage({ choice: { kind: "folder", folder: EMPTY_REPO }, recent: [EMPTY_REPO] });
    await mount(sessions, { pick: async () => null, inspect: async () => EMPTY_REPO, storage });
    await openMenu();
    expect(checkbox()?.getAttribute("aria-disabled")).toBe("true");
    expect(q("local-terminal-start-worktree-note")?.textContent).toBe("아직 커밋이 없어서 쓸 수 없어요");
  });

  it("git 저장소에서는 켤 수 있지만 기본은 끄고, 끈 채로 열면 worktree를 만들지 않는다", async () => {
    const { sessions, spawns, worktrees } = fakeSessions();
    const storage = memoryStorage({ choice: { kind: "folder", folder: REPO }, recent: [REPO] });
    await mount(sessions, { pick: async () => null, inspect: async () => REPO, storage });
    await openMenu();
    expect(checkbox()?.getAttribute("aria-disabled")).toBeNull();
    expect(checkbox()?.getAttribute("aria-checked")).toBe("false");
    const request = await launch(spawns, "local-terminal-new-shell");
    expect(worktrees).toEqual([]);
    expect(request.cwd).toBe(REPO.path);
  });

  it("켜고 열면 먼저 worktree를 만들고 그 폴더에서 띄운다. 쓴 뒤에는 다시 꺼진다", async () => {
    const { sessions, spawns, worktrees } = fakeSessions();
    const storage = memoryStorage({ choice: { kind: "folder", folder: REPO }, recent: [REPO] });
    await mount(sessions, { pick: async () => null, inspect: async () => REPO, storage });
    await openMenu();
    await act(async () => checkbox()!.click());
    expect(checkbox()?.getAttribute("aria-checked")).toBe("true");
    const request = await launch(spawns, "local-terminal-new-shell");
    expect(worktrees).toEqual([REPO.path]);
    expect(request.cwd).toBe("/Users/t/.oort/worktrees/oort/wt-1a2b3c4d");
    await openMenu();
    expect(checkbox()?.getAttribute("aria-checked")).toBe("false");
  });

  it("worktree를 못 만들면 원래 폴더로 몰래 가지 않고, 칸이 이유를 말한다", async () => {
    const { sessions, spawns, failWorktreeWith } = fakeSessions();
    failWorktreeWith("worktree_failed: no commit yet");
    const storage = memoryStorage({ choice: { kind: "folder", folder: REPO }, recent: [REPO] });
    await mount(sessions, { pick: async () => null, inspect: async () => REPO, storage });
    await vi.waitFor(() => expect(spawns.length).toBeGreaterThanOrEqual(1));
    const before = spawns.length;
    await openMenu();
    await act(async () => checkbox()!.click());
    await act(async () => q("local-terminal-new-shell")!.click());
    await vi.waitFor(() =>
      expect([...sessions.getSnapshot().values()].some((v) => v.phase === "failed")).toBe(true)
    );
    expect(spawns.length).toBe(before);
    const failed = [...sessions.getSnapshot().values()].find((v) => v.phase === "failed")!;
    expect(failed.error).toBe("worktree_failed: no commit yet");
  });
});

describe("클라우드 안내 (#3278)", () => {
  it("연결된 곳이 없으면 가짜 항목 없이 안내 한 줄만 보인다", async () => {
    const { sessions } = fakeSessions();
    await mount(sessions, { pick: async () => null, inspect: never, storage: memoryStorage() });
    await openMenu();
    expect(q("local-terminal-cloud-hint")?.textContent).toBe("다른 기기·클라우드는 연결되면 나타나요");
    expect(q("local-terminal-open-agent")).toBeNull();
  });
});

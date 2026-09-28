// @vitest-environment jsdom

import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalHarnessProbe } from "@momo/core/features/hostedAgents/detect";
import { resolveRow, type AiDefaultsAccount } from "@momo/core/features/settings/aiDefaults";
import type { HarnessProfileRef } from "@momo/core/features/settings/harnessProfiles";
import type { PtyProgram } from "@/lib/tauri";
import { writeAiDefaults } from "@/features/settings/aiDefaultsStore";
import type { WorkbenchPaneInfo } from "../WorkbenchGrid";
import { createLocalSessions, type LocalSessions, type MirrorTerminal } from "./localSessions";
import { resetDockStateForTest } from "./dockState";

// #3010: 새 세션 메뉴의 하네스가 기본 AI 표의 「로컬 터미널 새 세션」 계정으로 뜬다.
// 계정을 지금 쓸 수 없으면 조용히 다른 계정으로 넘어가지 않고, 표와 같은 문장을
// 보이며 셸을 띄운다. 셸에 무엇을 요청했는지(`pty.spawn`의 program)를 잰다.

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

let probes: LocalHarnessProbe[] = [];
let profiles: HarnessProfileRef[] = [];
let profileAuth: LocalHarnessProbe["auth"] = "logged_in";
const statusCalls: string[] = [];
vi.mock("@/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri")>()),
  detectLocalHarnesses: async () => probes,
  harnessProfileList: async () => profiles,
  harnessProfileStatus: async (profile: HarnessProfileRef) => {
    statusCalls.push(`${profile.harness}/${profile.label}`);
    return { id: profile.harness, installed: true, auth: profileAuth };
  },
  readWorkbenchGit: async () => ({ outcome: "unknown" }),
}));

const { LocalTerminalDock } = await import("./LocalTerminalDock");

function fakeSessions() {
  const programs: PtyProgram[] = [];
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
        programs.push(request.program);
        return id++;
      },
      write: async () => undefined,
      resize: async () => undefined,
      kill: async () => undefined,
      ack: async () => undefined,
    },
    loadMirror: async () => ({ create: () => ({ mirror: mirror(), serialize: () => "" }) }),
    storage: () => null,
  });
  return { sessions, programs };
}

const reactAct = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root | null = null;
let host: HTMLElement | null = null;

function q(id: string) {
  return document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

async function mount(sessions: LocalSessions) {
  host = document.createElement("main");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(createElement(LocalTerminalDock, { sessions, platform: "mac", presentation: "tab" }));
  });
}

async function openMenu() {
  // 「내 작업」 탭에서는 세션 목록 머리의 「새 세션」이 같은 메뉴를 연다.
  const trigger = await vi.waitFor(() => {
    const found = q("session-list-new") ?? q("local-terminal-new");
    expect(found).not.toBeNull();
    return found!;
  });
  await act(async () => {
    trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
    trigger.click();
  });
  await vi.waitFor(() => expect(q("local-terminal-new-claude")).not.toBeNull());
}

async function pickClaude(programs: PtyProgram[]) {
  const before = programs.length;
  await openMenu();
  await act(async () => q("local-terminal-new-claude")!.click());
  await vi.waitFor(() => expect(programs.length).toBe(before + 1));
  return programs[programs.length - 1];
}

/** 표가 같은 입력에서 말하는 문장. 도크의 알림은 이것과 한 글자까지 같아야 한다. */
function tableSentence(accounts: AiDefaultsAccount[]): string {
  const resolved = resolveRow(
    "localTerminal",
    { localTerminal: { kind: "profile", harness: "claude", label: "개인" } },
    { accounts, teamKey: { status: "loading" }, browserTab: false }
  );
  if (resolved.state === "ok") throw new Error("expected a fallback");
  return resolved.sentence;
}

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
  probes = [{ id: "claude", installed: true, auth: "logged_in" }];
  profiles = [{ harness: "claude", label: "개인" }];
  profileAuth = "logged_in";
  statusCalls.length = 0;
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
});

describe("로컬 터미널 새 세션이 기본 AI 선택을 따른다 (#3010)", () => {
  it("고른 계정이 있으면 그 프로필로 띄우고, 메뉴에 계정 이름을 보인다", async () => {
    writeAiDefaults({ localTerminal: { kind: "profile", harness: "claude", label: "개인" } });
    const { sessions, programs } = fakeSessions();
    await mount(sessions);
    await openMenu();
    expect(q("local-terminal-new-claude-account")?.textContent).toBe("개인");
    await act(async () => q("local-terminal-new-claude")!.click());
    await vi.waitFor(() => expect(programs).toContainEqual({ kind: "harness", id: "claude", profile: "개인" }));
    expect(statusCalls).toEqual(["claude/개인"]);
    expect(q("workbench-notice")?.textContent ?? "").not.toContain("넘어가요");
  });

  it("고르지 않았으면 이 맥의 기본 로그인으로 띄운다(프로필 없음)", async () => {
    const { sessions, programs } = fakeSessions();
    await mount(sessions);
    expect(await pickClaude(programs)).toEqual({ kind: "harness", id: "claude" });
    expect(statusCalls).toEqual([]);
  });

  it("고른 계정이 목록에서 사라졌으면 기본 로그인으로 넘어가지 않고, 표와 같은 문장과 함께 셸을 띄운다", async () => {
    writeAiDefaults({ localTerminal: { kind: "profile", harness: "claude", label: "개인" } });
    profiles = [];
    const { sessions, programs } = fakeSessions();
    await mount(sessions);
    const picked = await pickClaude(programs);
    expect(picked).toEqual({ kind: "shell" });
    expect(programs.some((p) => p.kind === "harness")).toBe(false);
    const sentence = tableSentence([{ harness: "claude", label: null, auth: "logged_in" }]);
    expect(sentence).toContain("목록에 없어");
    await vi.waitFor(() => expect(q("workbench-notice")?.textContent).toBe(sentence));
  });

  it("고른 계정이 로그인 필요면 셸을 띄우고 표와 같은 문장을 보인다", async () => {
    writeAiDefaults({ localTerminal: { kind: "profile", harness: "claude", label: "개인" } });
    profileAuth = "needs_login";
    const { sessions, programs } = fakeSessions();
    await mount(sessions);
    expect(await pickClaude(programs)).toEqual({ kind: "shell" });
    const sentence = tableSentence([
      { harness: "claude", label: null, auth: "unknown" },
      { harness: "claude", label: "개인", auth: "needs_login" },
    ]);
    expect(sentence).toContain("로그인 필요");
    await vi.waitFor(() => expect(q("workbench-notice")?.textContent).toBe(sentence));
  });
});

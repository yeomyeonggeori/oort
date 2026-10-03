// @vitest-environment jsdom

import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { mountSidebarBodySlotForTest } from "@/features/sidebar/sidebarBodySlot";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalWorkHostStatus } from "@momo/core/features/settings/thisMacHost";
import type { WorkbenchPaneInfo } from "../WorkbenchGrid";
import { createLocalSessions, type LocalSessions, type MirrorTerminal } from "./localSessions";
import { resetDockStateForTest } from "./dockState";
import { createPaneShare, type PaneShareDeps } from "./share/paneShare";
import { rememberChannelFor, type RepoChannelStorage } from "./share/repoChannelStore";
import type { PaneShareSource } from "./share/paneShareSource";

// #2867 「채널에 공유」 화면: 칸 머리 메뉴·세션 목록 행 메뉴·공유 창. 서버는 가짜(deps)이고,
// 칸·세션 관리자·수집기·컨트롤러는 진짜다.

vi.mock("./LocalTerminalPane", () => ({
  HARNESS_LABEL: { claude: "Claude Code" },
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
  detectLocalHarnesses: async () => [],
  harnessProfileList: async () => [],
  readWorkbenchGit: async (command: string) =>
    command === "g1" ? { outcome: "ok", value: { kind: "repo", name: "oort" } } : { outcome: "unknown" },
}));

const { LocalTerminalDock } = await import("./LocalTerminalDock");

const WS = "00000000-0000-7000-8000-000000000001";
const HOST = "00000000-0000-7000-8000-0000000000aa";
const SESSION = "00000000-0000-7000-8000-0000000000b1";
const CH_WORKBENCH = "00000000-0000-7000-8000-000000000201";
const CH_LAB = "00000000-0000-7000-8000-000000000202";
const CHANNELS = [
  { id: CH_WORKBENCH, name: "workbench", kind: "public" as const },
  { id: CH_LAB, name: "agent-lab", kind: "private" as const },
];
const REGISTERED: LocalWorkHostStatus = {
  sidecar: true,
  registered: { hostId: HOST, workspaceId: WS, ownerMemberId: "m", serverUrl: "https://team.example" },
  running: true,
  heartbeat: { lastOkAtMs: 1, failing: false },
  adapters: [],
  workFolder: "/x",
  displayNameSuggestion: "Mac",
};

function memoryStorage(): RepoChannelStorage {
  const map = new Map<string, string>();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) };
}

function rig(over: { host?: LocalWorkHostStatus | null; remember?: string } = {}) {
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
      kill: async () => undefined,
      ack: async () => undefined,
    },
    loadMirror: async () => ({ create: () => ({ mirror: mirror(), serialize: () => "" }) }),
    storage: () => null,
  });
  const storage = memoryStorage();
  if (over.remember) rememberChannelFor(WS, "oort", over.remember, storage);
  const created: unknown[] = [];
  const sent: { sessionId: string; body: Record<string, unknown> }[] = [];
  const copied: string[] = [];
  const settings = vi.fn();
  const deps: PaneShareDeps = {
    workspaceId: WS,
    sessions,
    readGit: async (c) =>
      c === "g1" ? { outcome: "ok", value: { kind: "repo", name: "oort" } } : { outcome: "unknown" },
    hostStatus: async () => (over.host === undefined ? REGISTERED : over.host),
    serverOrigin: () => "https://team.example",
    createSession: vi.fn(async (input) => {
      created.push(input);
      return { id: SESSION, channelId: input.channelId };
    }),
    endSession: vi.fn(async () => undefined),
    sendShare: vi.fn(async (sessionId, body) => void sent.push({ sessionId, body })),
    storage,
    setInterval: () => () => undefined,
  };
  const share = createPaneShare(deps);
  const source: PaneShareSource = {
    share,
    channels: CHANNELS,
    openHostSettings: settings,
    copyText: async (text) => {
      copied.push(text);
      return true;
    },
  };
  return { sessions, source, deps, created, sent, copied, settings };
}

const reactAct = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root | null = null;
let unmountSlot: (() => void) | null = null;
let host: HTMLElement | null = null;

const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const text = () => document.body.textContent ?? "";

async function mount(r: ReturnType<typeof rig>) {
  unmountSlot = mountSidebarBodySlotForTest();
  host = document.createElement("main");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      createElement(LocalTerminalDock, { sessions: r.sessions, platform: "mac", presentation: "tab", share: r.source })
    );
  });
  await vi.waitFor(() => expect(q("workbench-pane-share-menu")).not.toBeNull());
}

async function openPaneMenu() {
  const trigger = q("workbench-pane-share-menu")!;
  await act(async () => {
    trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
    trigger.click();
  });
  await vi.waitFor(() => expect(q("workbench-pane-share-items")).not.toBeNull());
}
async function pick(testId: string) {
  await act(async () => q(testId)!.click());
}
async function settle() {
  await act(async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve();
  });
}

beforeAll(() => {
  reactAct.IS_REACT_ACT_ENVIRONMENT = true;
  HTMLElement.prototype.scrollIntoView = () => undefined;
  HTMLElement.prototype.hasPointerCapture = () => false;
  HTMLElement.prototype.setPointerCapture = () => undefined;
  HTMLElement.prototype.releasePointerCapture = () => undefined;
  if (typeof globalThis.PointerEvent === "undefined") {
    globalThis.PointerEvent = class PointerEvent extends MouseEvent {} as unknown as typeof PointerEvent;
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
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  unmountSlot?.();
  unmountSlot = null;
  host?.remove();
  document.body.innerHTML = "";
});

describe("「채널에 공유」 (#2867)", () => {
  it("기본은 꺼짐이다: 표지가 없고, 메뉴는 열어도 서버를 부르지 않는다", async () => {
    const r = rig();
    await mount(r);
    await openPaneMenu();
    expect(q("pane-share-menu-share")?.textContent).toBe("채널에 공유");
    expect(q("pane-share-menu-copy")?.textContent).toBe("링크 복사");
    expect(q("pane-share-menu-unshare")).toBeNull();
    expect(q("workbench-pane-share-chip")).toBeNull();
    expect(r.deps.createSession).not.toHaveBeenCalled();
    expect(r.deps.sendShare).not.toHaveBeenCalled();
  });

  it("채널에 공유: 저장소의 마지막 채널이 골라져 있고, 누르면 공유가 켜지고 표지가 머리에 선다", async () => {
    const r = rig({ remember: CH_LAB });
    await mount(r);
    await openPaneMenu();
    await pick("pane-share-menu-share");
    await vi.waitFor(() => expect(q("share-dialog")).not.toBeNull());
    await vi.waitFor(() => expect(q("share-dialog-channels")).not.toBeNull());
    const radio = document.querySelector<HTMLInputElement>('input[name="share-channel"]:checked');
    expect(radio?.value).toBe(CH_LAB);
    expect(text()).toContain("이 저장소로 마지막에 공유한 채널");
    expect(text()).toContain("팀은 이름·상태·worktree만 봐요");
    // 고른 채널로 한 번에: 서버가 카드를 올리고, 표지가 선다.
    await act(async () => q("share-dialog-submit")!.click());
    await settle();
    expect(r.created).toMatchObject([{ channelId: CH_LAB, hostId: HOST, tool: "shell" }]);
    expect(q("workbench-pane-share-chip")?.textContent).toContain("공유 중 · #agent-lab");
    expect(q("share-dialog")).toBeNull();
    await openPaneMenu();
    expect(q("pane-share-menu-share")).toBeNull();
    expect(q("pane-share-menu-copy")).not.toBeNull();
    expect(q("pane-share-menu-unshare")?.textContent).toBe("공유 끄기");
  });

  it("세션 이름은 주인이 정한다: 기본 이름이 채워져 있고, 고친 이름만 서버로 간다", async () => {
    const r = rig({ remember: CH_WORKBENCH });
    await mount(r);
    await openPaneMenu();
    await pick("pane-share-menu-share");
    await vi.waitFor(() => expect(q("share-dialog-name")).not.toBeNull());
    const input = q("share-dialog-name") as HTMLInputElement;
    expect(input.value).toBe("셸");
    expect(text()).toContain("기본 이름은 작업 제목에서 가져왔으니");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "한글 입력 수리");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => q("share-dialog-submit")!.click());
    await settle();
    expect(r.created).toMatchObject([{ label: "한글 입력 수리" }]);
  });

  it("이름을 비우면 이유를 말하고 공유할 수 없다", async () => {
    const r = rig({ remember: CH_WORKBENCH });
    await mount(r);
    await openPaneMenu();
    await pick("pane-share-menu-share");
    await vi.waitFor(() => expect(q("share-dialog-name")).not.toBeNull());
    const input = q("share-dialog-name") as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "  ");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(q("share-dialog-name-empty")?.textContent).toBe("이름을 입력해 주세요.");
    expect((q("share-dialog-submit") as HTMLButtonElement).disabled).toBe(true);
    expect(r.deps.createSession).not.toHaveBeenCalled();
  });

  it("칸을 확인하지 못하면(prepare 실패) 플랫폼 탓을 하지 않고 다시 확인할 수 있다", async () => {
    const r = rig({ remember: CH_WORKBENCH });
    const real = r.source.share.prepare.bind(r.source.share);
    let calls = 0;
    r.source.share.prepare = vi.fn(async (paneId: string) => {
      if (calls++ === 0) throw new Error("shell busy");
      return real(paneId);
    });
    await mount(r);
    await openPaneMenu();
    await pick("pane-share-menu-share");
    await vi.waitFor(() => expect(q("share-dialog-prepare-error")).not.toBeNull());
    expect(text()).not.toContain("데스크탑 앱에서만");
    await act(async () => q("share-dialog-retry")!.click());
    await vi.waitFor(() => expect(q("share-dialog-channels")).not.toBeNull());
    expect(q("share-dialog-prepare-error")).toBeNull();
  });

  it("처음이면 채널이 골라져 있지 않고, 고르기 전에는 공유할 수 없다. 워크스페이스 전체 공개 칸이 없다", async () => {
    const r = rig();
    await mount(r);
    await openPaneMenu();
    await pick("pane-share-menu-share");
    await vi.waitFor(() => expect(q("share-dialog-channels")).not.toBeNull());
    expect(document.querySelector('input[name="share-channel"]:checked')).toBeNull();
    expect((q("share-dialog-submit") as HTMLButtonElement).disabled).toBe(true);
    expect(text()).not.toMatch(/워크스페이스 전체(에|로)? ?(공유|공개)(합니다|해요|할)/);
    expect(document.querySelectorAll('input[name="share-channel"]').length).toBe(CHANNELS.length);
  });

  it("링크 복사: 꺼져 있으면 공유 확인을 먼저 묻고, 취소하면 링크도 세션도 없다", async () => {
    const r = rig();
    await mount(r);
    await openPaneMenu();
    await pick("pane-share-menu-copy");
    await vi.waitFor(() => expect(q("share-dialog")).not.toBeNull());
    expect(q("share-dialog")?.getAttribute("data-intent")).toBe("copy");
    expect(text()).toContain("이 세션을 공유할까요?");
    expect(text()).toContain("팀은 이름·상태·worktree만 봐요");
    const cancel = [...document.querySelectorAll("button")].find((b) => b.textContent === "취소")!;
    await act(async () => cancel.click());
    await settle();
    expect(r.copied).toEqual([]);
    expect(r.deps.createSession).not.toHaveBeenCalled();
    expect(q("workbench-pane-share-chip")).toBeNull();
  });

  it("링크 복사: 확인하면 공유를 켜고 그 세션의 팀 보드 주소를 복사한다", async () => {
    const r = rig({ remember: CH_WORKBENCH });
    await mount(r);
    await openPaneMenu();
    await pick("pane-share-menu-copy");
    await vi.waitFor(() => expect(q("share-dialog-channels")).not.toBeNull());
    expect(q("share-dialog-submit")?.textContent).toBe("공유하고 링크 복사");
    await act(async () => q("share-dialog-submit")!.click());
    await settle();
    expect(r.copied).toEqual([`https://team.example/work?view=team&card=${SESSION}`]);
    expect(text()).toContain("팀 작업 보드 링크를 복사했어요");
    expect(text()).not.toContain("oort://");
  });

  it("공유 중에는 링크 복사가 곧장 복사한다(다시 묻지 않는다)", async () => {
    const r = rig({ remember: CH_WORKBENCH });
    await mount(r);
    await openPaneMenu();
    await pick("pane-share-menu-share");
    await vi.waitFor(() => expect(q("share-dialog-submit")).not.toBeNull());
    await act(async () => q("share-dialog-submit")!.click());
    await settle();
    await openPaneMenu();
    await pick("pane-share-menu-copy");
    await settle();
    expect(q("share-dialog")).toBeNull();
    expect(r.copied).toHaveLength(1);
  });

  it("공유 끄기는 서버에 {shared:false}를 보내고 표지가 사라진다", async () => {
    const r = rig({ remember: CH_WORKBENCH });
    await mount(r);
    await openPaneMenu();
    await pick("pane-share-menu-share");
    await vi.waitFor(() => expect(q("share-dialog-submit")).not.toBeNull());
    await act(async () => q("share-dialog-submit")!.click());
    await settle();
    expect(q("workbench-pane-share-chip")).not.toBeNull();
    await openPaneMenu();
    await pick("pane-share-menu-unshare");
    await settle();
    expect(r.sent.at(-1)).toEqual({ sessionId: SESSION, body: { shared: false } });
    expect(q("workbench-pane-share-chip")).toBeNull();
    expect(text()).toContain("공유를 껐어요");
  });

  it("이 맥이 등록되지 않았으면 채널 선택 대신 「이 맥」 등록으로 가는 길을 보인다", async () => {
    const r = rig({ host: { ...REGISTERED, registered: null } });
    await mount(r);
    await openPaneMenu();
    await pick("pane-share-menu-share");
    await vi.waitFor(() => expect(q("share-dialog-host")).not.toBeNull());
    expect(q("share-dialog-host")?.textContent).toContain("이 맥을 작업 호스트로 먼저 등록");
    // 호스트가 막혔으면 공유를 권하는 문장(작업 카드로 올려요 · 올라가지 않아요)은 거짓이라 보이지 않는다.
    expect(text()).not.toContain("작업 카드로 올려요");
    expect(text()).not.toContain("올라가지 않아요");
    expect(q("share-dialog-channels")).toBeNull();
    expect(q("share-dialog-submit")).toBeNull();
    await act(async () => q("share-dialog-host-go")!.click());
    expect(r.settings).toHaveBeenCalledTimes(1);
    expect(r.deps.createSession).not.toHaveBeenCalled();
  });

  it("세션 목록 행의 우클릭 메뉴도 같은 항목이다", async () => {
    const r = rig({ remember: CH_WORKBENCH });
    await mount(r);
    const row = await vi.waitFor(() => {
      const found = q("session-list-row");
      expect(found).not.toBeNull();
      return found!;
    });
    await act(async () => {
      row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
    });
    await vi.waitFor(() => expect(q("session-list-row-menu")).not.toBeNull());
    expect(q("session-row-menu-share")?.textContent).toBe("채널에 공유");
    expect(q("session-row-menu-copy")?.textContent).toBe("링크 복사");
    await act(async () => q("session-row-menu-share")!.click());
    await vi.waitFor(() => expect(q("share-dialog")).not.toBeNull());
  });
});

// @vitest-environment jsdom

import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkbenchPaneInfo } from "../WorkbenchGrid";
import { createLocalSessions, type LocalSessions, type MirrorTerminal } from "../local/localSessions";
import { resetDockStateForTest } from "../local/dockState";
import { createAgentPaneStore } from "./agentPanes";
import { AGENT_LANE_LABEL, LOCAL_LANE_LABEL, type AgentPaneSource, type AgentPaneSummary } from "./agentPaneSource";

// 격자 안의 A 칸(#2779): 도크가 묶음을 읽어 A 칸은 진행 뷰로, 나머지는 로컬
// 터미널로 그린다. 레인 표지는 글과 아이콘이다. A 칸을 닫으면 창만 닫힌다.

vi.mock("../local/LocalTerminalPane", () => ({
  localPaneTitle: () => "로컬 · 셸",
  runningPaneNotice: () => null,
  HARNESS_LABEL: {},
  LocalTerminalPane: ({ pane, sessions }: { pane: WorkbenchPaneInfo; sessions: LocalSessions }) => {
    useEffect(() => {
      void sessions.ensure(pane.id, 80, 24);
    }, [pane.id, sessions]);
    return createElement("div", { className: "xterm", "data-testid": `local-${pane.id}` });
  },
}));
vi.mock("@/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri")>()),
  detectLocalHarnesses: async () => [],
  readWorkbenchGit: async () => ({ outcome: "unknown" }),
}));

const { LocalTerminalDock } = await import("../local/LocalTerminalDock");

const SID = "019f9a34-5405-7fda-9fb2-c6806f69d8a6";

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

function fakeSource(summary: AgentPaneSummary) {
  const mem = new Map<string, string>();
  const store = createAgentPaneStore(() => ({
    getItem: (k) => mem.get(k) ?? null,
    setItem: (k, v) => void mem.set(k, v),
  }));
  store.bind("p2", SID);
  const source = (): AgentPaneSource => ({
    store,
    bindings: store.get(),
    candidates: [],
    summary: (id) => (id === SID ? summary : null),
    render: (id, paneId) => createElement("div", { "data-testid": `agent-${paneId}` }, id),
  });
  return { store, source };
}

const reactAct = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root | null = null;
let host: HTMLElement | null = null;

beforeAll(() => {
  reactAct.IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  window.localStorage.clear();
  resetDockStateForTest();
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
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

async function mount(sessions: LocalSessions, source: () => AgentPaneSource) {
  host = document.createElement("main");
  document.body.append(host);
  root = createRoot(host);
  const Harness = () => createElement(LocalTerminalDock, { sessions, platform: "mac", presentation: "tab", agent: source() });
  await act(async () => {
    root?.render(createElement(Harness));
  });
  return () =>
    act(() => {
      root?.render(createElement(Harness));
    });
}

const pane = (id: string) => document.querySelector<HTMLElement>(`[data-pane-id="${id}"]`)!;

describe("A panes in the grid (#2779)", () => {
  it("draws the bound pane as the agent view, labels both lanes, and spawns no PTY for it", async () => {
    const { sessions } = fakeSessions();
    const { source } = fakeSource({ title: "온보딩 문구 다듬기", harness: "claude", status: "running", waitingLine: null });
    await mount(sessions, source);
    expect(pane("p2").querySelector('[data-testid="agent-p2"]')).not.toBeNull();
    expect(pane("p2").querySelector('[data-testid="local-p2"]')).toBeNull();
    expect(pane("p1").querySelector('[data-testid="local-p1"]')).not.toBeNull();
    expect(pane("p2").getAttribute("aria-label")).toContain(AGENT_LANE_LABEL);
    expect(pane("p2").getAttribute("aria-label")).toContain("온보딩 문구 다듬기");
    expect(pane("p1").getAttribute("aria-label")).toContain(LOCAL_LANE_LABEL);
    expect(pane("p2").querySelector('[data-testid="workbench-pane-lane"]')?.getAttribute("data-lane")).toBe("agent");
    expect(pane("p1").querySelector('[data-testid="workbench-pane-lane"]')?.getAttribute("data-lane")).toBe("local");
    expect(sessions.has("p2")).toBe(false);
    // #3279: 머리 안내 문구는 없다(목록 바닥과 레인 표지가 말한다).
    expect(document.querySelector('[data-testid="my-work-note"]')).toBeNull();
  });

  it("closing an A pane closes the window only: no confirm, no kill, binding removed", async () => {
    const { sessions, kills } = fakeSessions();
    const { store, source } = fakeSource({ title: "문구", harness: "claude", status: "running", waitingLine: null });
    const rerender = await mount(sessions, source);
    act(() => {
      pane("p2").querySelector<HTMLElement>('button[aria-label="칸 닫기"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    rerender();
    expect(document.querySelector('[data-testid="local-terminal-close-confirm"]')).toBeNull();
    expect(store.get()).toEqual({});
    expect(document.querySelector('[data-pane-id="p2"]')).toBeNull();
    expect(kills).toEqual([]);
  });

  it("a waiting A pane gets the waiting border (the card asks, so no strip), and ⌃⇧J goes there", async () => {
    const { sessions } = fakeSessions();
    const { source } = fakeSource({ title: "문구", harness: "claude", status: "waiting", waitingLine: "파일을 고쳐도 될까요?" });
    await mount(sessions, source);
    expect(pane("p2").hasAttribute("data-waiting")).toBe(true);
    expect(pane("p2").getAttribute("aria-label")).toContain("응답 필요");
    // 칸 안 권한 카드가 같은 질문을 하므로 바닥 띠는 그리지 않는다(design-review R1 M1).
    expect(pane("p2").querySelector("[data-testid='workbench-pane-waiting']")).toBeNull();
    act(() => {
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, cancelable: true, code: "KeyJ", key: "J", ctrlKey: true, shiftKey: true })
      );
    });
    await vi.waitFor(() => expect(pane("p2").hasAttribute("data-focused")).toBe(true));
  });
});

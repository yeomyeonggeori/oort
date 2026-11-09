// @vitest-environment jsdom

import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkbenchPaneInfo } from "../WorkbenchGrid";
import { createLocalSessions, type LocalSessions, type MirrorTerminal } from "../local/localSessions";
import { resetDockStateForTest } from "../local/dockState";
import { createAgentPaneStore } from "./agentPanes";
import type { AgentPaneSource, AgentPaneSummary } from "./agentPaneSource";

// #5595: 작업 권한 요청 배너를 누르면 그 세션의 A 칸이 열린다(승인 카드는 거기에만 있다). 격자는 셸이 넘긴
// `openAgentSession`을 받아, 이미 묶인 칸이면 그 칸을 활성으로, 아니면 새 세션 메뉴와 같은 자리 규칙으로 연다.
// 한 번 열고 `onAgentSessionOpened`를 부른다(셸이 주소의 열쇠를 지운다).

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

const OTHER_SID = "019f9a34-5405-7fda-9fb2-c6806f69d8b7";
const SUMMARY: AgentPaneSummary = { title: "UI 검수", harness: "claude", status: "waiting", waitingLine: null };

async function mount(
  sessions: LocalSessions,
  source: () => AgentPaneSource,
  openAgentSession: string | null,
  onAgentSessionOpened: () => void
) {
  host = document.createElement("main");
  document.body.append(host);
  root = createRoot(host);
  const Harness = ({ open }: { open: string | null }) =>
    createElement(LocalTerminalDock, {
      sessions,
      platform: "mac",
      presentation: "tab",
      agent: source(),
      openAgentSession: open,
      onAgentSessionOpened,
    });
  await act(async () => {
    root?.render(createElement(Harness, { open: openAgentSession }));
  });
  return (open: string | null) =>
    act(() => {
      root?.render(createElement(Harness, { open }));
    });
}

const pane = (id: string) => document.querySelector<HTMLElement>(`[data-pane-id="${id}"]`)!;

describe("알림이 연 A 세션 (#5595)", () => {
  it("이미 칸에 묶인 세션이면 그 칸이 활성이 되고, 새 칸을 만들지 않는다", async () => {
    const { sessions } = fakeSessions();
    const { store, source } = fakeSource(SUMMARY);
    const opened = vi.fn();
    await mount(sessions, source, SID.toUpperCase(), opened);
    await vi.waitFor(() => expect(pane("p2").hasAttribute("data-focused")).toBe(true));
    expect(pane("p1").hasAttribute("data-focused")).toBe(false);
    expect(document.querySelectorAll("[data-pane-id]")).toHaveLength(2);
    expect(Object.values(store.get())).toEqual([SID]);
    expect(opened).toHaveBeenCalledTimes(1);
  });

  it("칸에 없는 세션이면 칸을 하나 열어 그 세션을 묶고 그 칸을 그린다", async () => {
    const { sessions } = fakeSessions();
    const { store, source } = fakeSource(SUMMARY);
    const opened = vi.fn();
    const rerender = await mount(sessions, source, OTHER_SID, opened);
    await vi.waitFor(() => expect(Object.values(store.get())).toContain(OTHER_SID));
    const [newPane] = Object.entries(store.get()).find(([, sid]) => sid === OTHER_SID)!;
    expect(newPane).not.toBe("p1");
    expect(newPane).not.toBe("p2");
    expect(opened).toHaveBeenCalledTimes(1);
    // 셸이 주소의 열쇠를 지우며 다시 그린다(제품의 원천은 묶음 저장소를 구독해 스스로 다시 그린다).
    rerender(null);
    await vi.waitFor(() => expect(pane(newPane).querySelector(`[data-testid="agent-${newPane}"]`)).not.toBeNull());
    expect(pane(newPane).hasAttribute("data-focused")).toBe(true);
  });

  it("같은 요청으로 다시 그려도 한 번만 연다. 요청이 없으면 아무것도 하지 않는다", async () => {
    const { sessions } = fakeSessions();
    const { store, source } = fakeSource(SUMMARY);
    const opened = vi.fn();
    const rerender = await mount(sessions, source, OTHER_SID, opened);
    await vi.waitFor(() => expect(opened).toHaveBeenCalledTimes(1));
    rerender(OTHER_SID);
    rerender(OTHER_SID);
    expect(opened).toHaveBeenCalledTimes(1);
    expect(Object.values(store.get()).filter((sid) => sid === OTHER_SID)).toHaveLength(1);
    rerender(null);
    expect(opened).toHaveBeenCalledTimes(1);
  });
});
